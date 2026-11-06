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

const isWord = (t: Token | undefined, ...upper: string[]): boolean =>
  t?.kind === "word" && upper.includes(t.upper!);
const isColon = (t: Token | undefined): boolean => t?.kind === "op" && t.text === ":";
const isOpen = (t: Token): boolean => isPunct(t, "(") || isPunct(t, "[") || isPunct(t, "{");
const isClose = (t: Token): boolean => isPunct(t, ")") || isPunct(t, "]") || isPunct(t, "}");

/** A name that follows `.`, `:`, `::` or AS is a name whatever it spells. */
function afterNameMarker(p: Token | undefined): boolean {
  if (!p) return false;
  if (p.kind === "punct") return p.text === ".";
  if (p.kind === "op") return p.text === "::";
  return p.kind === "word" && p.upper === "AS";
}

/**
 * The index of the first token from `from` that satisfies `stop`, looking only
 * at bracket depth 0 and outside any `CASE ... END` expression (whose `THEN`
 * and `END` are not the statement's). -1 when there is none, or when the scan
 * runs into an unbalanced bracket.
 */
function scan(toks: Token[], from: number, stop: (i: number) => boolean): number {
  let depth = 0;
  let cases = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      if (depth === 0) return -1;
      depth--;
    } else if (t.kind === "word" && depth === 0) {
      if (t.upper === "CASE" && !afterNameMarker(toks[i - 1])) {
        cases++;
        continue;
      }
      if (t.upper === "END" && cases > 0) {
        cases--;
        continue;
      }
      if (cases === 0 && stop(i)) return i;
    }
  }
  return -1;
}

/** Brackets and CASE...END all balance from `from` to the fragment's end. */
function wellFormed(toks: Token[], from: number): boolean {
  let depth = 0;
  let cases = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      if (depth === 0) return false;
      depth--;
    } else if (t.kind === "word" && depth === 0) {
      if (t.upper === "CASE" && !afterNameMarker(toks[i - 1])) cases++;
      else if (t.upper === "END") {
        if (cases === 0) return false;
        cases--;
      }
    }
  }
  return depth === 0 && cases === 0;
}

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
      const b = scan(toks, 1, (i) => isWord(toks[i], "BEGIN") && !isPunct(toks[i - 1], "."));
      if (b >= 0) return this.head(toks, b);
      return;
    }
    // DECLARE ... HANDLER FOR cond <action>: the action may be a BEGIN block.
    if (lead === "DECLARE" && toks.some((t) => isWord(t, "HANDLER"))) {
      const b = scan(toks, 1, (i) => isWord(toks[i], "BEGIN"));
      if (b >= 0) return this.head(toks, b);
      if (scan(toks, 1, (i) => isWord(toks[i], "IF", "WHILE", "LOOP", "REPEAT", "FOR", "CASE")) >= 0) this.gaveUp = true;
      return;
    }
    this.head(toks, 0);
  }

  /** Read blocks from a position where a statement can start. */
  private head(toks: Token[], from: number): void {
    let i = from;
    while (i < toks.length && !this.gaveUp) {
      let tok = toks[i];
      let label: Token | undefined;
      if (tok.kind === "word" && isColon(toks[i + 1]) && isWord(toks[i + 2], ...LABELLED)) {
        label = tok;
        i += 2;
        tok = toks[i];
      }
      if (tok.kind !== "word") return this.plain(toks, i);
      const next = toks[i + 1];
      const top = this.stack[this.stack.length - 1];
      switch (tok.upper) {
        case "BEGIN": {
          if (!next) return void (this.gaveUp = true); // a bare `BEGIN;` could be a transaction
          if (isWord(next, ...TRANSACTION_WORDS)) return;
          this.open("BEGIN", tok, label);
          i += isWord(next, "ATOMIC") ? 2 : 1;
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
          const w = scan(toks, i + 1, (k) => isWord(toks[k], "WHEN"));
          if (w < 0) return this.noKeyword(toks, i, "CASE", "WHEN", "the CASE");
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
      else if (t.kind === "word" && depth === 0 && !afterNameMarker(toks[i - 1]) && !isColon(toks[i + 1])) {
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
    const label = toks[j]?.kind === "word" ? toks[j++] : undefined;
    if (j < toks.length) return void (this.gaveUp = true); // more after the closer: do not guess
    const shown = kw === "" ? "END" : `END ${kw}`;

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
    if (label && top.label && label.upper !== top.label.upper) {
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
