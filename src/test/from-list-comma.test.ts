// A missing comma in a FROM list: three bare names in a row at the clause's own
// depth. Every check has a case that must fire and valid near-misses that must
// stay quiet; the near-misses are the table-reference forms that look most like
// the mistake (`FROM a x, b y` next to `FROM a x b y`).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { check } from "../check";

function codes(sql: string, warnings = true): string[] {
  return check(sql, { warnings }).map((d) => d.code);
}

function clean(sql: string): void {
  assert.deepEqual(check(sql), [], `expected no findings for:\n${sql}`);
}

describe("missing comma in a FROM list", () => {
  it("fires on three names in a row at the FROM clause's depth", () => {
    const sql = "SELECT * FROM store_returns, date_dim d1, date_dim d2 date_dim d3, store WHERE a = 1";
    assert.deepEqual(codes(sql), ["missing-comma"]);
    const [d] = check(sql);
    assert.equal(d.severity, "warning");
    assert.match(d.message, /date_dim d2 date_dim d3/);
  });

  it("fires on a bare triple, with or without a preceding item", () => {
    assert.deepEqual(codes("SELECT * FROM t a b"), ["missing-comma"]);
    assert.deepEqual(codes("SELECT * FROM a x, b y c z WHERE x = 1"), ["missing-comma"]);
    assert.deepEqual(codes("SELECT * FROM (SELECT * FROM a x y z) q"), ["missing-comma"]);
  });

  it("is silent when warnings are off", () => {
    assert.deepEqual(codes("SELECT * FROM a x y", false), []);
  });

  it("a run followed by a comparison is a lost WHERE, reported once", () => {
    assert.deepEqual(codes("SELECT a FROM store_sales, item i ss_item_sk = i.i_item_sk"), ["missing-keyword"]);
  });

  it("stays quiet on the valid table-reference forms that look like the mistake", () => {
    clean("SELECT * FROM a x, b y");
    clean("SELECT * FROM a AS x");
    clean("SELECT * FROM a x JOIN b y ON a.id = b.id");
    clean("SELECT * FROM a x LEFT JOIN b y ON a.k = b.k");
    clean("SELECT * FROM t TABLESAMPLE (10 PERCENT) s");
    clean("SELECT * FROM t VERSION AS OF 3");
    clean("SELECT * FROM t TIMESTAMP AS OF '2020-01-01'");
    clean("SELECT * FROM delta.`/path` x");
    clean("SELECT * FROM a LATERAL VIEW explode(x) tt AS c");
    clean("SELECT * FROM t WINDOW w AS (PARTITION BY a)");
    clean("SELECT * FROM catalog.schema.tbl alias");
    clean("SELECT * FROM t@v1 a, u@v2 b");
  });

  it("keyword aliases are not bare names, so they break the run", () => {
    clean("SELECT * FROM t left WHERE a = 1");
    clean("SELECT * FROM t full WHERE a = 1");
    clean("SELECT * FROM t natural WHERE a = 1");
    clean("SELECT * FROM a x, b left, c right");
  });

  it("stays quiet on SHOW and on FROM inside function calls", () => {
    clean("SHOW TABLES FROM db LIKE 'x'");
    clean("SHOW COLUMNS FROM t IN db");
    clean("SELECT extract(YEAR FROM d) y, trim(x FROM y) z FROM t");
    clean("SELECT * FROM t WHERE a IS DISTINCT FROM b");
  });

  it("stays quiet on a name run after the FROM clause has ended", () => {
    clean("SELECT a FROM t WHERE x = 1 ORDER BY a");
    clean("SELECT a FROM t x GROUP BY a");
  });
});
