# Changelog

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
