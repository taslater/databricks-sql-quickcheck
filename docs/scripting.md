# SQL scripting block structure

Rung 5 of [scope.md](scope.md). `src/blocks.ts`, called from `check()`.

## What it checks

A scripting block is opened in one `;`-separated fragment and closed in
another, and every other check looks at one fragment alone. This pass walks the
fragments of each notebook cell in order, keeps a stack of the blocks it has
seen open, and matches each closer against the top of the stack.

| code | severity | fires on |
| --- | --- | --- |
| `unclosed-block` | error | a block still open when the cell ends: `BEGIN SELECT 1;` |
| `mismatched-block` | error | a closer that is not the open block's: `IF ... THEN ...; END`, `WHILE ... DO ...; END IF`, `REPEAT ...; END REPEAT` with no `UNTIL`, `END LOOP other` after `lbl: LOOP` |
| `unmatched-block` | error | a closer with no open block: `BEGIN SELECT 1; END; END` |

Every one is an error because the engine rejects each of them (below). After
the first one in a cell the pass stops: a stack that has already disagreed with
the script cannot be trusted to place the next report.

The openers and their closers:

| opener | closer |
| --- | --- |
| `[label:] BEGIN [ATOMIC]` | `END [label]` |
| `IF cond THEN` (then `ELSEIF cond THEN`, `ELSE`) | `END IF` |
| `[label:] WHILE cond DO` | `END WHILE [label]` |
| `[label:] LOOP` | `END LOOP [label]` |
| `[label:] REPEAT` ... `UNTIL cond` | `END REPEAT [label]` |
| `[label:] FOR [v AS] query DO` | `END FOR [label]` |
| `CASE [expr] WHEN cond THEN` (then `WHEN`, `ELSE`) | `END CASE` |

## Why a pass over the fragments, and why a stack

The alternatives were worse. Counting openers against closers cannot tell a
wrong closer from a right one. A grammar for the scripting statements would be
the thing `design-notes.md` rules out. A stack is the least that recognises
"this closer belongs to a different block than the one that is open", and that
is exactly the mistake in three of the four cases in the issue.

## Silence by default

The pass reads a fragment only at positions where a statement can start: the
fragment's first token, and the position after a `THEN`, `DO`, `ELSE`,
`label:`, `ATOMIC` or `UNTIL cond` it has itself recognised. At anything it
does not fully understand it **gives up for the rest of the cell**, so it never
reports from a half-understood stack. It gives up on:

- a `BEGIN` with nothing after it (`BEGIN;` is not a block; the engine rejects
  it, but a transaction form could look like it), and any `BEGIN`, `LOOP`,
  `WHILE` or `REPEAT` in a position where no statement starts;
- an `IF`, `WHILE`, `FOR` or `CASE` at a statement start whose `THEN` or `DO`
  it cannot find;
- `REPEAT (`, which is the string function and cannot open a block, but could
  be anything the user is typing;
- an `ELSE`, `ELSEIF` or `WHEN` outside the block it belongs to (those are
  mistakes too, but not ones this pass reports yet);
- anything after a closer on the same fragment other than its label;
- `DECLARE ... HANDLER` whose action is a block statement other than `BEGIN`;
- a lexical error anywhere in the file (an unterminated string or comment): the
  tokens after it are not reliable, so no block is judged at all.

## The traps, and how each is handled

Every one of these is valid SQL and has a fixture that must stay quiet.

| trap | handling |
| --- | --- |
| `END` closes a `CASE` **expression** too | the scan for a statement's `THEN`/`DO`/`UNTIL`/`END REPEAT` steps over `CASE ... END` expressions, so `IF CASE WHEN a THEN b END THEN` finds the right `THEN` |
| `IF` is also a function: `if(a, b, c)` | an `IF` is read as an opener only at a statement start and only when a `THEN` follows at bracket depth 0 |
| `repeat('x', 3)` is a string function | `REPEAT` followed by `(` is never an opener |
| `IF NOT EXISTS`, `IF EXISTS` | they sit mid-statement, never at a statement start |
| `BEGIN TRANSACTION`, `BEGIN WORK` | not a block; the engine accepts them standalone |
| `lbl: LOOP ... END LOOP lbl`, and a label named like a keyword | `word :` before a labelled opener is read as the label, so `loop: LOOP` and `if: BEGIN ... END if` work; the word after `END` is the block's label when it equals the open block's label |
| block words in strings, comments and quoted names | they are not tokens |
| block words as aliases and variable names (`AS loop`, `DECLARE until INT`) | a name after `AS` is skipped; the engine accepts these, and a bare use mid-statement makes the pass give up rather than guess |
| `CREATE PROCEDURE p() ... AS BEGIN ... END` | the body opens inside the statement: for a `CREATE ... PROCEDURE` the first depth-0 `BEGIN` is the body. `CREATE VIEW v AS SELECT 1 AS begin` is left alone |
| `DECLARE ... HANDLER FOR c BEGIN ... END` | the handler's `BEGIN` opens a block |
| a notebook cell boundary | each cell is checked on its own, so an opener in one cell and a closer in the next are not matched |
| a variable named `case`: `VALUES (case)` | `CASE` directly before `)` or `,` is not an open expression (an older check, `case-without-end`, flagged it) |

## Evidence

The published corpus holds no scripting at all (the only `END IF` text in its
867 files is commented-out PL/pgSQL in three of Spark's PostgreSQL-flavoured
tests), so the corpus false-positive gate guards this pass very little.
The oracle is the engine instead: every script in `eval/scripting/` was run on
a Databricks SQL warehouse (channel Current, v2026.43) on 2026-11-06.

- `eval/scripting/valid.json`: scripts the engine ran successfully. The checker
  must say nothing about any of them (`src/test/scripting-fixtures.test.ts`).
- The `rejected` list in the same file: scripts the engine refused.

The four cases in the issue, and the other mistakes, as the engine rejects
them:

| script | engine |
| --- | --- |
| `BEGIN IF 1 = 1 THEN SELECT 1; END` | `PARSE_SYNTAX_ERROR` at end of input |
| `BEGIN WHILE true DO SELECT 1; END IF; END` | `PARSE_SYNTAX_ERROR` at `IF`: missing `WHILE` |
| `BEGIN SELECT 1;` | `PARSE_SYNTAX_ERROR`: missing `END` |
| `BEGIN REPEAT SELECT 1; END REPEAT; END` | `PARSE_SYNTAX_ERROR` at `END`: missing `UNTIL` |
| `BEGIN lbl: LOOP LEAVE lbl; END LOOP other; END` | `LABELS_MISMATCH` |
| `BEGIN SELECT 1; END END` | `PARSE_SYNTAX_ERROR`: extra input `END` |
| `BEGIN SELECT 1; END IF` | `PARSE_SYNTAX_ERROR`: extra input `IF` |

## Not checked yet

Known gaps, each recorded so a later change can take it on:

- an `ELSE` after an `ELSE`, an `ELSEIF` or `WHEN` outside its block (the pass
  gives up silently on these);
- a missing `THEN`, `DO` or `UNTIL`-less `END REPEAT` shapes other than the one
  reported;
- an end label on an unlabelled block, a label on the outermost `BEGIN` (the
  engine refuses it), `LEAVE`/`ITERATE` naming no label in scope, and a nested
  block reusing an enclosing label (`LABEL_OR_FOR_VARIABLE_ALREADY_EXISTS`);
- anything that needs knowing what a name is.
