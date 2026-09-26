# databricks-sql-quickcheck

Instant, as-you-type syntax checks for Databricks SQL.

This is the fast, shallow tier of checking, the SQL equivalent of what
pyflakes is to pylint. It does not parse your SQL against the full Databricks
grammar. It lexes the text and checks the shape of each statement. That covers
brackets and quotes that never close, and mistyped keywords (`FORM`, `GROPU BY`,
`CRATE TABLE`). It also covers commas missing between columns, a `;` missing
between statements, `WHERE` after `GROUP BY`, a `CASE` with no `THEN`, and a
dangling `AND`. It runs inside the VS Code extension host with no child
process, taking about 0.1 ms on a typical file. That's fast enough to re-check
on every keystroke.

Use it alongside SQLFluff, not in place of it. SQLFluff checks the full grammar
and belongs on save or in CI. Quickcheck catches the typos while you're typing
them.

```text
$ dbsql-quickcheck examples/mistakes.sql
examples/mistakes.sql:6:1: error [missing-semicolon] Missing `;` before this CREATE? The statement above has not ended.
examples/mistakes.sql:10:3: error [missing-comma] Missing comma before `event_time`? It starts a new column definition.
examples/mistakes.sql:11:21: error [keyword-typo] `COMENT` is not valid here. Did you mean COMMENT?
examples/mistakes.sql:19:3: warning [alias-on-new-line] `event_time` on its own line is read as an alias of the expression above it. Missing comma? (Write `AS event_time` if the alias is intended.)
examples/mistakes.sql:23:1: error [keyword-typo] `FORM` is not valid here. Did you mean FROM?
examples/mistakes.sql:29:1: error [clause-order] WHERE must come before GROUP BY
examples/mistakes.sql:33:13: error [case-structure] WHEN has no THEN
examples/mistakes.sql:36:11: error [unclosed-bracket] `(` is never closed
examples/mistakes.sql:40:30: error [dangling-keyword] AND has nothing after it
examples/mistakes.sql:42:71: error [keyword-typo] `LIMT` is not valid here. Did you mean LIMIT?
```

Open [examples/mistakes.sql](examples/mistakes.sql) in VS Code to see the same
findings as you type.

## What it checks

There are two severities, and the line between them is deliberate.

- An **error** is something no Databricks grammar can accept. The corpus
  evaluation below holds errors to zero false positives.
- A **warning** is almost certainly a mistake, but one that Spark's lenient
  keyword handling might technically accept, or valid SQL that silently does
  the wrong thing. You can turn warnings off.

| code | severity | example |
| --- | --- | --- |
| `keyword-typo` | error | `SELECT a FORM t`, `GROPU BY`, `CRATE TABLE`, `IS NUL`, `LEFT JION`, `CASE WEHN`, `AS SELCT`, `SHOW TABELS` |
| `missing-semicolon` | error | `CREATE CATALOG c` then `CREATE SCHEMA s` on the next line; `SET k = v` then a `SELECT` that Spark would read as part of the value |
| `missing-comma` | error | between column definitions: `id STRING COMMENT 'x'` then `ts BIGINT` |
| `clause-order` | error | `GROUP BY a WHERE b`, `LIMIT 10 ORDER BY a`, a second `WHERE` |
| `case-structure` | error | `CASE WHEN a 'x' END` (no THEN), `ELSE` before `WHEN`, a second `ELSE` |
| `dangling-keyword` | error | `WHERE a > 1 AND;`, `WHERE GROUP BY`, `SELECT FROM t`, `JOIN ON` |
| `operator-typo` | error | `a =< 1`, `a => 1` outside a function call |
| `unterminated-string` / `-identifier` / `-comment` / `-body` / `-template` | error | `WHERE s = 'active`, `` `col ``, `/* …`, `AS $$ …`, `{{ p` |
| `unclosed-bracket` / `unmatched-bracket` / `mismatched-bracket` | error | `count(*`, `a)`, `f(a]` (also inside `/*+ hints */`) |
| `double-comma` / `leading-comma` / `trailing-comma` | error | `a,, b`, `f(, a)`, `(a INT, b INT,)` |
| `missing-operand` | error | `a + )`, `a = = b`, `(= b)`, `WHERE y >` |
| `case-without-end` | error | `CASE WHEN a THEN 1 ELSE 0 AS flag` |
| `missing-comma` | warning | in queries: `SELECT id name email`, `GROUP BY a b`, `coalesce(a b)`, `SELECT a b(c)` |
| `alias-on-new-line` | warning | `first_name` then `last_name` on the next line. This is valid SQL that aliases one column as the other, which is the classic silent missing comma. |
| `comma-before-clause` | warning | `SELECT a, b, FROM t` |
| `unknown-statement` | warning | a statement starting with a word that starts no Databricks statement |
| `string-swallows-code` | warning | a string with a missing closing quote pairs with an apostrophe in a later comment, so the quotes balance and the SQL in between is swallowed into the string |
| `implicit-alias` | warning, opt-in | `SELECT a b, c`. Off by default; see below. |

**How typo detection avoids false alarms.** Databricks lets almost any keyword
be a column name, so a word being one letter off a keyword proves nothing. A
typo is reported only where the position rules out a name, for example:

- `FORM` in `SELECT a FORM t` sits between two complete operands, where only a
  keyword can go.
- `ORDRE BY` is followed by `BY`, which only ever follows a keyword.
- `JION` comes after `LEFT`, whose next word is fixed.

A column called `form` or `pull` never fires.

It understands the things real Databricks files contain that would otherwise
trip a naive checker:

- **Notebook format.** Checking stops at each `-- COMMAND ----------` cell
  separator, so one missing quote can't turn every later cell red. `-- MAGIC`
  cells are comments, a cell that opens with `%python`, `%md` or `%run` is
  skipped whole, and a leading `%sql` line is skipped.
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

It deliberately doesn't know the full grammar. A statement that is
well-shaped but leaves out a required clause is SQLFluff's to catch. An example
is `CREATE FLOW f AS INSERT INTO t` with no query.

Two everyday mistakes it can't report by default, because the result is valid
SQL:

- **A comma deleted between two columns on one line.** `SELECT a, b, c` becomes
  `SELECT a b, c`, which aliases `a` as `b`. About one real file in ten aliases
  columns this way on purpose (`l.l_quantity num_parts`), so a default warning
  would be noise. If your team writes `AS` for every alias, turn on
  `databricksSqlQuickcheck.explicitAliases` (CLI: `--explicit-aliases`), and
  every such lost comma is reported.
- **A typo that happens to form a table alias.** `FROM t LFET JOIN u` reads as
  table `t` aliased `LFET`, joined to `u`.

## How well it works

`eval/evaluate.py` measures quickcheck against
[databricks-sql-corpus](https://github.com/taslater/databricks-sql-corpus), in
both directions. These figures are from 2026-09-26:

| | result |
| --- | --- |
| Valid corpus: 561 files from 13 sources (Databricks notebooks, TPC-DS/TPC-H/SSB, SQLFluff's sparksql and databricks fixtures) | **0 errors, 0 warnings** |
| Reference must-parse cases, transcribed from the Databricks SQL docs | **823 / 823 clean** |
| **Everyday mistakes** made in those clean files: one keyword typo per file (a swapped, dropped or doubled letter) | **494 / 518 flagged (95%)** |
| Everyday mistakes: one `;` deleted between statements | **224 / 239 flagged (94%)** |
| Everyday mistakes: one comma deleted between column definitions | **50 / 52 flagged (96%)** |
| Guaranteed-invalid mutants from the corpus's `mutate.py` (brackets, quotes, commas, operators) | **2596 / 2597 errors (100.0%)**; the last one is caught as a `string-swallows-code` warning |
| `mutate.py` weak mutants (deleted comma or keyword, dangling `AND`/`OR`) | 44% / 54% / 100% flagged (4% / 24% / 100% as errors); many deleted commas leave valid SQL |
| Reference must-reject cases, all | 241 / 395; about 110 need a full grammar and are out of scope ([scope](docs/scope.md)) |
| Reference must-reject cases a shallow checker can reach | **189 / 233 (81%)** |
| Spark's own SQL test suite, 304 files of unusual syntax | 7 errors, each checked by hand: all real, and most sit under the file's own negative-test heading |
| Speed over the valid corpus (1.1M characters) | 115 ms total; median 0.12 ms per file, p95 0.7 ms, max 2.0 ms |

The everyday mistakes aren't all guaranteed to be invalid. For example,
`LFET JOIN` reads as a table alias. So they are reported rather than scored.
One file in the valid sources is broken as published: `Chapter08/Clean Up.sql`
has `USE CATALOG ${catalog}` with no `;` before the next statement. The corpus
records it in `docs/gaps.md`, and SQLFluff rejects it too, so the evaluation
scores it the other way round: quickcheck must flag it, and does.

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
| `databricksSqlQuickcheck.explicitAliases` | `false` | warn on every implicit column alias, so a comma lost on one line is reported |

### Command line

```bash
npm install && npm run build
node out/cli.js path/to/file.sql path/to/dir/     # or `npm link` for dbsql-quickcheck
```

The CLI exits 1 on any error, or on warnings too with `--strict`, so it drops
into a pre-commit hook. Other flags are `--no-warnings`, `--explicit-aliases`,
`--json`, `--stdin` and `--jsonl` (batch mode: `{"id","text"}` lines in, one
result line out).

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
  right. On top of that it knows the shape of a statement (which words start
  one, which order clauses come in, what a `CASE` needs), and nothing about any
  single statement's full syntax.
- **Tree-sitter was considered and rejected.** It's the standard for this job
  in editors, but no grammar tracks Databricks SQL closely, and a grammar that
  lags produces red squiggles on valid code. Staying off the grammar is what
  keeps false positives at zero.
- **It runs in-process.** In TypeScript inside the extension host, a check is a
  function call. Spawning a process costs 30 ms even for Node, and about a
  second for SQLFluff.

## Scope

[`docs/scope.md`](docs/scope.md) sorts SQL mistakes by how much information it
takes to know they are wrong, and says which ones a shallow checker can ever
flag. Work in progress is tracked in the issues against that ladder.

## Development

```bash
npm test                                   # build + unit tests (node:test)
../databricks-sql-corpus/.venv/bin/python eval/evaluate.py   # corpus evaluation
npm run keywords                           # regenerate src/keywords.ts from ../sqlfluff
```

Every check has a case that must fire and a near-miss that must not. The
near-miss is the valid Databricks construct that looks most like the mistake.
Any change to a check has to leave the evaluation at zero errors on valid SQL.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The first rule is the one that
matters most: never paste SQL you are not allowed to publish. Reduce it to a
repro written from scratch first.
