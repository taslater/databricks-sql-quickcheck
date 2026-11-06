// SQL scripting block structure (rung 5 of docs/scope.md).
//
// The per-fragment checks cannot see a block, because a block's opener and
// its closer sit in different `;`-separated fragments:
//
//   BEGIN IF 1 = 1 THEN SELECT 1;     <- fragment 1 opens BEGIN and IF
//   END                               <- fragment 2 closes ... what?
//
// This pass walks the fragments of one notebook cell in order, keeping a stack
// of the blocks it has seen open, and matches each closer against the top.
//
// The rule that keeps it safe is the same as everywhere else: unrecognised
// input must produce silence. The matcher reads a fragment only at positions
// where a statement can start (the fragment's first token, and after a `THEN`,
// `DO`, `ELSE`, `label:` or `AS`/`HANDLER` that it has itself recognised). The
// moment it meets anything it does not fully understand it gives up for the
// rest of the cell, so it never reports from a half-understood stack. What it
// reports instead, it reports as an error because the engine rejects each of
// them (docs/scripting.md lists the live-engine evidence).

import { Ctx, isPunct, report, where } from "./common";
import { Token } from "./lexer";

type Kind = "BEGIN" | "IF" | "WHILE" | "LOOP" | "FOR" | "REPEAT" | "CASE";

interface Block {
  kind: Kind;
  tok: Token;
  label?: Token;
  sawElse: boolean;
  sawUntil: boolean;
}

/** Words that, after END, name the block being closed. */
const CLOSER_WORDS = new Set<string>(["IF", "WHILE", "LOOP", "FOR", "REPEAT", "CASE"]);
/** Block openers that may carry a label: `lbl: LOOP`. */
const LABELLED = new Set<string>(["BEGIN", "LOOP", "WHILE", "REPEAT", "FOR"]);
/** `BEGIN TRANSACTION` and friends start a transaction, not a block. */
const TRANSACTION_WORDS = new Set<string>(["TRANSACTION", "WORK", "ISOLATION", "READ", "DEFERRED", "IMMEDIATE", "EXCLUSIVE"]);
/** Statements whose tail is raw text: their words are not scripting words. */
const RAW_LEADS = new Set<string>(["SET", "RESET", "ADD", "LIST", "REFRESH", "DFS"]);

/** Words no statement starts with: seeing one where a body should start means a mis-read. */
const CANNOT_START = new Set<string>(["FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "LIKE", "BETWEEN", "AS", "ON", "USING", "GROUP", "ORDER", "HAVING", "LIMIT", "JOIN", "UNION"]);

const isWord = (t: Token | undefined, ...upper: string[]): boolean =>
  t?.kind === "word" && upper.includes(t.upper!);
const isColon = (t: Token | undefined): boolean => t?.kind === "op" && t.text === ":";
const isOpen = (t: Token): boolean => isPunct(t, "(") || isPunct(t, "[") || isPunct(t, "{");
const isClose = (t: Token): boolean => isPunct(t, ")") || isPunct(t, "]") || isPunct(t, "}");

/** A name that follows `.`, `::` or AS is a name whatever it spells. */
function afterNameMarker(p: Token | undefined): boolean {
  if (!p) return false;
  if (p.kind === "punct") return p.text === ".";
  if (p.kind === "op") return p.text === "::";
  return p.kind === "word" && p.upper === "AS";
}

/** As above, and after `:` too: `j:then` is a JSON path, but `lbl: LOOP` is a label. */
function afterNameOrPath(p: Token | undefined): boolean {
  return afterNameMarker(p) || (p !== undefined && isColon(p));
}

// Words after which an operand starts, so a block word right after one is a name.
const OPERAND_START = new Set<string>([
  "IF", "ELSEIF", "WHEN", "WHILE", "FOR", "CASE", "AS", "SELECT", "FROM", "WHERE", "AND", "OR", "NOT",
  "IN", "IS", "LIKE", "BETWEEN", "SET", "UNTIL", "THEN", "ELSE", "DO", "VALUES", "ON", "BY",
]);
const UNARY = new Set(["-", "+", "~", "!"]);

/**
 * `then`, `do`, `end` can be column, field or variable names. A word in a name
 * position (after `.`, `:` or AS; first in the condition; right after an
 * operator, comma, `(` or a word that starts an operand; or followed by an
 * operator or `.`) is never the keyword.
 */
function usedAsName(toks: Token[], i: number, from: number): boolean {
  const p = toks[i - 1];
  const n = toks[i + 1];
  if (afterNameOrPath(p) || i === from) return true;
  if (n && ((n.kind === "op" && !isColon(n)) || isPunct(n, "."))) return true;
  if (p && (p.kind === "op" || isPunct(p, ",") || isPunct(p, "("))) return true;
  // A word that starts an operand does so only if it is a keyword here, not itself a name.
  return p?.kind === "word" && OPERAND_START.has(p.upper!) && !usedAsName(toks, i - 1, from);
}

interface CaseMarks {
  open: Set<number>;
  close: Set<number>;
}

/**
 * Which `CASE` and `END` tokens from `from` are one CASE *expression*. A CASE
 * counts only when an END closes it later in the fragment, so a variable named
 * `case` (`IF case = 1 THEN`, `CASE case WHEN 1`) is left out, and an END counts
 * only in a closing position, so a variable named `end` is too.
 */
function caseMarks(toks: Token[], from: number): CaseMarks {
  const open = new Set<number>();
  const close = new Set<number>();
  const stack: number[] = [];
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "word") continue;
    const p = toks[i - 1];
    const n = toks[i + 1];
    if (t.upper === "CASE") {
      const asName = afterNameOrPath(p) ||
        (n !== undefined && ((n.kind === "op" && !UNARY.has(n.text) && !isColon(n)) || isPunct(n, ".") || isPunct(n, ",") || isPunct(n, ")")));
      if (!asName) stack.push(i);
    } else if (t.upper === "END" && stack.length > 0) {
      const asName = afterNameOrPath(p) || (n !== undefined && isPunct(n, ".")) ||
        (p !== undefined && (p.kind === "op" || isPunct(p, ",") || isPunct(p, "(") || (p.kind === "word" && OPERAND_START.has(p.upper!))));
      if (!asName) {
        open.add(stack.pop()!);
        close.add(i);
      }
    }
  }
  return { open, close };
}

