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
| `incomplete-block` | error | a required word is missing: `IF` / `ELSEIF` / `WHEN` with no `THEN`, `WHILE` / `FOR` with no `DO`, a `CASE` with no `WHEN`, `UNTIL cond` with no `END REPEAT`; or a `WHILE`, `FOR`, `LOOP` or `REPEAT` with no statement in its body (`WHILE c DO END WHILE`; an empty `BEGIN END` is valid) |
| `misplaced-block-word` | error | an `ELSE` or `ELSEIF` outside an `IF`, a `WHEN` outside a `CASE` statement, an `UNTIL` outside a `REPEAT`, a second `ELSE`, an `ELSEIF` / `WHEN` after the `ELSE`, a `THEN` or `DO` that starts a statement, or anything but a label after a block's `END` (`END IF 'x'`, `END SELECT 1`: a `;` is missing) |

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
  is missing **and** whose fragment has an unbalanced bracket (the user is
  still typing it); a balanced fragment with no `THEN` is `incomplete-block`;
- `REPEAT (`, which is the string function and cannot open a block, but could
  be anything the user is typing;
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
tests), so the corpus false-positive gate guards this pass very little. The
oracle is the engine instead: every script in `eval/scripting/` was run on a
Databricks SQL warehouse (channel Current, v2026.43) on 2026-11-06, by agents
that were not told what the checker does.

- `eval/scripting/valid.json`: 557 scripts the engine ran: 256 written to cover
  every statement kind, labels, handlers, nesting, CASE expressions, `if()` and
  `repeat()` as functions, keywords as names, comments, strings and layout,
  and 301 from an adversarial pass (below). The checker says nothing about any
  of them (`src/test/scripting-fixtures.test.ts`). Writing the first 256 found
  two false positives: a block labelled `if` closed by `END if`, and a variable
  named `case`.
- The adversarial pass: a stronger model read `src/blocks.ts` and tried to
  write scripts the engine runs but the checker flags. It ran 364 and found 94
  false positives, 66 in this pass and 28 in older checks. They fall into a
  few families, all fixed and all kept as fixtures:
  - a label right after `BEGIN` spelled like a transaction word
    (`BEGIN read: LOOP`) or `atomic`, and quoted labels (`` `l`: FOR ``);
  - `then`, `do`, `end`, `case`, `begin` and `when` used as names: a field
    (`x.then`, `j:do`), an alias (`AS do`), a variable (`IF then = 1 THEN`,
    `UNTIL end > 1`). The rule is that a word in a name position is a name, and
    a `CASE` counts as an opener only when an `END` closes it in the same
    fragment;
  - a handler scan that read `AS begin`, a variable called `handler`, or
    `DECLARE EXIT HANDLER` inside a one-line `BEGIN DECLARE ...` as a block;
  - older checks that did not know a scripting label can be any word
    (`LEAVE from`, `select: BEGIN`, `END LOOP with`), that a JSON key can be
    `then` or `end` (`j:then`), and that `end` can be a variable inside
    `CASE WHEN end = 1`.
  A safety net came out of it: if the token right after a `THEN` or `DO` is
  `FROM`, `WHERE`, an operator or another word no statement starts with, the
  matcher has mis-read where the body begins and gives up.
- `eval/scripting/invalid.json`: 278 scripts with one block-structure mistake
  each, with the engine's error class, plus the repaired twin of each. The
  checker says nothing about any of the 278 twins, and flags 276 of the 278
  mistakes (`src/test/scripting-invalid.test.ts`). The 2 it misses are listed
  in the file as `checker_misses`, and the test fails if one of them starts
  being caught without the list being updated, so the number only goes up.
  Engine error classes: 243 `PARSE_SYNTAX_ERROR`, 19
  `END_LABEL_WITHOUT_BEGIN_LABEL`, 16 `LABELS_MISMATCH`.

Things the engine taught, some of which the docs do not say:

- `BEGIN END` and `BEGIN ATOMIC END` are valid (the statement list is optional).
  A forbidden-pair check that called `ATOMIC END` an error was wrong and is gone.
- `END IF` after a bare `BEGIN` is parsed as an end *label* named `IF`, so the
  engine reports `END_LABEL_WITHOUT_BEGIN_LABEL`, not a syntax error. Still
  an error either way.
- An end label on a block with no begin label is an error; a nested block may
  not reuse an enclosing block's label; sibling blocks may; labels compare
  case-insensitively; `LEAVE` and `ITERATE` need a label.
- The outermost statement cannot be a labelled `BEGIN` (`lbl: BEGIN ... END lbl`
  is a syntax error; the same text nested in a block is fine). Not checked.
- `IF` and `WHILE` are not accepted as an unwrapped handler action, and `;;`,
  `BEGIN ;` and `SET VAR` inside a block are refused.
- `loop`, `end`, `repeat`, `until`, `then`, `do`, `begin`, `else` and `if` are
  all accepted as names and labels; `BEGIN TRANSACTION` and `BEGIN WORK` are
  statements, `BEGIN`, `BEGIN;` and `START TRANSACTION` are not.

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

Known gaps, each recorded so a later change can take it on. The two scripts in
`checker_misses` are the measured edge:

- a second `UNTIL` in the condition of the first (`UNTIL a UNTIL b END REPEAT`).
  Flagging it would be wrong for `UNTIL until > 1`, since `until` is a legal
  variable name;
- `DECLARE ... HANDLER FOR cond;` with no action. The handler's condition list
  and its action are not separable without a grammar;
- an unwrapped `IF` or `WHILE` as a handler's action (the engine refuses it);
- the label rules that need scope: a label on the outermost `BEGIN`,
  `LEAVE` / `ITERATE` naming no label in scope, a nested block reusing an
  enclosing label (`LABEL_OR_FOR_VARIABLE_ALREADY_EXISTS`);
- anything that needs knowing what a name is.
