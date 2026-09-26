# Scope: what a shallow checker can flag

This is the reference for deciding whether a kind of SQL mistake is worth
chasing. It sorts errors by the one thing that decides it: **how much
information you need to know the SQL is wrong.** Issues carry an `area:` label
matching a rung below. A request on a rung marked out of scope is closed with a
link here, not debated again.

The numbers move; the ladder should rarely change. When a number moves, update
it here in the same PR.

## What this checker knows, and what it never will

It runs on every keystroke, so it gets tokens, bracket depth, a statement's
first keyword, each token's neighbours, and a fixed set of facts transcribed
from the Databricks SQL reference. It has no grammar for what goes *inside* a
clause, no catalog, no idea which runtime version will execute the SQL, and no
way to expand a `${template}`.

Two rules bound everything below. They are in `AGENTS.md`, and the evidence
for them is in `docs/design-notes.md`:

- **An error must never fire on valid SQL.** A false positive is a bug,
  whatever the rung.
- **Unrecognised input must produce silence, not a finding.** A finding needs
  positive evidence of a violation. The absence of a matching rule is not
  evidence.

## The ladder

| # | Kind of mistake | What it takes to know | Verdict | Where it stands |
| --- | --- | --- | --- | --- |
| 1 | **Lexical**: unterminated string, comment or quoted identifier | the tokens | in scope | done: 100% of mutants |
| 2 | **Brackets and pairs**: unbalanced or mismatched brackets, `CASE` without `END` | a depth counter | in scope | done: 100% of mutants |
| 3 | **Operands owed**: `a,,b`, `x =`, `WHERE` with nothing after it, `a::` | the next token | in scope | done: dangling operators 100%; truncated statements 142/174 |
| 4 | **Local shape**: exclusive alternatives, an empty mandatory slot between two keywords, an empty required list, keyword typos, a missing `;`, a query that lost its `SELECT` or `WHERE` | neighbours, the statement lead, and deny-lists confirmed against the docs | in scope, with the admission gates | mostly done; the long tail is tracked |
| 5 | **Block structure across statements**: SQL scripting `BEGIN`/`END`, `IF`/`END IF`, `WHILE … DO`/`END WHILE`, `REPEAT … UNTIL` | keyword matching across `;` boundaries | **difficult, possible** | not started: 0 detected |
| 6 | **Statement skeletons**: `MERGE` without `ON`, `COPY INTO t FROM FILEFORMAT = CSV`, `ANALYZE TABLE` without a table | each statement's required clause keywords, derived from the docs | **difficult, possible**, with a hard limit below | not started |
| 7 | **Slot contents**: a filled slot holding the wrong thing -- `a BETWEEN 1 OR 5`, `a IS 5`, `MAP<STRING>`, `DECIMAL(10, 2, 3)` | a constraint the docs close off, and a way to find the construct inside an expression | **difficult, possible for closed constraints only**; a general validator stays out | not started; needs an evidence source first |
| 8 | **Semantics**: unknown table or column, wrong argument count, type mismatch, ambiguous reference | the catalog and the type system | **out of scope** | not a syntax question |
| 9 | **Version**: syntax that a given Databricks Runtime or SQL warehouse release does not support yet | the runtime that will execute it | **out of scope** | |
| 10 | **Style and conventions**: naming, formatting, team rules | a team's policy | **out of scope** | `sqlfluff-plugin-conventions` |

Rungs 1 to 4 are where the checker is today. Rungs 5 to 7 are the difficult
but possible goals, and the reason to keep going. Rungs 8 to 10 are not goals
at any effort level: the information is not in the SQL text, or the question
is not about syntax.

**Rung 7 is split down the middle, and the split is the same one that runs
through the whole design.** *Rejecting* a specific shape the docs rule out is
in scope, exactly as on rung 4: `BETWEEN`'s partner is `AND`, `IS` takes one
of a fixed set of words, `MAP` takes two types, `DECIMAL` at most two numbers.
Each is a closed constraint, and a violation of it is positive evidence.
*Validating* a slot -- accepting only contents known to be good -- is writing a
grammar, and a grammar's default verdict on syntax it does not know is
"invalid". That half stays out: SQLFluff as released cannot parse 58 of the
corpus's 562 valid published files. So rung 7 is never complete, which is
also true of rung 4.

What makes rung 7 harder than rung 4:

- **Only closed constraints qualify.** "Is this a valid expression?" in
  general has no deny-list answer.
- **The construct is harder to find.** Inside an expression there is nesting,
  precedence (the `AND` that belongs to `BETWEEN` against a boolean `AND`),
  `CASE`, and words with two jobs. `IS` is closed in an expression but takes a
  string in `COMMENT ON TABLE t IS '...'`, which a first draft of the `IS` rule
  fired on 19 times in the corpus. `map(...)` is a function and `MAP<...>` a
  type.
