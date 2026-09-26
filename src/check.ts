// Structural checks over the token stream.
//
// Two severities, and the line between them is deliberate:
//
//   error    -- no Databricks grammar can accept this: an unclosed bracket, an
//               unterminated string, `,,`, `a + )`. These are the checks that
//               must never fire on valid SQL; the corpus evaluation holds them
//               to zero false positives.
//   warning  -- almost certainly a mistake, but Spark's keyword leniency means
//               the parser might accept it (`SELECT a, FROM t` can read as a
//               column named `from`), or it is valid SQL that silently does
//               the wrong thing (`SELECT a\n  b` aliases a as b -- the
//               classic missing comma). Heuristic, so switchable off.
//
// The checks run per fragment: the tokens between two `;` or notebook cell
// separators. Brackets never legitimately span a `;`, so resetting there
// keeps one missing `)` from turning the rest of the file red.

import { KEYWORDS } from "./keywords";
import { lex, Token } from "./lexer";

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  start: number; // offset
  end: number; // offset, exclusive
  line: number; // 1-based
  column: number; // 1-based, UTF-16 code units
  endLine: number;
  endColumn: number;
}

export interface CheckOptions {
  /** Report heuristic warnings as well as errors. Default true. */
  warnings?: boolean;
}

type Raw = Omit<Diagnostic, "line" | "column" | "endLine" | "endColumn">;

interface Ctx {
  text: string;
  /** This fragment writes a generic type, so a `>` may be closing one. */
  generics?: boolean;
  /** The file has a BEGIN block, so a `;` may sit inside a scripting CASE. */
  scripting: boolean;
  /** The lexer stopped early (unterminated token), so this fragment has no real end. */
  openEnded: boolean;
  warnings: boolean;
  out: Raw[];
}

// Operators that need something on both sides.
const BINARY_ONLY = new Set([
  "=", "==", "!=", "<>", "<=", ">=", "<=>", "/", "%", "&", "|", "^", "||", "::", "=>", "->", "|>",
]);
// Operators that may not be followed by a BINARY_ONLY one.
const PREFIX_OF_ERROR = new Set([...BINARY_ONLY, "+", "-", "~", "!"]);
// Operators that need something on their right. Not `*` (`count(*)`, `SELECT *,`),
// not `:` (`STRUCT<a: INT>`, `:param`), and `>` only in a fragment with no
// `ARRAY<` / `MAP<` / `STRUCT<`, where it could be closing a type.
const NEEDS_RIGHT = new Set([...BINARY_ONLY, "+", "-", "~", "!", "<"]);
const GENERIC_TYPES = new Set(["ARRAY", "MAP", "STRUCT"]);

// Statements whose tail is raw text rather than SQL: `SET k = v,w`,
// `ADD JAR /tmp/x.jar`, `REFRESH /path/`. Spark tokenizes the tail and then
// ignores its structure (`SET foo = (1, 3` is valid), so only the lexical
// checks -- quotes and comments -- apply.
const RAW_STATEMENTS = new Set(["SET", "RESET", "ADD", "LIST", "REFRESH", "DFS"]);

// Scripting blocks that close with END <word>; END CASE closes a CASE statement.
const SCRIPT_END_WORDS = new Set(["IF", "LOOP", "WHILE", "FOR", "REPEAT"]);

const BY_CLAUSES = new Set(["GROUP", "ORDER", "PARTITION", "CLUSTER", "SORT", "DISTRIBUTE"]);
const SOLO_CLAUSES = new Set(["FROM", "WHERE", "HAVING", "LIMIT", "QUALIFY", "UNION", "INTERSECT"]);

// Keywords that are values, so they end an operand: `NULL x` aliases NULL.
const VALUE_WORDS = new Set([
  "NULL", "TRUE", "FALSE", "CURRENT_DATE", "CURRENT_TIMESTAMP", "CURRENT_TIME", "CURRENT_USER",
]);

const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

