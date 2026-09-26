// A single-pass lexer for the Databricks SQL lexical layer.
//
// It does not try to understand statements. Its job is to find token
// boundaries correctly -- above all, where strings, quoted identifiers and
// comments begin and end -- so that the checks built on it never mistake a
// comma inside a string for a real one. Everything that is not SQL but turns
// up in real Databricks files (notebook cell separators, widget parameters,
// dashboard and Jinja templates, `$$` function bodies) is recognised and
// wrapped as an opaque token rather than tripping a check.

export type TokenKind =
  | "word" // unquoted identifier or keyword
  | "qident" // `quoted identifier`
  | "string" // '...', "...", r'...', X'...'
  | "number"
  | "dollar" // $$ ... $$ function body
  | "template" // ${x}, $x, {{ x }}, {% ... %}, {# ... #}
  | "comment"
  | "separator" // -- COMMAND ---------- (notebook cell boundary)
  | "punct" // ( ) [ ] { } , ; .
  | "op" // operators, plus : :: ? @
  | "other"; // anything else: never checked, never trips a check

export interface Token {
  kind: TokenKind;
  text: string;
  start: number; // offset of the first character
  end: number; // offset one past the last character
  upper?: string; // words only
}

export interface LexError {
  code: string;
  message: string;
  start: number;
  end: number;
}

export interface LexResult {
  tokens: Token[];
  errors: LexError[];
}

const WORD_RE = /[\p{L}\p{M}\p{N}_]+/uy;
const NUMBER_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[\p{L}\p{N}_]*/uy;
const WIDGET_RE = /\$[A-Za-z_][A-Za-z0-9_]*/y;
const SEPARATOR_RE = /^--\s*COMMAND\s*-{2,}\s*$/;
// Leading blank lines, then `%lang` at the start of a line.
const MAGIC_RE = /\s*%([A-Za-z]+)\b/y;

const OPS3 = ["<=>"];
const OPS2 = ["<>", "<=", ">=", "!=", "==", "=>", "->", "||", "|>", "::"];
const OPS1 = "+-*/%&|^~!=<>:?@";
const PUNCT = "()[]{},;.";

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

const WORD_START_RE = /[\p{L}\p{M}_]/u;

function isWordStart(c: number, ch: string): boolean {
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) return true;
  return c > 127 && WORD_START_RE.test(ch);
}

/**
 * Scan a quoted run starting at the opening quote. Returns the offset one past
 * the closing quote, or -1 when the input ends first.
 *
 * A doubled quote is consumed as an escape. Whether Databricks reads `'a''b'`
 * as one string or as two adjacent literals (which concatenate) makes no
 * difference to where the token ends, so either reading is safe here.
 */