/**
 * The index of the first token from `from` that satisfies `stop`, looking only
 * at bracket depth 0 and outside any `CASE ... END` expression (whose `THEN`
 * and `END` are not the statement's). -1 when there is none, or when the scan
 * runs into an unbalanced bracket.
 */
function scan(toks: Token[], from: number, stop: (i: number) => boolean, emptyOk = false): number {
  const marks = caseMarks(toks, from);
  let depth = 0;
  let cases = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      if (depth === 0) return -1;
      depth--;
    } else if (t.kind === "word" && depth === 0) {
      if (marks.open.has(i)) cases++;
      else if (marks.close.has(i)) cases--;
      else if (cases === 0 && !(usedAsName(toks, i, from) && !(emptyOk && i === from)) && stop(i)) return i;
    }
  }
  return -1;
}

/** Brackets and CASE...END all balance from `from` to the fragment's end. */
function wellFormed(toks: Token[], from: number): boolean {
  const marks = caseMarks(toks, from);
  let depth = 0;
  let cases = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      if (depth === 0) return false;
      depth--;
    } else if (t.kind === "word" && depth === 0) {
      if (marks.open.has(i)) cases++;
      else if (marks.close.has(i)) cases--;
      else if (t.upper === "END" && !usedAsName(toks, i, from) && cases === 0) return false;
    }
  }
  return depth === 0 && cases === 0;
}

/** A label compares case-insensitively, backticks or not. */
const labelKey = (t: Token): string => (t.kind === "qident" ? t.text.slice(1, -1) : t.text).toLowerCase();

class Cell {
  private readonly stack: Block[] = [];
  private gaveUp = false;
  /** The block opened most recently, while nothing has been read inside it. */
  private justOpened: Block | undefined;

  constructor(private readonly frags: Token[][], private readonly ctx: Ctx) {}

  run(): void {
    for (const frag of this.frags) {
      if (this.gaveUp) return;
      if (frag.length > 0) this.fragment(frag);
    }
    if (this.gaveUp) return;
    for (const b of this.stack) {
      report(this.ctx, "unclosed-block", "error", b.tok,
        `${this.describe(b)} is never closed: it needs ${this.closerOf(b)}.`);
    }
  }

  /** Report an error at `tok` and stop: the stack no longer matches the script. */
  private fail(code: string, tok: Token, message: string): void {
    report(this.ctx, code, "error", tok, message);
    this.gaveUp = true;
  }

  // --- reading one fragment ---------------------------------------------------

