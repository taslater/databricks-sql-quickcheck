# Contributing

quickcheck is a fast syntax checker for Databricks SQL that runs on every
keystroke. The standard is unusual, so please read the rules below before
opening a PR. For what is in and out of scope, see
[`docs/scope.md`](docs/scope.md).

## The rules

**1. Never share SQL you do not have the right to publish.** That means SQL
from your employer, a client or any private codebase: not in an issue, a PR, a
test, a commit message or a comment. A bug found in real SQL gets reduced to a
small repro written from scratch before it comes here. Table and column names
like `t`, `a` and `b` are ideal. Everything in this repository is permanent
public history, and a leaked query cannot be taken back. Issues or PRs that
break this rule are deleted, not edited.

**2. An error must never fire on valid SQL.** A false positive is the most
serious bug this project can have. A check that causes one is reverted rather
than tuned. False-positive reports are always worked first.

**3. Silence is the default.** A finding needs positive evidence that the SQL
is wrong. SQL that the checker does not recognise, or has never seen, must
produce nothing. [`docs/design-notes.md`](docs/design-notes.md) explains why,
with measurements.

**4. A check gets in through three gates.** This applies to every new rule and
every new entry in a deny-list:

1. *Evidence:* a case the checker misses, taken from the reference corpus or
   the mutation corpus.
2. *The docs:* the Databricks SQL reference says the shape is invalid.
   Link the page. "It never appears in the corpus" is not evidence.
3. *The data:* no finding on any valid file or must-parse case in the
   corpus. CI enforces this.

**5. Every check ships with two tests:** a case that must fire, and the valid
construct that looks most like the mistake, which must stay quiet.

**6. Keep it fast.** It runs inside the editor on every keystroke, so nothing
may slow the per-file check noticeably. That rules out network calls, runtime
dependencies and anything quadratic.

## Running the checks

```bash
npm ci
npm test                        # typecheck plus unit tests

# The false-positive gate. It needs a checkout of the public corpus next to
# this one, with its sources fetched:
git clone https://github.com/taslater/databricks-sql-corpus ../databricks-sql-corpus
(cd ../databricks-sql-corpus && make venv && make corpus-fetch)
../databricks-sql-corpus/.venv/bin/python eval/evaluate.py   # exits 1 on any false positive
../databricks-sql-corpus/.venv/bin/python scripts/derive_shape_sets.py
```

CI runs both on every PR.

## Reporting a bug

Use an issue template. For a false positive, include the smallest valid SQL
that triggers it, written from scratch (see rule 1), and why it is valid,
ideally with a link to the Databricks docs. For a missed error, include the
smallest invalid SQL and the docs saying why it is invalid. Before filing a
missed error, check `docs/scope.md`: semantics (unknown tables and columns,
types, argument counts), runtime versions and style are out of scope on
purpose. A slot filled with the wrong thing is in scope only as a closed
constraint the docs rule out, such as `a BETWEEN 1 OR 5`.

## AI-assisted contributions

These are welcome. Say so in the PR. You are responsible for every line, and
for having run the gates above yourself.

## Licence and money

Contributions are accepted under the MIT licence. The project is not
monetised: no sponsorship, paid support or paid features.
