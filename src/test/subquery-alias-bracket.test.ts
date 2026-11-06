// A query bracket directly after an alias: `(SELECT ...) x (SELECT ...)`.
// After an alias only a column alias list may follow, and SELECT, WITH and
// VALUES cannot be column names. The near-misses are the valid constructs
// that put a bracket after a name or after an alias.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { check } from "../check";

function found(sql: string): string[] {
  return check(sql).map((d) => `${d.code}@${d.line}:${d.column}`);
}

function clean(sql: string): void {
  assert.deepEqual(check(sql), [], `expected no findings for:\n${sql}`);
}

describe("subqueryAliasThenQuery", () => {
  it("fires when a query bracket follows an alias", () => {
    // Each column is the `(` of the query bracket after the alias.
    assert.deepEqual(found("SELECT * FROM (SELECT a FROM t) x (SELECT b FROM u) y"), ["missing-comma@1:35"]);
    assert.deepEqual(found("SELECT * FROM (SELECT 1) x (VALUES (1)) y"), ["missing-comma@1:28"]);
    assert.deepEqual(found("SELECT * FROM (SELECT 1) x (WITH c AS (SELECT 1) SELECT * FROM c)"), ["missing-comma@1:28"]);
    assert.deepEqual(found("SELECT * FROM (SELECT 1) `x` (SELECT 2)"), ["missing-comma@1:30"]);
  });

  it("stays quiet on a column alias list after a subquery", () => {
    clean("SELECT * FROM (SELECT a FROM t) x (a, b)");
    clean("SELECT * FROM (SELECT a FROM t) AS x (a, b)");
    clean("SELECT * FROM (SELECT 1) AS x (a)");
  });

  it("stays quiet on a column alias list after a table", () => {
    clean("SELECT * FROM t AS x (a, b)");
    clean("SELECT * FROM t x (a, b)");
  });

  it("stays quiet on a table-valued VALUES before its alias", () => {
    clean("SELECT * FROM (VALUES (1, 2)) AS t(a, b)");
    clean("SELECT * FROM (VALUES (1, 2)) t");
  });

  it("stays quiet on a TABLESAMPLE bracket after an alias", () => {
    clean("SELECT * FROM t TABLESAMPLE (10 PERCENT)");
    clean("SELECT * FROM (SELECT 1) x TABLESAMPLE (10 PERCENT)");
  });

  it("stays quiet on a LATERAL subquery after a comma", () => {
    clean("SELECT * FROM (SELECT 1) x, LATERAL (SELECT 2) l");
  });

  it("stays quiet on a join condition that begins with a keyword", () => {
    clean("SELECT * FROM (SELECT a FROM t) x JOIN (SELECT b FROM u) y ON (SELECT 1) = (SELECT 2)");
    clean("SELECT * FROM t x JOIN (SELECT b FROM u) y ON (x.id = y.id)");
  });

  it("stays quiet on a function call followed by a bracket", () => {
    // The `)` before `explode` closes a call, not a query.
    clean("SELECT * FROM f(a) explode(SELECT 1)");
    clean("SELECT * FROM range(5) (SELECT 1)");
  });

  it("stays quiet on operators and set operators that take a subquery", () => {
    clean("SELECT (SELECT 1) DIV (SELECT 2) AS r");
    clean("SELECT * FROM (SELECT 1) UNION (SELECT 2)");
    // `MOD(` already draws a missing-comma warning on main (an alias-like
    // word before a bracket); this check must add no error.
    assert.deepEqual(
      check("SELECT (SELECT 1) MOD (SELECT 2) AS r").filter((d) => d.severity === "error"), [],
    );
    clean("SELECT * FROM t WHERE (SELECT 1) IN (SELECT 2)");
  });

  it("stays quiet on a CTE list", () => {
    clean("WITH c AS (SELECT 1) SELECT * FROM c");
    clean("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b");
  });
});

describe("subqueryAliasThenQuery: a column named like a query opener", () => {
  it("stays quiet on a column alias list that names a column `values`", () => {
    clean("SELECT * FROM (SELECT 1 a, 2 b) x (values, b)");
    clean("SELECT * FROM (SELECT 1 a) x (values)");
  });
});
