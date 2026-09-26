# databricks-sql-quickcheck

Instant, as-you-type syntax checks for Databricks SQL.

This is the fast, shallow tier of checking, the SQL equivalent of what
pyflakes is to pylint. It does not parse your SQL against the full Databricks
grammar. It lexes the text and then checks the structure: brackets that never
close, strings that never end, `,,`, `f(a,)`, `a + )`, a `CASE` with no `END`,
and the missing comma in `SELECT a b c`. It runs inside the VS Code extension
host with no child process, taking about 50 µs on a typical file. That's fast
enough to re-check on every keystroke.

Use it alongside SQLFluff, not in place of it. SQLFluff checks the full grammar
and belongs on save or in CI. Quickcheck catches the typos while you're typing
them.

```text
$ dbsql-quickcheck notebooks/
notebooks/orders.sql:14:3: warning [alias-on-new-line] `last_name` on its own line is read as an alias of the expression above it. Missing comma? (Write `AS last_name` if the alias is intended.)
notebooks/orders.sql:17:16: error [unterminated-string] Unterminated string: this ' is never closed
notebooks/orders.sql:21:12: warning [comma-before-clause] Trailing comma before FROM
notebooks/orders.sql:22:8: error [case-without-end] CASE has no END before the statement ends
```

## What it checks

There are two severities, and the line between them is deliberate.

- An **error** is something no Databricks grammar can accept. The corpus
  evaluation below holds errors to zero false positives.
- A **warning** is almost certainly a mistake, but one that Spark's lenient
  keyword handling might technically accept, or valid SQL that silently does
  the wrong thing. You can turn warnings off.

| code | severity | example |
| --- | --- | --- |
| `unterminated-string` / `-identifier` / `-comment` / `-body` / `-template` | error | `WHERE s = 'active`, `` `col ``, `/* …`, `AS $$ …`, `{{ p` |
| `unclosed-bracket` / `unmatched-bracket` / `mismatched-bracket` | error | `count(*`, `a)`, `f(a]` (also inside `/*+ hints */`) |
| `double-comma` / `leading-comma` / `trailing-comma` | error | `a,, b`, `f(, a)`, `(a INT, b INT,)` |
| `missing-operand` | error | `a + )`, `a = = b`, `(= b)`, `WHERE y >` |
| `case-without-end` | error | `CASE WHEN a THEN 1 ELSE 0 AS flag` |
| `missing-comma` | warning | `SELECT id name email`, `GROUP BY a b`, `coalesce(a b)`, `SELECT a b(c)` |
| `alias-on-new-line` | warning | `first_name` then `last_name` on the next line. This is valid SQL that aliases one column as the other, which is the classic silent missing comma. |
| `comma-before-clause` | warning | `SELECT a, b, FROM t` |
| `string-swallows-code` | warning | a string with a missing closing quote pairs with an apostrophe in a later comment, so the quotes balance and the SQL in between is swallowed into the string |

It understands the things real Databricks files contain that would otherwise
trip a naive checker:

- **Notebook format.** Checking stops at each `-- COMMAND ----------` cell
  separator, so one missing quote can't turn every later cell red. `-- MAGIC`
  cells are comments, and a leading `%sql` line is skipped.
- **Parameters and templates.** `${widget}`, `$widget`, `{{ dashboard_param }}`
  and Jinja `{% … %}` are treated as opaque, and nothing next to them is
  judged.
- **Lexical detail.** Escaped `\'` and doubled `''` quotes, raw `r'…'` strings,
  ``` `` ``` escapes, nested `/* /* */ */` comments and Python `$$` bodies are
  all handled.
- **Lookalikes.** Operators and brackets that resemble mistakes but aren't:
  `ARRAY<MAP<STRING, INT>>`, lambdas `x -> x + 1`, named arguments `=>`, JSON
  paths `raw:a.b[0]::string`, pipe syntax `|>`, `:param` and `?` markers,
  `MATCH_RECOGNIZE` patterns like `PATTERN (a b+ c*)`, and `SET key = value`,
  whose value Spark reads as raw text.

It deliberately doesn't know the grammar. A statement that is structurally
sound but leaves out a required clause is SQLFluff's to catch. An example is
`CREATE FLOW f AS INSERT INTO t` with no query.

