#!/usr/bin/env node
// Command-line front end: `dbsql-quickcheck [options] <file|dir>...`
//
// Output is `path:line:col: severity [code] message`, which VS Code's terminal
// and most CI log viewers turn into links. Exit status is 1 when any error is
// found (or any warning, with --strict), so it drops into a pre-commit hook.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { check, Diagnostic } from "./check";

const USAGE = `usage: dbsql-quickcheck [options] <file|dir>...

  --no-warnings   report errors only
  --strict        exit 1 on warnings as well as errors
  --json          print results as JSON
  --stdin         check standard input (name it with --stdin-filename)
  --jsonl         batch mode: read {"id","text"} lines on stdin, write one
                  {"id","diagnostics","micros"} line per input
  -h, --help      show this help`;

interface Args {
  paths: string[];
  warnings: boolean;
  strict: boolean;
  json: boolean;
  stdin: boolean;
  stdinName: string;
  jsonl: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { paths: [], warnings: true, strict: false, json: false, stdin: false, stdinName: "<stdin>", jsonl: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-warnings") args.warnings = false;
    else if (a === "--strict") args.strict = true;
    else if (a === "--json") args.json = true;
    else if (a === "--stdin") args.stdin = true;
    else if (a === "--stdin-filename") args.stdinName = argv[++i] ?? args.stdinName;
    else if (a === "--jsonl") args.jsonl = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown option ${a}\n\n${USAGE}`);
      process.exit(2);
    } else args.paths.push(a);
  }
  return args;
}

function collect(p: string, out: string[]): void {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(p).sort()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const child = path.join(p, entry);
      if (fs.statSync(child).isDirectory() || entry.toLowerCase().endsWith(".sql")) collect(child, out);
    }
  } else {
    out.push(p);
  }
}

function format(file: string, d: Diagnostic): string {
  return `${file}:${d.line}:${d.column}: ${d.severity} [${d.code}] ${d.message}`;
}

async function runJsonl(warnings: boolean): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { id, text } = JSON.parse(line) as { id: string; text: string };
    const t0 = process.hrtime.bigint();
    const diagnostics = check(text, { warnings });
    const micros = Number(process.hrtime.bigint() - t0) / 1000;
    process.stdout.write(JSON.stringify({ id, diagnostics, micros }) + "\n");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.jsonl) return runJsonl(args.warnings);

  const inputs: { name: string; text: string }[] = [];
  if (args.stdin) {
    inputs.push({ name: args.stdinName, text: fs.readFileSync(0, "utf8") });
  } else {
    if (args.paths.length === 0) {
      console.error(USAGE);
      process.exit(2);
    }
    const files: string[] = [];
    for (const p of args.paths) collect(p, files);
    for (const f of files) inputs.push({ name: f, text: fs.readFileSync(f, "utf8") });
  }

  let errors = 0;
  let warnings = 0;
  const results: { path: string; diagnostics: Diagnostic[] }[] = [];
  for (const { name, text } of inputs) {
    const diagnostics = check(text, { warnings: args.warnings });
    errors += diagnostics.filter((d) => d.severity === "error").length;
    warnings += diagnostics.filter((d) => d.severity === "warning").length;
    if (args.json) results.push({ path: name, diagnostics });
    else for (const d of diagnostics) console.log(format(name, d));
  }
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else if (errors || warnings) console.error(`${errors} error(s), ${warnings} warning(s) in ${inputs.length} file(s)`);
  process.exit(errors > 0 || (args.strict && warnings > 0) ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(2);
});