- **There is no evidence source yet.** Every reference must-reject case is
  made by deleting part of a valid statement, and `mutate.py` deletes or
  duplicates. Neither produces a slot filled with the wrong thing, so the first
  step is a source of such cases, before any check.
- **Its value is earliness.** SQLFluff catches most of these on save. What
  quickcheck adds is catching them as you type, plus the ones SQLFluff misses
  (it accepts `DECIMAL(10, 2, 3)`).

## Undecidable at this depth: the refusals

Even on rungs 4 to 6, some cases cannot be told apart from valid SQL with the
information this tier has. They are refused, not tuned. Each one below is a
real case that came up while building the checks:

- **A keyword where a name goes.** Databricks lets nearly any keyword be an
  identifier. `DROP VIEW view` drops a view called `view`, and `ANALYZE TABLE
  compute COMPUTE STATISTICS` analyzes a table called `compute`. So when the
  missing thing is a *name* and the keyword after it could be that name, the
  truncated form and the valid form look identical. This is the hard limit on
  rung 6.
- **Unseen is not invalid.** 21.8% of valid statements contain a keyword
  pair found nowhere else in the corpus. Nothing is flagged just for being
  unfamiliar; every deny-list entry needs the docs to say it is wrong.
- **Valid but surprising.** `SELECT 1 WHERE true` (`FROM` is optional), `'VA'
  'TX'` (adjacent string literals concatenate), `SELECT a b` (an implicit
  alias, which only ever warns).
- **Text Spark does not parse as SQL.** `${template}` placeholders expand to
  unknown text. `SET key = value` passes its value through as raw text.
- **An unknown statement lead.** It warns and never errors, because Databricks
  ships new statements and the checker must not fire on the next one.
- **The body after `CREATE … AS`.** `CREATE FLOW f AS AUTO CDC INTO t FROM s`
  has a `FROM` and no `SELECT`, and is valid.

## The ceilings, measured

As of 2026-09-26, against `databricks-sql-corpus`:

| Measure | Now | Realistic ceiling | What is between them |
| --- | --- | --- | --- |
| Reference must-reject cases, all | 241/395 | **not yet known** | 154 missed; most are rungs 3 to 6, not rung 7 (see below) |
| Reference must-reject, structural target | 189/233 (81.1%) | most of the rest | rung 6 and the refusals above |
| `delete-keyword` mutants, errors | 107/451 | not yet estimated | most of what is left loses its `SELECT` at the start of a statement, which warns by design |
| `delete-comma` mutants | 24 errors, 128 warnings of 294 genuinely invalid | not yet estimated | 118 of the 433 are still valid SQL; the missing comma between CTEs is caught, and more silent ones are catchable and tracked |
| Scripting blocks | 0 | most block-structure mistakes | rung 5, not started |
| False positives on 562 valid files and 823 must-parse cases | 0 | 0 | this is a gate, not a goal |
| Check time per file | median about 120 µs, max 2 ms | stay under a keystroke | also a gate |

**The reference corpus barely measures rung 7.** An earlier version of this
file put about 110 of its missed cases on rung 7 and called them permanently out
of reach. That count came from the cases' labels, not their SQL. Read case by
case, they are mostly empty slots and missing keywords: `CACHE SELECT a, FROM
boxes` (rung 3), `CREATE EXTERNAL LOCATION l URL WITH (...)` (rung 4), `CREATE
CONNECTION c OPTIONS (...)` with no `TYPE` (rung 6), `BEGIN CASE ...` with no `END
CASE` (rung 5). That follows from how the corpus is built: deleting something
leaves a gap, not a wrong filling. The real ceiling waits on triaging those
cases rung by rung.

**The mutation oracle can be wrong in both directions.** SQLFluff accepts
`EXISTS (* FROM u)`, which is invalid, and rejects `IN ('VA' 'TX')`, which is
valid. So a disagreement between quickcheck and SQLFluff needs a tiebreak (the
docs, then sqlglot, whose rejections carry signal because it is lenient)
before it counts either way.

## How a check gets in

This applies from rung 4 up. The detail is in `CONTRIBUTING.md`:

1. **Generate** candidates from data: a missed must-reject case, or a mutant
   that is genuinely invalid.
2. **Confirm against the docs.** The page's syntax block must say the shape is
   wrong. Frequency never admits anything.
3. **Veto by data, forever.** The check must be silent on every valid corpus
   file and must-parse case, re-checked in CI.

Every check ships with a test that must fire and a test for the nearest valid
construct, which must stay quiet.
