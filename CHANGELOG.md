# Changelog

## 0.4.0 (2026-11-06)

- **SQL scripting block structure** (#11). A new pass matches block openers and
  closers across statements: a missing `END`, `END IF`, `END WHILE` or `UNTIL`,
  a closer for the wrong block, a stray `END`, a label that does not match, a
  missing `THEN` or `DO`, an `ELSE`/`ELSEIF`/`WHEN`/`UNTIL` out of place, and a
  block left open when a notebook cell ends. Every one is an error because a
  Databricks SQL warehouse rejects each. The design, and the traps it has to
  stay quiet on, are in `docs/scripting.md`.
- **A query bracket right after a subquery's alias** is an error (#5):
  `(SELECT a FROM t) x (SELECT b FROM u) y`. After an alias the only bracket
  allowed is the column alias list, so a comma went missing.
- **Two numbers with nothing between them** are an error (#6):
  `IN (2, 3, 5 7)`, `SELECT 1 2`, `1.2.3`. Digit-leading names such as
  `2012_s` are not numbers and stay quiet.
- **Three names in a row in a FROM list** are a warning (#7):
  `FROM store_returns, date_dim d1, date_dim d2 date_dim d3, store`.
  Keyword aliases, time travel, `TABLESAMPLE` and qualified names stay quiet.
- **Fixed a false positive on `BEGIN ATOMIC END`.** It was reported as a block
  with no statements; the engine accepts it, and `BEGIN END`.
- **Fixed false positives on scripting labels and keyword-like names**: a
  label that is a keyword (`LEAVE from`, `select: BEGIN`), a JSON key named
  `then` or `end` (`j:then`), a variable named `end` inside `CASE WHEN end = 1`
  or `IF then = 1`, and a variable named `case`, as in `VALUES (case)`.

## 0.3.1 (2026-11-06)

- **Fixed a false positive on `IS [NOT] DISTINCT FROM`.** The `FROM` of the
  operator was read as a query clause with no `SELECT` before it, so
  `WHEN MATCHED AND (t.a IS DISTINCT FROM s.b)` in a `MERGE`, and the same
  inside any bracket after `AND`, `OR`, `ON` or `IN`, was reported as an error.
  Reported and fixed by Paul Sedra (#43, #44).

## 0.3.0 (2026-11-02)

The first release on the Visual Studio Marketplace.

- **A Databricks SQL language mode.** A `databricks-sql` language whose
  grammar ends strings, comments and `$$` bodies where Databricks does: a
  backslash escapes (`'it\'s'`), raw strings take backslash literally
  (`r'C:\'`), comments nest, and nothing runs past a notebook cell boundary.
  `$$` bodies are coloured as Python or YAML after `LANGUAGE PYTHON` or
  `LANGUAGE YAML`, and `-- MAGIC %md` and `-- MAGIC %python` cells as markdown
  and Python. Exported notebooks open in the mode automatically
  (`databricksSqlQuickcheck.detectNotebooks`).
- **Truncated statements** (`ALTER VIEW v RENAME TO`, `DROP SCHEMA`) and
  **empty clause lists** (`SET DBPROPERTIES ()`).
- **Forbidden keyword pairs**: exclusive alternatives written together
  (`SELECT ALL DISTINCT`), a mandatory slot left empty (`GRANT ON`), a missing
  modifier (`CREATE OR VIEW`).
- **Exclusive alternatives that are not adjacent**: `NATURAL JOIN ... ON`,
  `GRANT ALL PRIVILEGES, SELECT`, `COPY INTO` with both `FILES` and `PATTERN`,
  and a function with both `RETURN` and a `$$` body.
- **A query that lost its `SELECT` or its `WHERE`** (`FROM (a, b FROM t)`,
  `FROM a, b x = y`), and **a missing comma between CTEs**.

## 0.2.0 (2026-09-25)

- Statement-shape checks: keyword typos with positional evidence (`FORM`,
  `GROPU BY`, `LEFT JION`), a missing `;` between statements, missing commas
  in column definitions, clause order, `CASE` structure and dangling keywords.

## 0.1.0 (2026-09-25)

- Structural checks as you type: strings, identifiers, comments, `$$` bodies
  and templates that never close; unclosed and mismatched brackets, including
  inside optimizer hints; doubled, leading and trailing commas; dangling
  operators; `CASE` without `END`; and missing commas in select lists, `BY`
  lists and call arguments. Notebook cell separators are hard boundaries.
