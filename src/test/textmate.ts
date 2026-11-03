// Runs the TextMate grammar the way VS Code does (vscode-textmate over the
// Oniguruma WASM build) and compares it with the lexer, character by
// character. The two must agree on where strings, quoted identifiers,
// comments, `$$` bodies and templates begin and end: the lexer decides what
// the checks see, the grammar decides what the editor shows, and a quote that
// one closes and the other does not is the bug this whole mode exists to fix.

import * as fs from "node:fs";
import * as path from "node:path";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";
import { lex, type TokenKind } from "../lexer";

export const SCOPE = "source.databricks-sql";
const GRAMMAR_PATH = path.join(__dirname, "..", "..", "syntaxes", "databricks-sql.tmLanguage.json");

/** What a character is, as far as boundaries go. */
export type Region = "code" | "string" | "identifier" | "comment" | "body" | "template";

const LEXER_REGION: Record<TokenKind, Region> = {
  word: "code",
  qident: "identifier",
  string: "string",
  number: "code",
  dollar: "body",
  template: "template",
  comment: "comment",
  separator: "comment",
  punct: "code",
  op: "code",
  other: "code",
};

/** The region of the innermost construct that decides a boundary. */
function grammarRegion(scopes: readonly string[]): Region {
  const has = (prefix: string) => scopes.some((s) => s.startsWith(prefix));
  if (has("meta.template.")) return "template";
  if (has("meta.dollar-body.")) return "body";
  if (has("meta.magic-cell.") || has("comment.")) return "comment";
  if (has("variable.other.quoted.backtick.")) return "identifier";
  if (has("string.")) return "string";
  return "code";
}

let onig: Promise<vsctm.IOnigLib> | undefined;

function onigLib(): Promise<vsctm.IOnigLib> {
  onig ??= (async () => {
    const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    return {
      createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    };
  })();
  return onig;
}

/**
 * Load the grammar. `embedded` maps the scope names of other grammars (Python,
 * YAML, markdown) to their files; without them, embedded contents are left
 * uncoloured and classified by the enclosing meta scope, which is all that
 * matters for boundaries.
 */
export async function createGrammar(embedded: Record<string, string> = {}): Promise<vsctm.IGrammar> {
  const files: Record<string, string> = { ...embedded, [SCOPE]: GRAMMAR_PATH };
  const registry = new vsctm.Registry({
    onigLib: onigLib(),
    loadGrammar: async (scopeName: string) => {
      const file = files[scopeName];
      return file ? vsctm.parseRawGrammar(fs.readFileSync(file, "utf8"), file) : null;
    },
  });
  const g = await registry.loadGrammar(SCOPE);
  if (!g) throw new Error(`could not load ${GRAMMAR_PATH}`);
  return g;
}

let grammar: Promise<vsctm.IGrammar> | undefined;

export function loadGrammar(): Promise<vsctm.IGrammar> {
  grammar ??= createGrammar();
  return grammar;
}

/** The grammars contributed by every extension under `dir`, by scope name. */
export function grammarsIn(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ext of fs.readdirSync(dir)) {
    const manifest = path.join(dir, ext, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const grammars = JSON.parse(fs.readFileSync(manifest, "utf8"))?.contributes?.grammars ?? [];
    for (const g of grammars) if (g.scopeName && g.path) out[g.scopeName] = path.join(dir, ext, g.path);
  }
  return out;
}

export interface Token {
  text: string;
  scopes: string[];
}

/** Tokenize like the editor: line by line, without line terminators. */
export function tokenize(g: vsctm.IGrammar, text: string): { lines: Token[][]; regions: Region[] } {
  const regions: Region[] = new Array(text.length).fill("code");
  const lines: Token[][] = [];
  let state = vsctm.INITIAL;
  const eol = /\r?\n|\r/g;
  let start = 0;
  for (;;) {
    const m = eol.exec(text);
    const end = m ? m.index : text.length;
    const line = text.slice(start, end);
    const r = g.tokenizeLine(line, state);
    lines.push(r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes })));
    for (const t of r.tokens) {
      const region = grammarRegion(t.scopes);
      for (let i = t.startIndex; i < Math.min(t.endIndex, line.length); i++) regions[start + i] = region;
    }
    state = r.ruleStack;
    if (!m) break;
    start = m.index + m[0].length;
  }
  return { lines, regions };
}

export function lexerRegions(text: string): Region[] {
  const regions: Region[] = new Array(text.length).fill("code");
  for (const t of lex(text).tokens) {
    const region = LEXER_REGION[t.kind];
    for (let i = t.start; i < t.end; i++) regions[i] = region;
  }
  return regions;
}

export interface Disagreement {
  offset: number;
  line: number; // 1-based
  column: number; // 1-based
  lexer: Region;
  grammar: Region;
  context: string;
}

/**
 * The first character, ignoring whitespace, where the lexer and the grammar
 * disagree on the region. Whitespace is ignored because the lexer leaves it
 * outside every token while the grammar colours it inside a string.
 */
export function firstDisagreement(g: vsctm.IGrammar, text: string): Disagreement | undefined {
  const fromLexer = lexerRegions(text);
  const fromGrammar = tokenize(g, text).regions;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]) || fromLexer[i] === fromGrammar[i]) continue;
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    const column = i - before.lastIndexOf("\n");
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEnd = text.indexOf("\n", i);
    return {
      offset: i,
      line,
      column,
      lexer: fromLexer[i],
      grammar: fromGrammar[i],
      context: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd),
    };
  }
  return undefined;
}