export function check(text: string, options: CheckOptions = {}): Diagnostic[] {
  const { tokens, errors } = lex(text);
  const out: Raw[] = errors.map((e) => ({ ...e, severity: "error" as const }));
  const sig = tokens.filter((t) => t.kind !== "comment");
  const scripting = sig.some(
    (t, i) => t.kind === "word" && t.upper === "BEGIN" && !isNameContext(sig[i - 1]),
  );
  for (const e of errors) if (e.code === "unterminated-string") explainUnterminated(text, tokens, e.start, out);
  const unterminated = new Set(errors.map((e) => e.start));
  checkHintsAndStrings(tokens, unterminated, options.warnings ?? true, out);
  const base = { text, scripting, warnings: options.warnings ?? true, out };

  let start = 0;
  for (let i = 0; i <= sig.length; i++) {
    const t = sig[i];
    const atEnd = i === sig.length;
    if (!atEnd && !(t.kind === "separator" || isPunct(t, ";"))) continue;
    checkFragment(sig.slice(start, i), { ...base, openEnded: atEnd && errors.length > 0 });
    start = i + 1;
  }
  return finalize(text, out);
}

function checkFragment(all: Token[], ctx: Ctx): void {
  const toks = dropMagicLine(all, ctx.text);
  if (toks.length === 0) return;
  const lead = toks[0];
  const raw =
    lead.kind === "word" && RAW_STATEMENTS.has(lead.upper!) &&
    !(lead.upper === "SET" && toks[1]?.kind === "word" && (toks[1].upper === "VAR" || toks[1].upper === "VARIABLE"));
  if (raw) return;
  const reportedBefore = ctx.out.length;
  ctx = {
    ...ctx,
    generics: toks.some((t, i) => t.kind === "op" && t.text === "<" && toks[i - 1]?.kind === "word" && GENERIC_TYPES.has(toks[i - 1].upper!)),
  };

  const depth: number[] = new Array(toks.length);
  const stack: number[] = []; // indices of open brackets
  // MATCH_RECOGNIZE's PATTERN (A B+ C*) is a regex: its operators are quantifiers.
  let regexFrom = -1; // stack height at which a PATTERN group opened
  const cases: number[][] = [[]]; // cases[d]: open CASE tokens at bracket depth d

  const closeTo = (k: number, closer: Token): void => {
    // Pop brackets down to and including stack[k]; the ones above k were never closed.
    while (stack.length - 1 > k) {
      const o = toks[stack.pop()!];
      report(ctx, "unclosed-bracket", "error", o, `\`${o.text}\` is never closed (the \`${closer.text}\` at ${where(ctx.text, closer.start)} closes an earlier bracket)`);
    }
    for (const c of cases[stack.length] ?? []) {
      report(ctx, "case-without-end", "error", toks[c], "CASE has no END before its enclosing bracket closes");
    }
    stack.pop();
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const p: Token | undefined = toks[i - 1];
    const n: Token | undefined = toks[i + 1];
    depth[i] = stack.length;

    if (t.kind === "punct") {
      const ch = t.text;
      if (ch === "(" || ch === "[" || ch === "{") {
        if (regexFrom < 0 && p?.kind === "word" && p.upper === "PATTERN") regexFrom = stack.length;
        stack.push(i);
        cases[stack.length] = [];
      } else if (ch === ")" || ch === "]" || ch === "}") {
        const want = OPENERS[ch];
        let k = stack.length - 1;
        while (k >= 0 && toks[stack[k]].text !== want) k--;
        if (k >= 0) {
          closeTo(k, t);
        } else if (stack.length === 0) {
          report(ctx, "unmatched-bracket", "error", t, `Unmatched \`${ch}\`: there is no \`${want}\` for it to close`);
        } else {
          const top = toks[stack[stack.length - 1]];
          report(ctx, "mismatched-bracket", "error", t, `\`${ch}\` does not match the \`${top.text}\` opened at ${where(ctx.text, top.start)}`);
        }
        depth[i] = stack.length;
        if (stack.length <= regexFrom) regexFrom = -1;
      } else if (ch === ",") {
        checkComma(toks, i, ctx);
      }
      continue;
    }

    if (t.kind === "op" && regexFrom < 0) {
      checkOperator(t, p, n, ctx);
      continue;
    }

    if (t.kind === "word" && !isNameContext(p)) {
      if (t.upper === "CASE" && !(p?.kind === "word" && p.upper === "END")) {
        cases[stack.length].push(i);
      } else if (t.upper === "END") {
        const next = n?.kind === "word" ? n.upper! : "";
        if (!SCRIPT_END_WORDS.has(next)) cases[stack.length].pop();
      }
    }
  }

  if (!ctx.openEnded) {
    for (const k of stack) {
      const o = toks[k];
      report(ctx, "unclosed-bracket", "error", o, `\`${o.text}\` is never closed`);
    }
    if (stack.length === 0 && !ctx.scripting) {
      for (const c of cases[0]) {
        report(ctx, "case-without-end", "error", toks[c], "CASE has no END before the statement ends");
      }
    }
  }

  // Heuristics only run on fragments that are otherwise clean: after a real
  // error the bracket depths they rely on cannot be trusted.
  if (ctx.warnings && ctx.out.length === reportedBefore) {
    checkLists(toks, depth, ctx);
  }
}