## How well it works

`eval/evaluate.py` measures quickcheck against
[databricks-sql-corpus](https://github.com/taslater/databricks-sql-corpus), in
both directions. These figures are from 2026-09-25:

| | result |
| --- | --- |
| Valid corpus: 562 files from 13 sources (Databricks notebooks, TPC-DS/TPC-H/SSB, SQLFluff's sparksql and databricks fixtures) | **0 errors, 0 warnings** |
| Reference must-parse cases, transcribed from the Databricks SQL docs | **823 / 823 clean** |
| Guaranteed-invalid mutants from the corpus's `mutate.py` | **2598 / 2599 errors (100.0%)**; the last one is caught as a `string-swallows-code` warning |
| Weak mutants (deleted comma or keyword, dangling `AND`/`OR`) | 39% / 18% / 41% flagged; many of these are still valid SQL |
| Reference must-reject cases (grammar-level omissions) | 39 / 395, not a target |
| Speed over the valid corpus (1.1M characters) | 51 ms total; median 52 µs per file, p95 0.3 ms, max 2.1 ms |

The evaluation excludes 11 mutants that land inside `SET key = value`. Spark
reads the value as raw text, so `SET k = dynamic,,static` is valid SQL even
though `mutate.py` labels it guaranteed-invalid.

For comparison, SQLFluff 3.5.0 run through its CLI, the way the existing
`local.databricks-sql` extension runs it, takes 0.8 to 1.1 s per lint on a
120 to 250 line file. Warm, in-process SQLFluff 4.3.0 with the Rust parser
parses the same kind of file in about 14 ms.

## Install

### VS Code

```bash
npm install
npm run package          # builds dist/databricks-sql-quickcheck.vsix
code --install-extension dist/databricks-sql-quickcheck.vsix
```

It checks every document whose language is `sql` or `databricks-sql`. That
includes `.sql` notebooks and notebook cells, and it covers the `.dbsql` files
of the `local.databricks-sql` extension. Findings show up in the Problems panel
with source `quickcheck`.

| setting | default | |
| --- | --- | --- |
| `databricksSqlQuickcheck.enable` | `true` | |
| `databricksSqlQuickcheck.languages` | `["sql", "databricks-sql"]` | language ids to check |
| `databricksSqlQuickcheck.warnings` | `true` | `false` reports errors only |

### Command line

```bash
npm install && npm run build
node out/cli.js path/to/file.sql path/to/dir/     # or `npm link` for dbsql-quickcheck
```

The CLI exits 1 on any error, or on warnings too with `--strict`, so it drops
into a pre-commit hook. Other flags are `--no-warnings`, `--json`, `--stdin`
and `--jsonl` (batch mode: `{"id","text"}` lines in, one result line out).

### As a library

```ts
import { check } from "databricks-sql-quickcheck";
check("SELECT a,, b FROM t");
// [{ code: "double-comma", severity: "error", line: 1, column: 10, start: 9, end: 10, ... }]
```

## Why a hand-written lexer

- **Regular expressions over the whole file aren't enough.** A regex can't
  tell a comma inside a string from a real one, and every check depends on
  that. So quickcheck uses a single-pass lexer: a character loop with a few
  anchored regexes for words and numbers. It gets token boundaries exactly
  right, and all it knows beyond that is bracket depth.
- **Tree-sitter was considered and rejected.** It's the standard for this job
  in editors, but no grammar tracks Databricks SQL closely, and a grammar that
  lags produces red squiggles on valid code. Staying off the grammar is what
  keeps false positives at zero.
- **It runs in-process.** In TypeScript inside the extension host, a check is a
  function call. Spawning a process costs 30 ms even for Node, and about a
  second for SQLFluff.

## Development

```bash
npm test                                   # build + unit tests (node:test)
../databricks-sql-corpus/.venv/bin/python eval/evaluate.py   # corpus evaluation
npm run keywords                           # regenerate src/keywords.ts from ../sqlfluff
```

Every check has a case that must fire and a near-miss that must not. The
near-miss is the valid Databricks construct that looks most like the mistake.
Any change to a check has to leave the evaluation at zero errors on valid SQL.
