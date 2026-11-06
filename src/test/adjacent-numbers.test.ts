// `adjacent-numbers`: two numeric literals with nothing between them. The
// must-fire cases are the missing comma; the near-misses are valid Databricks
// SQL that puts a number next to a number-shaped token, or a number next to a
// keyword, which must stay quiet.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { check } from "../check";

/** Severities of the adjacent-numbers findings only. */
function adjacent(sql: string): string[] {
  return check(sql).filter((d) => d.code === "adjacent-numbers").map((d) => d.severity);
}

function clean(sql: string): void {
  assert.deepEqual(check(sql), [], `expected no findings for:\n${sql}`);
}

describe("adjacent numbers", () => {
  it("fires as an error on a missing comma between two numeric literals, at any depth", () => {
    assert.deepEqual(adjacent("SELECT * FROM t WHERE a IN (2, 3, 5 7)"), ["error"]);
    assert.deepEqual(adjacent("SELECT * FROM t WHERE a IN (1 2.5)"), ["error"]);
    assert.deepEqual(adjacent("SELECT * FROM range(2 3)"), ["error"]);
    assert.deepEqual(adjacent("VALUES (1 2)"), ["error"]);
    assert.deepEqual(adjacent("SELECT 1 2 FROM t"), ["error"]);
    assert.deepEqual(adjacent("SELECT 1 /* gap */ 2 FROM t"), ["error"]);
    assert.deepEqual(adjacent("SELECT 1.2.3 FROM t"), ["error"]);
    assert.deepEqual(adjacent("SELECT 1e5 3 FROM t"), ["error"]);
    assert.deepEqual(adjacent("SELECT 10L 20 FROM t"), ["error"]);
  });

  it("stays quiet on a comma, a keyword or a bracket between numbers", () => {
    clean("SELECT * FROM t WHERE a IN (2, 3, 5, 7)");
    clean("SELECT * FROM t LIMIT 5 OFFSET 2");
    clean("SELECT * FROM t TABLESAMPLE (10 PERCENT)");
    clean("SELECT * FROM t TABLESAMPLE (BUCKET 1 OUT OF 4)");
    clean("SELECT INTERVAL 1 DAY 2 HOUR");
    clean("SELECT x FROM t WINDOW w AS (ORDER BY a ROWS BETWEEN 1 PRECEDING AND 2 FOLLOWING)");
    clean("SELECT CAST(1 AS DECIMAL(10, 2))");
    clean("SELECT * FROM t FETCH FIRST 2 ROWS ONLY");
  });

  it("stays quiet on number-shaped identifiers and aliases", () => {
    // Digit-leading identifiers are valid (spark-sql-tests/inputs/pivot.sql).
    clean("SELECT 2012_s, 2013_s, 2012_a, 2013_a, c FROM t");
    assert.deepEqual(adjacent("SELECT 1 2012_s FROM t"), [], "2012_s is an identifier, not a literal");
    clean("SELECT 1 AS 2012_s, 2 AS 2013_s FROM t");
    // `200b` is not a literal form this check knows, so it is not judged.
    assert.deepEqual(adjacent("TABLE t |> TABLESAMPLE (200b) REPEATABLE (0)"), []);
  });

  it("stays quiet on every literal spelling with a comma, and on raw text", () => {
    clean("SELECT 0x1F, 1e5, 10L, 1.5BD, .5, 1.5e-3 FROM t");
    clean("SELECT 1, -2, 3 - 4 FROM t");
    // SET k = v is raw text to Spark, so its value is not SQL.
    clean("SET spark.sql.shuffle.partitions = 1 2");
  });
});