function checkComma(toks: Token[], i: number, ctx: Ctx): void {
  const t = toks[i];
  const p: Token | undefined = toks[i - 1];
  const n: Token | undefined = toks[i + 1];
  const afterComma = p !== undefined && isPunct(p, ",");

  if (!(p && isWild(p))) {
    if (!p || isPunct(p, "(") || isPunct(p, "[")) {
      report(ctx, "leading-comma", "error", t, "Comma with nothing before it");
    } else if (afterComma) {
      report(ctx, "double-comma", "error", t, "Two commas in a row");
    }
  }
  if (afterComma || (n && isWild(n))) return;
  if (!n) {
    if (!ctx.openEnded) report(ctx, "trailing-comma", "error", t, "Trailing comma: nothing follows it before the statement ends");
  } else if (isPunct(n, ")") || isPunct(n, "]")) {
    report(ctx, "trailing-comma", "error", t, `Trailing comma before \`${n.text}\``);
  } else if (ctx.warnings) {
    const clause = clauseAfterComma(toks, i);
    if (clause) report(ctx, "comma-before-clause", "warning", t, `Trailing comma before ${clause}`);
  }
}

function clauseAfterComma(toks: Token[], i: number): string | null {
  const n = toks[i + 1];
  const nn: Token | undefined = toks[i + 2];
  if (n.kind !== "word") return null;
  const u = n.upper!;
  if (BY_CLAUSES.has(u)) {
    return nn?.kind === "word" && nn.upper === "BY" ? `${u} BY` : null;
  }
  if (!SOLO_CLAUSES.has(u) || !nn) return null;
  // `, from,` / `, from AS x` / `, from.col` read as a column named `from`.
  if (nn.kind === "punct" && nn.text !== "(") return null;
  if (nn.kind === "op" || isWild(nn)) return null;
  if (nn.kind === "word" && (nn.upper === "AS" || SOLO_CLAUSES.has(nn.upper!) || BY_CLAUSES.has(nn.upper!))) return null;
  return u;
}

function checkOperator(t: Token, p: Token | undefined, n: Token | undefined, ctx: Ctx): void {
  const op = t.text;
  if (BINARY_ONLY.has(op) && !(p && isWild(p))) {
    if (!p || isPunct(p, "(") || isPunct(p, "[") || isPunct(p, ",")) {
      report(ctx, "missing-operand", "error", t, `\`${op}\` has nothing on its left`);
    } else if (p.kind === "op" && PREFIX_OF_ERROR.has(p.text)) {
      report(ctx, "missing-operand", "error", t, `\`${op}\` directly follows \`${p.text}\`: an operand is missing between them`);
    }
  }
  if ((NEEDS_RIGHT.has(op) || (op === ">" && !ctx.generics)) && !(n && isWild(n))) {
    if (!n) {
      if (!ctx.openEnded) report(ctx, "missing-operand", "error", t, `\`${op}\` has nothing on its right before the statement ends`);
    } else if (isPunct(n, ")") || isPunct(n, "]") || isPunct(n, ",")) {
      report(ctx, "missing-operand", "error", t, `\`${op}\` has nothing on its right`);
    }
  }
}

// --- comma lists ---------------------------------------------------------------
//
// A missing comma usually leaves the SQL parseable-looking: two operands side
// by side. Whether that is an error depends on the list. In a select list the
// first pair is an implicit alias (`count(*) total`) and only a second one is
// wrong; in a GROUP BY / ORDER BY / PARTITION BY list, or in a function's
// arguments, there are no aliases, so the first pair is already a lost comma.

