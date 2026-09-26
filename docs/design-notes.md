# Design notes

Rationale that would otherwise be rediscovered. `../AGENTS.md` is the working
guide; this file is why it says what it says.

## The rule is about the failure mode, not the shape

`AGENTS.md` used to say "don't grow this into a grammar." That was shorthand,
and shorthand blocks the right change for the wrong reason. The property that
actually matters is:

> **Unrecognised input must produce silence, not a finding.** A finding requires
> positive evidence of a violation. The absence of a matching rule is not
> evidence.

A checker built that way can have productions, a recursive descent, a parse
tree — none of that is forbidden. What is forbidden is any design whose default
verdict on syntax it has not been taught is "invalid". The distinction is worth
stating precisely because both of the tempting designs fail it, and both failures
are measurable.

### Why a recogniser fails it: 58 files of published, valid SQL

A grammar is a recogniser of complete sentences, so its default on anything it
does not cover is an error. Against the corpus's 562 valid published files:

| | files it cannot parse |
| --- | ---: |
| quickcheck, as checks | **0** |
| SQLFluff 4.3.0 as released | **58** (89.7% parse) |
| SQLFluff plus every Databricks fix from this workspace | **10** (98.2% parse) |

The middle row is what a user installs. The bottom row is the best that exists
anywhere, after a merged PR batch, eight more in flight and twelve drafts of
dedicated dialect work. A grammar-backed quickcheck would fire on 10% of real
files today and, at the observed ceiling, on 1.8% — against a target of zero, on
every keystroke, in files people are paid to write.

quickcheck is at 0 not because it is cleverer but because it never has to
understand `AUTO CDC` to stay quiet about it. That is the property, and it is
the only reason the invariant is holdable while the dialect keeps moving.

### Why a learned model fails it: 21.8% of valid statements look novel

The other tempting design is statistical: learn what valid SQL looks like from
the corpus and flag what does not appear. Measured by leave-one-source-out over
depth-0 keyword bigrams -- train on twelve sources plus the must-parse cases,
test on the thirteenth:

```
held-out source             frags  flagged    rate
spark-ssb                      13       10   76.9%
dbx-devrel                     12        4   33.3%
dbx-packt-cookbook             68       20   29.4%
dbx-dlt-notebooks              49       14   28.6%
sqlfluff-sparksql             892      199   22.3%
sqlfluff-databricks           480      103   21.5%
spark-tpcds                   103       11   10.7%
spark-tpcds-modified           21        0    0.0%
TOTAL                        2128      463   21.8%
```

**One valid statement in five contains a keyword adjacency that appears nowhere
else in the corpus.** `CREATE STREAMING LIVE TABLE`, `MERGE ... AS target`,
`CREATE WIDGET TEXT catalog`, `PARQUET CLUSTERED BY` -- all valid, all unseen.
Unseen does not mean wrong; it means the corpus is finite and Databricks SQL is
not. Any rule of the form "not in my table, therefore an error" inherits that
21.8%.

The consequence is not "don't use the table". It is that **the table generates
candidates and never admits them.** See below.

## The skeleton: forbidden adjacency

The remaining structural work needs to know that `ANALYZE TABLE COMPUTE
STATISTICS` has lost its table name. Every token is a legitimate keyword, every
bracket balances, nothing dangles -- what is wrong is that *nothing sits between
`TABLE` and `COMPUTE`*.

So the unit of checking is the **ordered pair of adjacent significant tokens at
bracket depth 0 within a fragment**, with `$` standing for end of fragment. The
existing `NEEDS_FOLLOWER` is the special case where the second element is `$`.

One mechanism covers five families that looked like five separate checks:

| family | example pair | case |
| --- | --- | --- |
| truncation | `TO $`, `OF $`, `TABLE $` | `grant.without-principal` |
| missing mid-statement slot | `TABLE COMPUTE`, `FROM FILEFORMAT`, `INTO BUCKETS`, `BETWEEN AND` | `analyze-compute-statistics.without-table` |
| exclusive alternatives | `ALL DISTINCT`, `EXTENDED CODEGEN`, `TEMP EXTERNAL`, `DELETE UPDATE` | `select-clause.all-and-distinct` |
| compound-statement shape | `BEGIN LOOP`, `ATOMIC END`, `IF THEN`, `DO END` | `compound-stmt.without-body` |
| missing required modifier | `OR VIEW`, `GLOBAL VIEW`, `WITH AS` | `create-view.or-without-replace` |