  private fragment(toks: Token[]): void {
    this.justOpened = undefined;
    const lead = toks[0].kind === "word" ? toks[0].upper! : "";
    // CREATE PROCEDURE ... AS BEGIN ...: the body opens inside the statement.
    // Only for a PROCEDURE: in `CREATE VIEW v AS SELECT 1 AS begin` the word
    // after AS is a name, and it must stay one.
    if (lead === "CREATE" && toks.slice(0, 6).some((t) => isWord(t, "PROCEDURE"))) {
      // The body is the first depth-0 BEGIN; after AS it is not a name here.
      let depth = 0;
      for (let b = 1; b < toks.length; b++) {
        if (isOpen(toks[b])) depth++;
        else if (isClose(toks[b])) depth = Math.max(0, depth - 1);
        else if (depth === 0 && isWord(toks[b], "BEGIN") && !isPunct(toks[b - 1], ".")) return this.head(toks, b);
      }
      return;
    }
    this.head(toks, 0);
  }

  /** `DECLARE EXIT HANDLER FOR cond action`: find the action's block, if it is one. */
  private handler(toks: Token[], at: number): void {
    let depth = 0;
    for (let i = at + 4; i < toks.length; i++) {
      const t = toks[i];
      if (isOpen(t)) depth++;
      else if (isClose(t)) depth = Math.max(0, depth - 1);
      else if (t.kind === "word" && depth === 0) {
        const p = toks[i - 1];
        if (!isWord(t, "BEGIN", "IF", "WHILE", "LOOP", "REPEAT", "FOR", "CASE")) continue;
        const nx = toks[i + 1];
        if (afterNameMarker(p) || isWord(p, "FOR") || (p && isPunct(p, ",")) || (nx && (nx.kind === "op" || isPunct(nx, ".")))) continue;
        if (isWord(t, "BEGIN")) {
          if (p && isColon(p)) {
            // `h: BEGIN` is a label; `j:begin` is a JSON path. Only the spacing tells them apart.
            const colon = p;
            if (colon.end === t.start || !(toks[i - 2]?.kind === "word" || toks[i - 2]?.kind === "qident")) return void (this.gaveUp = true);
            return this.head(toks, i - 2);
          }
          return this.head(toks, i);
        }
        return void (this.gaveUp = true); // some other block as the handler's action
      }
    }
  }

