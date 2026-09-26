<!-- Read CONTRIBUTING.md first. It is short, and rule 1 is not negotiable. -->

## What and why

## Checklist

- [ ] No SQL here that I am not allowed to publish (CONTRIBUTING.md, rule 1)
- [ ] Each new check has a test that must fire and a test for the nearest valid construct
- [ ] Each new deny-list entry links the Databricks docs page that makes the shape invalid
- [ ] `npm test` passes
- [ ] `eval/evaluate.py` reports 0 false positives (CI runs it too)
- [ ] `docs/scope.md` numbers updated if a measured number moved
- [ ] AI assistance, if any, is disclosed above