type ElKind =
  | "word" | "qident" | "number" | "string" | "value" // operands
  | "kw" | "as" | "case" | "end"
  | "join" // . : ::  -- continue the operand they follow
  | "op" | "group" | "wild";

interface El {
  kind: ElKind;
  tok: Token;
  end: number; // for a group, the end of its closing bracket
  open: number; // token index (for a group, of its opener)
  close: number; // token index (for a group, of its closer)
}

type Mode = "select" | "list";

interface Walk {
  toks: Token[];
  depth: number[];
  ctx: Ctx;
}

const BY_LISTS = new Set(["GROUP", "ORDER", "PARTITION", "SORT", "DISTRIBUTE", "CLUSTER", "ZORDER"]);

// Keywords that can sit inside a BY-list item. Any other keyword (not written
// as a call, `LEFT(`) ends the list: stopping early costs recall, never
// precision, and it keeps the walk out of whatever clause comes next.
const BY_ITEM_KEYWORDS = new Set([
  "ASC", "DESC", "NULLS", "FIRST", "LAST", "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT",
  "IS", "NULL", "TRUE", "FALSE", "IN", "BETWEEN", "LIKE", "ILIKE", "RLIKE", "REGEXP", "ESCAPE", "DIV",
  "INTERVAL", "YEAR", "YEARS", "MONTH", "MONTHS", "WEEK", "WEEKS", "DAY", "DAYS", "HOUR", "HOURS",
  "MINUTE", "MINUTES", "SECOND", "SECONDS", "COLLATE", "ROLLUP", "CUBE", "GROUPING", "SETS", "ALL",
  "DISTINCT", "DATE", "TIMESTAMP", "TIMESTAMP_NTZ", "TIMESTAMP_LTZ", "CURRENT_DATE",
  "CURRENT_TIMESTAMP", "CURRENT_USER", "EXISTS", "ANY", "SOME",
]);

const ITEM_END_KEYWORDS = new Set(["ASC", "DESC", "FIRST", "LAST"]);

function checkLists(toks: Token[], depth: number[], ctx: Ctx): void {
  const lead = toks[0];
  if (lead.kind === "word" && (lead.upper === "GRANT" || lead.upper === "REVOKE" || lead.upper === "DENY")) return;
  const w: Walk = { toks, depth, ctx };
  for (let s = 0; s < toks.length; s++) {
    const t = toks[s];
    if (t.kind !== "word" || isNameContext(toks[s - 1])) continue;
    if (t.upper === "SELECT") {
      let j = s + 1;
      const first = toks[j];
      if (first?.kind === "word" && (first.upper === "DISTINCT" || first.upper === "ALL")) j++;
      for (const item of listItems(w, j, depth[s], endsSelectList)) checkItem(item, "select", w);
    } else if (t.upper === "BY" && toks[s - 1]?.kind === "word" && BY_LISTS.has(toks[s - 1].upper!)) {
      for (const item of listItems(w, s + 1, depth[s], endsByList)) checkItem(item, "list", w);
    }
  }
}

/** Split the tokens from `from` at bracket depth d into comma-separated items. */
function listItems(w: Walk, from: number, d: number, ends: (toks: Token[], j: number) => boolean): El[][] {
  const { toks, depth } = w;
  const items: El[][] = [];
  let item: El[] = [];
  for (let j = from; j < toks.length; j++) {
    if (depth[j] < d) break;
    if (depth[j] > d) continue;
    const t = toks[j];
    if (isPunct(t, ",")) {
      items.push(item);
      item = [];
      continue;
    }
    if (ends(toks, j)) break;
    if (t.kind === "punct" && (t.text === "(" || t.text === "[")) {
      // The group's contents sit deeper and are skipped; its closer is next at depth d.
      const open = j;
      while (j + 1 < toks.length && depth[j + 1] > d) j++;
      j++;
      item.push({ kind: "group", tok: t, end: toks[j]?.end ?? t.end, open, close: j });
      continue;
    }
    item.push({ kind: classify(toks, j), tok: t, end: t.end, open: j, close: j });
  }
  items.push(item);
  return items;
}

