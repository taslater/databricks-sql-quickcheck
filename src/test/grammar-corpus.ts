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
//
// Every file is checked. The files are shared out across worker threads (one
// per core, up to four), each with its own grammar, and the results are printed
// in the order the files are listed, so the output does not depend on the split.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { createGrammar, firstDisagreement, grammarsIn, tokenize, type Disagreement, type Region } from "./textmate";

// A known answer, checked before the corpus. If the grammar stopped loading,
// or the comparison stopped seeing regions, every file would "agree".
const CONTROL = "SELECT 'it\\'s', `a``b` -- note\n";
const CONTROL_EXPECTED: [string, Region][] = [
  ["SELECT", "code"],
  ["s'", "string"],
  ["b`", "identifier"],
  ["note", "comment"],
];

const MAX_WORKERS = 4;

function* sqlFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sqlFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".sql")) yield full;
  }
}

/** Each file's first disagreement, or undefined, for the files at `indices`. */
async function checkFiles(
  embedded: Record<string, string>,
  files: string[],
  indices: number[],
): Promise<[number, Disagreement | undefined][]> {
  const g = await createGrammar(embedded);
  return indices.map((i) => [i, firstDisagreement(g, fs.readFileSync(files[i], "utf8"))]);
}

function checkInWorkers(
  embedded: Record<string, string>,
  files: string[],
  workers: number,
): Promise<(Disagreement | undefined)[]> {
  const results: (Disagreement | undefined)[] = new Array(files.length);
  const jobs: Promise<void>[] = [];
  for (let w = 0; w < workers; w++) {
    // Interleaved, so that a run of large files does not land on one worker.
    const indices: number[] = [];
    for (let i = w; i < files.length; i += workers) indices.push(i);
    jobs.push(
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: { embedded, files, indices } });
        worker.once("message", (done: [number, Disagreement | undefined][]) => {
          for (const [i, d] of done) results[i] = d;
          resolve();
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`grammar-corpus worker exited with ${code}`));
        });
      }),
    );
  }
  return Promise.all(jobs).then(() => results);
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
  const files: string[] = [];
  for (const dir of dirs) for (const file of sqlFiles(dir)) files.push(file);

  const workers = Math.max(1, Math.min(os.availableParallelism(), MAX_WORKERS, files.length));
  const found = await checkInWorkers(embedded, files, workers);

  let disagreeing = 0;
  files.forEach((file, i) => {
    const d = found[i];
    if (!d) return;
    disagreeing++;
    console.log(`${file}:${d.line}:${d.column}: lexer says ${d.lexer}, grammar says ${d.grammar}`);
    console.log(`    ${d.context.trim().slice(0, 160)}`);
  });
  console.log(`${files.length} files, ${disagreeing} where the grammar and the lexer disagree`);
  return disagreeing === 0 && files.length > 0 ? 0 : 1;
}

if (isMainThread) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
} else {
  const { embedded, files, indices } = workerData as { embedded: Record<string, string>; files: string[]; indices: number[] };
  checkFiles(embedded, files, indices).then((done) => parentPort!.postMessage(done));
}
