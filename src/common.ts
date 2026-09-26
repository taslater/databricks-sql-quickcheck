// Types and token helpers shared by the check modules.

import { Token } from "./lexer";

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
  /**
   * Warn on every implicit column alias (`SELECT a b`). Off by default: about
   * one real file in ten aliases this way on purpose. Teams that already
   * require AS get every lost comma reported in return.
   */
  explicitAliases?: boolean;
}

export type Raw = Omit<Diagnostic, "line" | "column" | "endLine" | "endColumn">;

export interface Ctx {
  text: string;
  /** This fragment writes a generic type, so a `>` may be closing one. */
  generics?: boolean;
  /** The file has a BEGIN block, so a `;` may sit inside a scripting CASE. */
  scripting: boolean;
  /** The lexer stopped early (unterminated token), so this fragment has no real end. */
  openEnded: boolean;
  warnings: boolean;
  explicitAliases: boolean;
  out: Raw[];
  /** Strings that look to have swallowed code: the tokens after them are unreliable. */
  swallowed?: Set<number>;
  /** Tokens a statement-level check has already explained (a keyword typo). */
  flagged?: Set<number>;
}

// Keywords that are values, so they end an operand: `NULL x` aliases NULL.
export const VALUE_WORDS = new Set([
  "NULL", "TRUE", "FALSE", "CURRENT_DATE", "CURRENT_TIMESTAMP", "CURRENT_TIME", "CURRENT_USER",
]);

/** After `.`, `:`, `::` or AS a word is a name, never a keyword. */
export function isNameContext(p: Token | undefined): boolean {
  if (!p) return false;
  if (p.kind === "punct") return p.text === ".";
  if (p.kind === "op") return p.text === ":" || p.text === "::";
  return p.kind === "word" && p.upper === "AS";
}

export function isPunct(t: Token, ch: string): boolean {
  return t.kind === "punct" && t.text === ch;
}

/** Templates and unknown characters could stand for anything: never judge next to them. */
export function isWild(t: Token): boolean {
  return t.kind === "template" || t.kind === "other";
}

export function report(ctx: Ctx, code: string, severity: Severity, t: Token, message: string): void {
  // Diagnostics are anchored on the offending token; a token swallowed to the
  // end of the input by the lexer is anchored on its first character only.
  const end = Math.min(t.end, t.start + Math.max(1, Math.min(t.text.length, 80)));
  ctx.out.push({ code, severity, message, start: t.start, end });
}

export function where(text: string, offset: number): string {
  const [line, col] = lineCol(offset, lineStarts(text));
  return `line ${line}:${col}`;
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

export function lineCol(offset: number, starts: number[]): [number, number] {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return [lo + 1, offset - starts[lo] + 1];
}