  /** Read blocks from a position where a statement can start. */
  private head(toks: Token[], from: number): void {
    let i = from;
    while (i < toks.length && !this.gaveUp) {
      let tok = toks[i];
      let label: Token | undefined;
      if ((tok.kind === "word" || tok.kind === "qident") && isColon(toks[i + 1]) && isWord(toks[i + 2], ...LABELLED)) {
        label = tok;
        i += 2;
        tok = toks[i];
      }
      if (tok.kind === "op" && i > from) return void (this.gaveUp = true); // no statement starts with an operator
      if (tok.kind !== "word") return this.plain(toks, i);
      if (i > from && CANNOT_START.has(tok.upper!)) return void (this.gaveUp = true); // we mis-read where a body starts
      const next = toks[i + 1];
      const top = this.stack[this.stack.length - 1];
      switch (tok.upper) {
        case "BEGIN": {
          if (!next) return void (this.gaveUp = true); // a bare `BEGIN;` could be a transaction
          if (isWord(next, ...TRANSACTION_WORDS) && !isColon(toks[i + 2])) return;
          this.open("BEGIN", tok, label);
          i += isWord(next, "ATOMIC") && !isColon(toks[i + 2]) ? 2 : 1;
          continue;
        }
        case "IF": {
          const t = scan(toks, i + 1, (k) => isWord(toks[k], "THEN"));
          if (t < 0) return this.noKeyword(toks, i, "IF", "THEN", "its condition");
          this.open("IF", tok);
          i = t + 1;
          continue;
        }
        case "ELSEIF": {
          if (top?.kind !== "IF") return this.fail("misplaced-block-word", tok, "`ELSEIF` is outside an `IF` block.");
          if (top.sawElse) return this.fail("misplaced-block-word", tok, `\`ELSEIF\` follows the \`ELSE\` of ${this.describe(top)}.`);
          const t = scan(toks, i + 1, (k) => isWord(toks[k], "THEN"));
          if (t < 0) return this.noKeyword(toks, i, "ELSEIF", "THEN", "its condition");
          i = t + 1;
          continue;
        }
        case "ELSE": {
          if (top?.kind !== "IF" && top?.kind !== "CASE") return this.fail("misplaced-block-word", tok, "`ELSE` is outside an `IF` or `CASE` block.");
          if (top.sawElse) return this.fail("misplaced-block-word", tok, `A second \`ELSE\` in ${this.describe(top)}.`);
          top.sawElse = true;
          i += 1;
          continue;
        }
        case "WHEN": {
          if (top?.kind !== "CASE") return this.fail("misplaced-block-word", tok, "`WHEN` is outside a `CASE` statement.");
          if (top.sawElse) return this.fail("misplaced-block-word", tok, `\`WHEN\` follows the \`ELSE\` of ${this.describe(top)}.`);
          const t = scan(toks, i + 1, (k) => isWord(toks[k], "THEN"));
          if (t < 0) return this.noKeyword(toks, i, "WHEN", "THEN", "its condition");
          i = t + 1;
          continue;
        }
        case "CASE": {
          const w = scan(toks, i + 1, (k) => isWord(toks[k], "WHEN"), true);
          if (w < 0) {
            const endCase = scan(toks, i + 1, (k) => isWord(toks[k], "END") && isWord(toks[k + 1], "CASE"));
            if (endCase >= 0) return this.fail("incomplete-block", tok, "`CASE` has no `WHEN` before its `END CASE`.");
            return this.noKeyword(toks, i, "CASE", "WHEN", "the CASE");
          }
          const t = scan(toks, w + 1, (k) => isWord(toks[k], "THEN"));
          if (t < 0) return this.noKeyword(toks, w, "WHEN", "THEN", "its condition");
          this.open("CASE", tok);
          i = t + 1;
          continue;
        }
        case "WHILE":
        case "FOR": {
          const d = scan(toks, i + 1, (k) => isWord(toks[k], "DO"));
          if (d < 0) return this.noKeyword(toks, i, tok.upper!, "DO", tok.upper === "FOR" ? "its query" : "its condition");
          this.open(tok.upper as Kind, tok, label);
          i = d + 1;
          continue;
        }
        case "LOOP": {
          this.open("LOOP", tok, label);
          i += 1;
          continue;
        }
        case "REPEAT": {
          if (next && isPunct(next, "(")) return void (this.gaveUp = true); // repeat('x', 3)
          this.open("REPEAT", tok, label);
          i += 1;
          continue;
        }
        case "UNTIL": {
          if (top?.kind !== "REPEAT") return this.fail("misplaced-block-word", tok, "`UNTIL` is outside a `REPEAT` block.");
          if (this.justOpened === top) return this.fail("incomplete-block", top.tok, `${this.describe(top)} has no statement before its \`UNTIL\`.`);
          // The condition ends at the first END that is not a CASE expression's:
          // a wrong closer there is then reported by the ordinary matching.
          const e = scan(toks, i + 1, (k) => isWord(toks[k], "END"));
          if (e < 0) {
            if (!wellFormed(toks, i + 1)) return void (this.gaveUp = true);
            return this.fail("incomplete-block", tok, "`UNTIL` condition is not followed by `END REPEAT`.");
          }
          top.sawUntil = true;
          i = e;
          continue;
        }
        case "DECLARE": {
          // DECLARE EXIT|CONTINUE HANDLER FOR cond <action>: the action may be a BEGIN block.
          if (isWord(toks[i + 1], "EXIT", "CONTINUE") && isWord(toks[i + 2], "HANDLER") && isWord(toks[i + 3], "FOR")) {
            return this.handler(toks, i);
          }
          return this.plain(toks, i);
        }
        case "THEN":
        case "DO":
          return this.fail("misplaced-block-word", tok,
            `\`${tok.upper}\` starts a statement here: it belongs after the condition of an \`${tok.upper === "THEN" ? "IF, ELSEIF or WHEN" : "WHILE or FOR"}\`.`);
        case "END":
          return this.close(toks, i);
        default:
          return this.plain(toks, i);
      }
    }
  }

  /**
   * A statement-start word whose required follower (`THEN`, `DO`, `WHEN`) is
   * nowhere in the fragment. Reported only when the rest of the fragment is
   * balanced, so a bracket the user has not finished typing stays silent.
   */
  private noKeyword(toks: Token[], at: number, word: string, need: string, of: string): void {
    if (!wellFormed(toks, at + 1)) return void (this.gaveUp = true);
    this.fail("incomplete-block", toks[at], `\`${word}\` has no \`${need}\` after ${of}.`);
  }

