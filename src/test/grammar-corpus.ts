// The grammar-lexer agreement gate over a whole corpus:
//
//   node out/test/grammar-corpus.js [--embedded <extensions dir>] <dir>...
//
// `--embedded` loads the grammars of every extension under a directory (for
// VS Code's own: <app>/Contents/Resources/app/extensions), so that Python,
// YAML and markdown are coloured inside the regions that embed them, as they
// are in the editor.
//
// Prints each `.sql` file where the TextMate grammar and the lexer disagree on
// where a string, quoted identifier, comment, `$$` body or template begins or
// ends, with the first place they part, and exits 1 if there are any.

import * as fs from "node:fs";
import * as path from "node:path";
import { createGrammar, firstDisagreement, grammarsIn, tokenize, type Region } from "./textmate";

// A known answer, checked before the corpus. If the grammar stopped loading,
// or the comparison stopped seeing regions, every file would "agree".
const CONTROL = "SELECT 'it\\'s', `a``b` -- note\n";
const CONTROL_EXPECTED: [string, Region][] = [
  ["SELECT", "code"],
  ["s'", "string"],
  ["b`", "identifier"],
  ["note", "comment"],
];

function* sqlFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sqlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".sql")) yield full;
  }
}

async function main(args: string[]): Promise<number> {
  let embedded: Record<string, string> = {};
  const at = args.indexOf("--embedded");
  if (at >= 0) {
    embedded = grammarsIn(args[at + 1]);
    args.splice(at, 2);
  }
  const dirs = args;
  if (dirs.length === 0) {
    console.error("usage: node out/test/grammar-corpus.js [--embedded <extensions dir>] <dir>...");
    return 2;
  }
  const g = await createGrammar(embedded);
  const regions = tokenize(g, CONTROL).regions;
  for (const [needle, want] of CONTROL_EXPECTED) {
    const got = regions[CONTROL.indexOf(needle)];
    if (got !== want) {
      console.error(`control failed: \`${needle}\` in ${JSON.stringify(CONTROL)} is ${got}, expected ${want}`);
      return 2;
    }
  }
  let files = 0;
  let disagreeing = 0;
  for (const dir of dirs) {
    for (const file of sqlFiles(dir)) {
      files++;
      const d = firstDisagreement(g, fs.readFileSync(file, "utf8"));
      if (!d) continue;
      disagreeing++;
      console.log(`${file}:${d.line}:${d.column}: lexer says ${d.lexer}, grammar says ${d.grammar}`);
      console.log(`    ${d.context.trim().slice(0, 160)}`);
    }
  }
  console.log(`${files} files, ${disagreeing} where the grammar and the lexer disagree`);
  return disagreeing === 0 && files > 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