function classify(toks: Token[], j: number): ElKind {
  const t = toks[j];
  switch (t.kind) {
    case "word": {
      const u = t.upper!;
      if (isNameContext(toks[j - 1]) || !KEYWORDS.has(u)) return "word";
      if (u === "AS") return "as";
      if (u === "CASE") return "case";
      if (u === "END") return "end";
      return VALUE_WORDS.has(u) ? "value" : "kw";
    }
    case "qident":
      return "qident";
    case "number":
      return "number";
    case "string":
    case "dollar":
      return "string";
    case "op":
      return t.text === ":" || t.text === "::" ? "join" : "op";
    case "punct":
      return t.text === "." ? "join" : "op";
    default:
      return "wild";
  }
}

function endsSelectList(toks: Token[], j: number): boolean {
  const t = toks[j];
  if (t.kind === "op") return t.text === "|>";
  if (t.kind !== "word" || isNameContext(toks[j - 1])) return false;
  const p: Token | undefined = toks[j - 1];
  const n: Token | undefined = toks[j + 1];
  switch (t.upper) {
    case "FROM":
      return !(p?.kind === "word" && p.upper === "DISTINCT"); // IS [NOT] DISTINCT FROM
    case "EXCEPT":
      return !(p?.kind === "op" && p.text === "*"); // SELECT * EXCEPT (a)
    case "GROUP": case "ORDER": case "CLUSTER": case "SORT": case "DISTRIBUTE":
      return n?.kind === "word" && n.upper === "BY"; // not WITHIN GROUP (...)
    case "LATERAL":
      return n?.kind === "word" && n.upper === "VIEW";
    case "WHERE": case "HAVING": case "LIMIT": case "OFFSET": case "WINDOW": case "QUALIFY":
    case "UNION": case "INTERSECT": case "MINUS": case "INTO": case "PIVOT": case "UNPIVOT": case "DO":
      return true;
    default:
      return false;
  }
}

function endsByList(toks: Token[], j: number): boolean {
  const t = toks[j];
  if (t.kind === "op") return t.text === "|>";
  if (t.kind !== "word" || isNameContext(toks[j - 1]) || !KEYWORDS.has(t.upper!)) return false;
  if (BY_ITEM_KEYWORDS.has(t.upper!)) return false;
  return !(toks[j + 1] && isPunct(toks[j + 1], "(")); // a keyword-named call, `LEFT(s, 2)`
}

/** Walk the arguments of the call whose `(` is the group element g. */
function checkArgs(g: El, w: Walk): void {
  if (g.tok.text !== "(") return;
  const d = w.depth[g.open] + 1;
  for (const item of listItems(w, g.open + 1, d, () => false)) checkItem(item, "list", w);
}

/**
 * Walk one list item looking for operands that sit side by side with no
 * operator between them.
 */