function scanQuoted(text: string, i: number, quote: string, backslash: boolean, limit: number): number {
  const n = limit;
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (backslash && c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/** Spark nests bracketed comments: `/* a /* b *\/ c *\/` is one comment. */
function scanBlockComment(text: string, i: number, limit: number): number {
  const n = limit;
  let depth = 0;
  let j = i;
  while (j < n) {
    if (text[j] === "/" && text[j + 1] === "*") {
      depth++;
      j += 2;
    } else if (text[j] === "*" && text[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return -1;
}

const NOTEBOOK_HEADER_RE = /^\uFEFF?\s*-- Databricks notebook source/;
const CELL_LINE_RE = /^--\s*COMMAND\s*-{2,}[ \t]*\r?$/gm;

/**
 * Offsets where notebook cells end. Each cell runs on its own, so nothing --
 * no string, comment or bracket -- can span a separator; bounding scans here
 * keeps one missing quote from swallowing every cell after it.
 */
function cellBoundaries(text: string): number[] {
  if (!NOTEBOOK_HEADER_RE.test(text)) return [];
  const out: number[] = [];
  CELL_LINE_RE.lastIndex = 0;
  for (let m = CELL_LINE_RE.exec(text); m; m = CELL_LINE_RE.exec(text)) out.push(m.index);
  return out;
}

export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const n = text.length;
  const cells = cellBoundaries(text);
  let cell = 0;
  let i = 0;
  // The end of the cell containing offset i (or of the text).
  const limitAt = (at: number): number => {
    while (cell < cells.length && cells[cell] <= at) cell++;
    return cell < cells.length ? cells[cell] : n;
  };

  const push = (kind: TokenKind, start: number, end: number): Token => {
    const tok: Token = { kind, text: text.slice(start, end), start, end };
    tokens.push(tok);
    return tok;
  };
  const fail = (code: string, message: string, start: number, end: number): void => {
    errors.push({ code, message, start, end });
  };

  // A cell that opens with a non-SQL magic (`%python`, `%md`, `%run ./x`) is
  // not SQL at all: lex it as one opaque comment. `%sql` cells are checked.
  let cellStart = true;
  const skipMagicCell = (): boolean => {
    MAGIC_RE.lastIndex = i;
    const m = MAGIC_RE.exec(text);
    if (!m || m[1].toLowerCase() === "sql") return false;
    const limit = limitAt(i);
    push("comment", i + m[0].length - m[1].length - 1, limit);
    i = limit;
    return true;
  };

  while (i < n) {
    if (cellStart) {
      cellStart = false;
      if (skipMagicCell()) continue;
    }
    const c = text.charCodeAt(i);
    const ch = text[i];

    // Whitespace.
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 0xa0 || c === 0xfeff) {
      i++;
      continue;
    }

    // Line comment, or a notebook cell separator.
    if (ch === "-" && text[i + 1] === "-") {
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      const body = text.slice(i, j);
      const separator = SEPARATOR_RE.test(body);
      push(separator ? "separator" : "comment", i, j);
      i = j;
      cellStart = separator || (tokens.length === 1 && body.startsWith("-- Databricks notebook source"));
      continue;
    }

    // Bracketed comment (also optimizer hints, `/*+ ... */`).
    if (ch === "/" && text[i + 1] === "*") {
      const limit = limitAt(i);
      const j = scanBlockComment(text, i, limit);
      if (j < 0) {
        fail("unterminated-comment", "Unterminated comment: `/*` is never closed by `*/`", i, i + 2);
        push("comment", i, limit);
        i = limit;
        continue;
      }
      push("comment", i, j);
      i = j;
      continue;
    }

    // String literals.
    if (ch === "'" || ch === '"') {
      const limit = limitAt(i);
      const j = scanQuoted(text, i, ch, true, limit);
      if (j < 0) {
        fail("unterminated-string", `Unterminated string: this ${ch} is never closed`, i, i + 1);
        push("string", i, limit);
        i = limit;
        continue;
      }
      push("string", i, j);
      i = j;
      continue;
    }

    // Quoted identifier; a doubled backtick is an escaped backtick.
    if (ch === "`") {
      const limit = limitAt(i);
      const j = scanQuoted(text, i, "`", false, limit);
      if (j < 0) {
        fail("unterminated-identifier", "Unterminated quoted identifier: this ` is never closed", i, i + 1);
        push("qident", i, limit);
        i = limit;
        continue;
      }
      push("qident", i, j);
      i = j;
      continue;
    }

    // Numbers, including `.5`, `1e3`, `10L`, `1.5BD`.
    if (isDigit(c) || (ch === "." && isDigit(text.charCodeAt(i + 1)))) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(text);
      if (m) {
        push("number", i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }

    // Words; `r'...'` and `R"..."` are raw strings, where backslash is literal.
    if (isWordStart(c, ch)) {
      WORD_RE.lastIndex = i;
      const m = WORD_RE.exec(text);
      const len = m ? m[0].length : 1;
      const next = text[i + len];
      if (len === 1 && (ch === "r" || ch === "R") && (next === "'" || next === '"')) {
        const limit = limitAt(i);
        const j = scanQuoted(text, i + 1, next, false, limit);
        if (j < 0) {
          fail("unterminated-string", `Unterminated raw string: this ${next} is never closed`, i, i + 2);
          push("string", i, limit);
          i = limit;
          continue;
        }
        push("string", i, j);
        i = j;
        continue;
      }
      const tok = push("word", i, i + len);
      tok.upper = tok.text.toUpperCase();
      i += len;
      continue;
    }

    // `$$ ... $$` bodies, `${param}` and `$param` widgets.
    if (ch === "$") {
      if (text[i + 1] === "$") {
        const limit = limitAt(i);
        const j = text.indexOf("$$", i + 2);
        if (j < 0 || j + 2 > limit) {
          fail("unterminated-body", "Unterminated `$$` body: it is never closed by `$$`", i, i + 2);
          push("dollar", i, limit);
          i = limit;
          continue;
        }
        push("dollar", i, j + 2);
        i = j + 2;
        continue;
      }
      if (text[i + 1] === "{") {
        const close = text.indexOf("}", i + 2);
        const eol = text.indexOf("\n", i + 2);
        if (close < 0 || (eol >= 0 && eol < close)) {
          fail("unterminated-template", "Unterminated parameter: `${` is never closed by `}`", i, i + 2);
          push("template", i, i + 2);
          i += 2;
          continue;
        }
        push("template", i, close + 1);
        i = close + 1;
        continue;
      }
      WIDGET_RE.lastIndex = i;
      const m = WIDGET_RE.exec(text);
      if (m) {
        push("template", i, i + m[0].length);
        i += m[0].length;
        continue;
      }
      push("other", i, i + 1);
      i++;
      continue;
    }

    // Dashboard parameters and Jinja: `{{ x }}`, `{% ... %}`, `{# ... #}`.
    if (ch === "{") {
      const second = text[i + 1];
      const closer = second === "{" ? "}}" : second === "%" ? "%}" : second === "#" ? "#}" : null;
      if (closer) {
        const limit = limitAt(i);
        const j = text.indexOf(closer, i + 2);
        if (j < 0 || j + 2 > limit) {
          fail("unterminated-template", `Unterminated template: \`{${second}\` is never closed by \`${closer}\``, i, i + 2);
          push("template", i, limit);
          i = limit;
          continue;
        }
        push("template", i, j + 2);
        i = j + 2;
        continue;
      }
    }

    if (PUNCT.includes(ch)) {
      push("punct", i, i + 1);
      i++;
      continue;
    }

    const three = text.slice(i, i + 3);
    if (OPS3.includes(three)) {
      push("op", i, i + 3);
      i += 3;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (OPS2.includes(two)) {
      push("op", i, i + 2);
      i += 2;
      continue;
    }
    if (OPS1.includes(ch)) {
      push("op", i, i + 1);
      i++;
      continue;
    }

    // Anything else: keep surrogate pairs whole so offsets stay on code points.
    const cp = text.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    push("other", i, i + width);
    i += width;
  }

  return { tokens, errors };
}