Predicted yield was 63 of the 202 then-missed cases. **Delivered: 48**, because
gate 2 below rejected 21 of the 63 candidates. That gap is the design working,
not underperforming -- a mechanism that admitted all 63 would be the learned
model measured above. It is a single local check -- two tokens and a depth counter, no
productions, no recursion, no expression parsing -- so an unrecognised statement
contributes no pairs and therefore no findings. That is how it satisfies the
property above.

### How a pair is admitted

This is the part that keeps the 21.8% out. Three gates, in order, and a pair
ships only if it clears all three:

1. **Generated as a candidate.** `scripts/derive_shape_sets.py` emits pairs that
   occur in a missed must-reject case and in no valid SQL. Candidate generation
   is statistical; nothing is admitted by it.
2. **Confirmed documentarily.** The reference case carries `omits:` (what the
   docs production requires between the two words) or `conflicts:` (the two
   mutually exclusive alternatives). A pair is admitted only when that field
   names a *mandatory* slot or an exclusive pair in the page's verbatim
   `syntax:` block. The docs are the oracle; frequency is not.
3. **Vetoed by data, permanently.** The shipped pair must be absent from the 562
   valid files and the 823 must-parse cases, re-checked on every run, failing
   loudly. `spark-sql-tests` is advisory here, not binding -- see below.

So the shipped artifact is an explicit deny-list with a reason and a case id per
entry, not a learned model. Adding syntax to Databricks cannot make it fire;
only editing the list can.

Gate 2 is not a formality. It rejected **21 of the 63 candidates**, in two
kinds. `BEGIN LOOP`, `BEGIN IF`, `BEGIN WHILE` and `LOOP ITERATE` are valid
openers that looked novel only because the corpus holds few scripting cases --
their `omits:` names a `label` or a `DO` that is nowhere near the two words, so
the docs refuse them. `TABLE COMPUTE`, `CONNECTION TYPE` and `SHARE COMMENT`
failed for the other reason: the missing thing is the object's *name*, and the
following clause keyword is a plausible name for it. `ANALYZE TABLE compute
COMPUTE STATISTICS` is a table called `compute`, and nothing at this depth can
tell it from the truncated form. Those cost seven cases and were refused, not
tuned.

### What it may never do

Fixed at design time, because the boundary is what makes the check safe:

- It may check that a slot between two clause keywords is **non-empty**. It may
  never look at **what is inside** the slot. `MERGE` without `ON` is in scope;
  "is this expression a valid predicate" is out, permanently.
- It may check keyword **adjacency and order**. It may not build a statement
  model, track nesting beyond the depth counter it already has, or resolve names.
- A pair whose two words could both be identifiers in the position tested is
  refused, not tuned. Spark lets nearly every keyword be a name.

Cases needing more than this -- `column_comment`, `data_type`, `expr`,
`default_expression` omissions, roughly 90 of the 395 -- stay SQLFluff's, by
design and forever. The honest ceiling for must-reject is about **280/395
(~70%)**, from 241 today -- most of the remaining headroom is now spent.

## The veto corpus has two kinds of source, and they are not interchangeable

`spark-sql-tests` deliberately contains invalid SQL. `derive_shape_sets.py`
currently lets it veto candidates, and four of those vetoes are provably wrong,
because the reference corpus labels the identical shape must-reject:

| veto from spark-sql-tests | contradicted by |
| --- | --- |
| `SELECT * EXCEPT ( ) name` | `star.except-empty` |
| `RETURNS TABLE ( )` | `create-function.empty-returns-table` |
| `tablesample ( )` | `tablesample.without-sample` |
| `SHOW TABLE EXTENDED` | `explain.extended-without-statement` |

Make those vetoes advisory: print them, and fail only when no must-reject case
contradicts. `spark-sql-tests` is excellent at what it was added for -- running
the checks over it to surface false positives -- and unfit as a validity oracle,
which it was never meant to be.