function checkItem(els: El[], mode: Mode, w: Walk): void {
  const { ctx } = w;
  let lastEnd = false; // the previous element ended an operand
  let afterJoin = false; // the previous element was `.`, `:` or `::`
  let aliased = false;
  let inCase = 0;
  let aliasAt = -1; // index of an implicit alias

  for (let k = 0; k < els.length; k++) {
    const e = els[k];
    if (e.kind === "wild") return;
    if (inCase > 0) {
      if (e.kind === "case") inCase++;
      else if (e.kind === "end" && --inCase === 0) lastEnd = true;
      continue;
    }
    const followsAlias = aliasAt >= 0 && k === aliasAt + 1;
    switch (e.kind) {
      case "case":
        if (aliased) return;
        inCase = 1;
        lastEnd = afterJoin = false;
        continue;
      case "as":
        if (mode === "list") {
          lastEnd = afterJoin = false; // `CAST(x AS INT)`-style: a type follows
          continue;
        }
        if (els[k + 1] && els[k + 1].kind !== "op" && els[k + 1].kind !== "wild") k++;
        aliased = true;
        aliasAt = -1;
        lastEnd = true;
        afterJoin = false;
        continue;
      case "join":
      case "group":
        if (followsAlias) {
          const alias = els[aliasAt].tok;
          const what = e.kind === "group" ? `\`${alias.text}${e.tok.text}\` reads as a call` : `\`${alias.text}${e.tok.text}\` reads as a qualified name`;
          report(ctx, "missing-comma", "warning", alias, `Missing comma before \`${alias.text}\`? ${what}, which cannot follow another expression`);
          return;
        }
        if (aliased) return;
        if (e.kind === "join") {
          afterJoin = true;
          lastEnd = false;
        } else {
          // A call's arguments are a list of their own: `coalesce(a b)`.
          if (lastEnd && k > 0 && els[k - 1].kind === "word") checkArgs(e, w);
          lastEnd = true;
          afterJoin = false;
        }
        continue;
      case "op":
      case "kw":
        if (aliased) return;
        // `ORDER BY a DESC b`: a sort direction completes the item.
        lastEnd = mode === "list" && e.kind === "kw" && ITEM_END_KEYWORDS.has(e.tok.upper!);
        afterJoin = false;
        continue;
      case "end":
        lastEnd = true;
        continue;
      default: {
        // An operand: word, qident, number, string or value.
        if (afterJoin || !lastEnd) {
          afterJoin = false;
          lastEnd = true;
          continue;
        }
        if (aliased) {
          if (e.kind === "word" || e.kind === "qident" || e.kind === "number") {
            const prev = els[k - 1].tok;
            report(ctx, "missing-comma", "warning", e.tok, `Missing comma before \`${e.tok.text}\`? It follows the alias \`${prev.text}\``);
          }
          return;
        }
        if (e.kind === "string" || e.kind === "value") continue; // 'a' 'b', X'00'
        if (e.kind === "number" || mode === "list") {
          const why = mode === "list" ? " Nothing in this list can take an alias." : "";
          report(ctx, "missing-comma", "warning", e.tok, `Missing comma before \`${e.tok.text}\`?${why}`);
          return;
        }
        aliased = true;
        aliasAt = k;
      }
    }
  }

  // Only after a bare column or literal. An alias on its own line after a long
  // aggregate or window expression is a common, deliberate style (TPC-DS is
  // written that way); after a bare column it is almost always a lost comma.
  const bare = (e: El): boolean =>
    e.kind === "word" || e.kind === "qident" || e.kind === "join" ||
    e.kind === "number" || e.kind === "string" || e.kind === "value";
  if (aliasAt >= 0 && aliasAt === els.length - 1 && els.slice(0, aliasAt).every(bare)) {
    const alias = els[aliasAt].tok;
    const prevEnd = els[aliasAt - 1].end;
    if (ctx.text.slice(prevEnd, alias.start).includes("\n")) {
      report(
        ctx, "alias-on-new-line", "warning", alias,
        `\`${alias.text}\` on its own line is read as an alias of the expression above it. Missing comma? (Write \`AS ${alias.text}\` if the alias is intended.)`,
      );
    }
  }
}

// --- helpers -------------------------------------------------------------------

const HINTED = new Set(["SELECT", "INSERT", "UPDATE", "MERGE", "DELETE"]);
const CODE_LINE_RE = /;[ \t]*\r?\n|\n[ \t]*--/;

/**
 * Two things the token-level pass cannot see:
 *
 *  - Optimizer hints. `/*+ BROADCAST(t) *\/` is a comment to the lexer but is
 *    parsed by Spark, so its brackets must balance.
 *  - A string that has swallowed code. When a closing quote is missing, the
 *    string runs on to the next quote in the file -- often an apostrophe in a
 *    later comment -- and everything between reads as one literal, so the
 *    quotes still balance. A string with a line ending in `;` or a line that
 *    starts with `--` is almost never meant.
 */
function checkHintsAndStrings(tokens: Token[], unterminated: Set<number>, warnings: boolean, out: Raw[]): void {
  let prev: Token | undefined;
  for (const t of tokens) {
    if (t.kind === "comment" && t.text.startsWith("/*+") && prev?.kind === "word" && HINTED.has(prev.upper!)) {
      checkHintBrackets(t, out);
    } else if (warnings && t.kind === "string" && !unterminated.has(t.start) && CODE_LINE_RE.test(t.text)) {
      out.push({
        code: "string-swallows-code",
        severity: "warning",
        message: "This string runs over lines that look like SQL (a line ending in `;` or starting with `--`). Is a closing quote missing?",
        start: t.start,
        end: t.start + 1,
      });
    }
    if (t.kind !== "comment") prev = t;
  }
}