  /** An ordinary statement: nothing opens or closes, unless it hides an opener. */
  private plain(toks: Token[], from: number): void {
    this.justOpened = undefined;
    if (RAW_LEADS.has(toks[from].upper ?? "")) return;
    let depth = 0;
    for (let i = from; i < toks.length; i++) {
      const t = toks[i];
      if (isOpen(t)) depth++;
      else if (isClose(t)) depth = Math.max(0, depth - 1);
      else if (t.kind === "word" && depth === 0 && !afterNameOrPath(toks[i - 1]) && !isColon(toks[i + 1])) {
        const n = toks[i + 1];
        const callLike = n !== undefined && isPunct(n, "(");
        if (isWord(t, "BEGIN", "LOOP", "WHILE") || (isWord(t, "REPEAT") && !callLike)) {
          this.gaveUp = true; // a block opener where no statement starts: do not guess
          return;
        }
      }
    }
  }

  // --- the stack -----------------------------------------------------------------

  private open(kind: Kind, tok: Token, label?: Token): void {
    const b: Block = { kind, tok, label, sawElse: false, sawUntil: false };
    this.stack.push(b);
    this.justOpened = b;
  }

  private close(toks: Token[], i: number): void {
    const end = toks[i];
    let j = i + 1;
    let kw = "";
    if (toks[j]?.kind === "word" && CLOSER_WORDS.has(toks[j].upper!)) kw = toks[j++].upper!;
    const label = toks[j]?.kind === "word" || toks[j]?.kind === "qident" ? toks[j++] : undefined;
    const shown = kw === "" ? "END" : `END ${kw}`;
    if (j < toks.length) {
      // A block's end takes a closer word and a label, then the statement ends.
      const extra = toks[j];
      return this.fail("misplaced-block-word", extra,
        `\`${shown}\` is followed by \`${extra.text}\`. After a block's end only a label can follow, so a \`;\` is probably missing.`);
    }

    const empty = this.justOpened;
    this.justOpened = undefined;
    const top = this.stack.pop();
    if (top && empty === top && top.kind !== "BEGIN" && top.kind !== "IF" && top.kind !== "CASE") {
      // `WHILE c DO END WHILE`: the engine wants a statement in a loop (an empty BEGIN is fine).
      return this.fail("incomplete-block", top.tok, `${this.describe(top)} has no statement in its body.`);
    }
    if (!top) {
      report(this.ctx, "unmatched-block", "error", end, `\`${shown}\` closes nothing: no block is open here.`);
      this.gaveUp = true;
      return;
    }
    const wanted = top.kind === "BEGIN" ? "" : top.kind;
    // `if: BEGIN ... END if`: the word after END is the block's own label.
    if (kw !== "" && wanted === "" && !label && top.label?.upper === kw) kw = "";
    if (kw !== wanted) {
      report(this.ctx, "mismatched-block", "error", end,
        `\`${shown}\` cannot close ${this.describe(top)}: it needs ${this.closerOf(top)}.`);
      this.gaveUp = true;
      return;
    }
    if (top.kind === "REPEAT" && !top.sawUntil) {
      report(this.ctx, "mismatched-block", "error", end,
        `${this.describe(top)} has no UNTIL before \`END REPEAT\`.`);
      this.gaveUp = true;
      return;
    }
    if (label && !top.label) {
      this.fail("mismatched-block", label,
        `\`${label.text}\` is an end label, but ${this.describe(top)} has no label.`);
      return;
    }
    if (label && top.label && labelKey(label) !== labelKey(top.label)) {
      report(this.ctx, "mismatched-block", "error", label,
        `The end label \`${label.text}\` does not match the begin label \`${top.label.text}\` of ${this.describe(top)}.`);
      this.gaveUp = true;
    }
  }

  private describe(b: Block): string {
    const where_ = where(this.ctx.text, b.tok.start);
    const what = b.kind === "BEGIN" ? "`BEGIN`" : `\`${b.tok.text}\``;
    return `the ${what} at ${where_}`;
  }

  private closerOf(b: Block): string {
    return b.kind === "BEGIN" ? "`END`" : `\`END ${b.kind}\``;
  }
}

/** Check the block structure of each notebook cell: `cells[c][f]` is fragment f of cell c. */
export function checkBlocks(cells: Token[][][], ctx: Ctx): void {
  for (const frags of cells) new Cell(frags, ctx).run();
}