function checkHintBrackets(hint: Token, out: Raw[]): void {
  const s = hint.text;
  const open: number[] = [];
  for (let i = 3; i < s.length - 2; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const j = s.indexOf(c, i + 1);
      if (j < 0) break;
      i = j;
    } else if (c === "(") {
      open.push(i);
    } else if (c === ")") {
      if (open.length === 0) {
        out.push({ code: "unmatched-bracket", severity: "error", message: "Unmatched `)` in optimizer hint", start: hint.start + i, end: hint.start + i + 1 });
      } else {
        open.pop();
      }
    }
  }
  for (const i of open) {
    out.push({ code: "unclosed-bracket", severity: "error", message: "`(` in optimizer hint is never closed", start: hint.start + i, end: hint.start + i + 1 });
  }
}

/**
 * An unterminated string is found where the quotes run out, which is often
 * far from the quote that is actually missing: `'active` pairs with the next
 * quote in the file, and every string after it is read inside out. When an
 * earlier string in the same cell spans lines, point at it too.
 */
function explainUnterminated(text: string, tokens: Token[], at: number, out: Raw[]): void {
  const quoteOf = (t: Token): string => (t.text[0] === "r" || t.text[0] === "R" ? t.text[1] : t.text[0]);
  const quote = text[at] === "r" || text[at] === "R" ? text[at + 1] : text[at];
  let culprit: Token | undefined;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k];
    if (t.start >= at) continue;
    if (t.kind === "separator") break;
    if (t.kind === "string" && quoteOf(t) === quote && t.text.includes("\n")) culprit = t;
  }
  if (!culprit) return;
  const starts = lineStarts(text);
  const [from] = lineCol(culprit.start, starts);
  const [to] = lineCol(culprit.end, starts);
  out.push({
    code: "unterminated-string",
    severity: "warning",
    message: `This string runs from line ${from} to line ${to}. If it is missing its closing quote, that explains the unterminated string further down.`,
    start: culprit.start,
    end: culprit.start + 1,
  });
}

/** After `.`, `:`, `::` or AS a word is a name, never a keyword. */
function isNameContext(p: Token | undefined): boolean {
  if (!p) return false;
  if (p.kind === "punct") return p.text === ".";
  if (p.kind === "op") return p.text === ":" || p.text === "::";
  return p.kind === "word" && p.upper === "AS";
}

function isPunct(t: Token, ch: string): boolean {
  return t.kind === "punct" && t.text === ch;
}

/** Templates and unknown characters could stand for anything: never judge next to them. */
function isWild(t: Token): boolean {
  return t.kind === "template" || t.kind === "other";
}

/** `%sql` / `%python` at the top of a notebook cell is a magic command, not SQL. */
function dropMagicLine(toks: Token[], text: string): Token[] {
  const first = toks[0];
  if (!first || first.kind !== "op" || first.text !== "%") return toks;
  const second = toks[1];
  if (!second || second.kind !== "word" || second.start !== first.end) return toks;
  let eol = text.indexOf("\n", first.start);
  if (eol < 0) eol = text.length;
  let k = 0;
  while (k < toks.length && toks[k].start < eol) k++;
  return toks.slice(k);
}

function report(ctx: Ctx, code: string, severity: Severity, t: Token, message: string): void {
  // Diagnostics are anchored on the offending token; a token swallowed to the
  // end of the input by the lexer is anchored on its first character only.
  const end = Math.min(t.end, t.start + Math.max(1, Math.min(t.text.length, 80)));
  ctx.out.push({ code, severity, message, start: t.start, end });
}

function where(text: string, offset: number): string {
  const [line, col] = lineCol(offset, lineStarts(text));
  return `line ${line}:${col}`;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineCol(offset: number, starts: number[]): [number, number] {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return [lo + 1, offset - starts[lo] + 1];
}

function finalize(text: string, raw: Raw[]): Diagnostic[] {
  if (raw.length === 0) return [];
  const starts = lineStarts(text);
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const r of raw.sort((a, b) => a.start - b.start)) {
    const key = `${r.start}:${r.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [line, column] = lineCol(r.start, starts);
    const [endLine, endColumn] = lineCol(r.end, starts);
    out.push({ ...r, line, column, endLine, endColumn });
  }
  return out;
}
