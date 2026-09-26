// Every check has a case that must fire and a near-miss that must not: the
// near-misses are the valid Databricks constructs that look most like the
// mistake (`ARRAY<INT>)` next to `a >)`, `count(*) total` next to `a b c`).

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { check } from "../check";

/** `code@line:col` for each finding, in order. */
function found(sql: string, warnings = true): string[] {
  return check(sql, { warnings }).map((d) => `${d.code}@${d.line}:${d.column}`);
}

function codes(sql: string, warnings = true): string[] {
  return check(sql, { warnings }).map((d) => d.code);
}

function clean(sql: string): void {
  assert.deepEqual(check(sql), [], `expected no findings for:\n${sql}`);
}

describe("lexical errors", () => {
  it("unterminated strings, identifiers, comments and bodies", () => {
    assert.deepEqual(found("SELECT 'abc FROM t"), ["unterminated-string@1:8"]);
    assert.deepEqual(found('SELECT "abc FROM t'), ["unterminated-string@1:8"]);
    assert.deepEqual(found("SELECT `abc FROM t"), ["unterminated-identifier@1:8"]);
    assert.deepEqual(found("SELECT 1 /* note"), ["unterminated-comment@1:10"]);
    assert.deepEqual(found("CREATE FUNCTION f() RETURNS INT LANGUAGE PYTHON AS $$ return 1"), ["unterminated-body@1:52"]);
    assert.deepEqual(found("SELECT * FROM t WHERE a = {{ p"), ["unterminated-template@1:27"]);
    assert.deepEqual(found("SELECT * FROM ${cat.s\n"), ["unterminated-template@1:15"]);
  });

  it("escapes, doubled quotes and raw strings are not unterminated", () => {
    clean("SELECT 'it\\'s', 'it''s', \"say \\\"hi\\\"\", `a``b` FROM t");
    clean("SELECT r'C:\\path\\', R\"\\d+\" FROM t");
    clean("SELECT X'1F', DATE '2024-01-01', INTERVAL '1' DAY FROM t");
  });

  it("bracketed comments nest, as in Spark", () => {
    clean("/* outer /* inner */ still a comment */ SELECT 1");
    assert.deepEqual(codes("/* outer /* inner */ SELECT 1"), ["unterminated-comment"]);
  });

  it("points at a multi-line string that probably lost its closing quote", () => {
    const sql = "SELECT *\nFROM t\nWHERE status = 'active\nAND name = 'bob';\n";
    assert.deepEqual(found(sql), ["unterminated-string@3:16", "unterminated-string@4:16"]);
    assert.equal(check(sql)[0].severity, "warning");
  });

  it("flags a string that has swallowed code but still balances", () => {
    const sql = "SELECT a FROM t WHERE x LIKE '%a%\nORDER BY a;\n-- don't\nSELECT 1";
    assert.deepEqual(codes(sql), ["string-swallows-code"]);
    clean("COMMENT ON TABLE t IS 'first line\nsecond line'");
  });
});

describe("notebooks", () => {
  const nb = (...cells: string[]) => "-- Databricks notebook source\n" + cells.join("\n\n-- COMMAND ----------\n\n");

  it("a cell separator ends strings, comments and brackets", () => {
    const sql = nb("SELECT 'oops FROM t", "SELECT count(* FROM t", "SELECT 1");
    assert.deepEqual(found(sql), ["unterminated-string@2:8", "unclosed-bracket@6:13"]);
  });

  it("magic cells are comments, and %sql lines are skipped", () => {
    clean(nb("-- MAGIC %md\n-- MAGIC Don't (panic", "SELECT 1"));
    clean("%sql\nSELECT a, b FROM t");
  });

  it("widget and dashboard parameters are opaque", () => {
    clean("SELECT * FROM ${catalog}.${schema}.t WHERE d > '${start}' AND x = $env AND y = {{ p }}");
    clean("SELECT {% for c in cols %}{{ c }},{% endfor %} id FROM t");
  });
});

describe("brackets", () => {
  it("unclosed, unmatched and mismatched", () => {
    assert.deepEqual(found("SELECT count(* FROM t"), ["unclosed-bracket@1:13"]);
    assert.deepEqual(found("SELECT a) FROM t"), ["unmatched-bracket@1:9"]);
    assert.deepEqual(codes("SELECT f(a]) FROM t"), ["mismatched-bracket"]);
    assert.deepEqual(codes("SELECT f(a[0) FROM t"), ["unclosed-bracket"]);
  });

  it("a `;` ends the statement, so one missing `)` stays local", () => {
    assert.deepEqual(found("SELECT f(a;\nSELECT g(b) FROM t;"), ["unclosed-bracket@1:9"]);
  });

  it("checks brackets inside optimizer hints", () => {
    assert.deepEqual(codes("SELECT /*+ BROADCAST(t1 */ a FROM t1"), ["unclosed-bracket"]);
    clean("SELECT /*+ REPARTITION(100), COALESCE(500), REPARTITION_BY_RANGE(3, c) */ a FROM t");
    clean("/*+ a banner, not a hint ( */ SELECT 1");
  });
});

describe("commas", () => {
  it("double, leading and trailing", () => {
    assert.deepEqual(found("SELECT a,, b FROM t"), ["double-comma@1:10"]);
    assert.deepEqual(found("SELECT f(, a) FROM t"), ["leading-comma@1:10"]);
    assert.deepEqual(found("SELECT f(a,) FROM t"), ["trailing-comma@1:11"]);
    assert.deepEqual(found("CREATE TABLE t (a INT, b INT,)"), ["trailing-comma@1:29"]);
    assert.deepEqual(found("SELECT a, b,"), ["trailing-comma@1:12"]);
  });

  it("trailing comma before a clause is a warning", () => {
    assert.deepEqual(found("SELECT a, b, FROM t"), ["comma-before-clause@1:12"]);
    assert.deepEqual(codes("SELECT a FROM t GROUP BY a, ORDER BY a"), ["comma-before-clause"]);
    clean("SELECT a, from AS f, where FROM t");
  });

  it("SET values are raw text, but SET VAR is SQL", () => {
    clean("SET spark.sql.sources.partitionOverwriteMode = dynamic,static");
    clean("SET foo = (1, 3");
    clean("SET spark.x =");
    clean("ADD JAR /tmp/lib/;");
    assert.deepEqual(codes("SET VAR v = (SELECT max(a) FROM VALUES (1),, (2) AS t(a))"), ["double-comma"]);
  });
});

describe("operators", () => {
  it("missing operands", () => {
    assert.deepEqual(found("SELECT a + FROM t WHERE (b + )"), ["missing-operand@1:28"]);
    assert.deepEqual(found("SELECT * FROM t WHERE a = = b"), ["missing-operand@1:27"]);
    assert.deepEqual(found("SELECT * FROM t WHERE (= b)"), ["missing-operand@1:24"]);
    assert.deepEqual(found("SELECT * FROM t WHERE x = 1 AND y >"), ["missing-operand@1:35"]);
    assert.deepEqual(codes("SELECT a ||, b FROM t"), ["missing-operand"]);
  });

  it("valid operator shapes stay quiet", () => {
    clean("SELECT count(*), t.*, -a, +b, ~c, NOT d, a <=> b, a <> b, a != b, a == b, 10 % 3 FROM t");
    clean("SELECT CAST(x AS ARRAY<STRUCT<a: INT, b: MAP<STRING, INT>>>) FROM t");
    clean("ALTER TABLE t ADD COLUMN c ARRAY<INT>");
    clean("SELECT transform(arr, x -> x + 1), read_files('/p', format => 'csv') FROM t");
    clean("SELECT raw:a.b[0]::string, raw:['k'], a::int FROM t WHERE c = :param AND d = ?");
    clean("FROM t |> WHERE x > 1 |> SELECT a, b |> ORDER BY a");
    clean("SELECT * FROM t MATCH_RECOGNIZE (ORDER BY ts PATTERN (strt up+ down* x?) DEFINE up AS p > PREV(p))");
  });
});

describe("CASE ... END", () => {
  it("fires inside brackets and at the end of a statement", () => {
    assert.deepEqual(found("SELECT f(CASE WHEN a THEN 1) FROM t"), ["case-without-end@1:10"]);
    assert.deepEqual(found("SELECT CASE WHEN a THEN 1 ELSE 0 AS flag FROM t"), ["case-without-end@1:8"]);
  });

  it("END IF / END CASE in scripting, and END as a name, are fine", () => {
    clean("BEGIN\n  CASE x\n    WHEN 1 THEN SELECT 1;\n    ELSE SELECT 2;\n  END CASE;\n  IF a THEN SELECT 3; END IF;\nEND;");
    clean("SELECT t.end, CASE WHEN a THEN 1 END AS end FROM t");
  });
});

describe("missing commas", () => {
  it("in select lists", () => {
    assert.deepEqual(found("SELECT id name email FROM t"), ["missing-comma@1:16"]);
    assert.deepEqual(found("SELECT a b(c) FROM t"), ["missing-comma@1:10"]);
    assert.deepEqual(found("SELECT a b.c FROM t"), ["missing-comma@1:10"]);
    assert.deepEqual(found("SELECT a 1 FROM t"), ["missing-comma@1:10"]);
  });

  it("an alias on its own line after a bare column", () => {
    assert.deepEqual(found("SELECT\n  id,\n  first_name\n  last_name,\n  email\nFROM t"), ["alias-on-new-line@4:3"]);
    // After an aggregate it is a common, deliberate style.
    clean("SELECT\n  sum(x)\n  total_x\nFROM t");
  });

  it("in lists that cannot take aliases", () => {
    assert.deepEqual(codes("SELECT a FROM t GROUP BY a b"), ["missing-comma"]);
    assert.deepEqual(codes("SELECT a FROM t ORDER BY a DESC b"), ["missing-comma"]);
    assert.deepEqual(codes("SELECT coalesce(a b) FROM t"), ["missing-comma"]);
    assert.deepEqual(codes("SELECT a FROM t GROUP BY date_trunc('month', d x)"), ["missing-comma"]);
  });

  it("valid juxtapositions stay quiet", () => {
    clean("SELECT count(*) total, a AS b, c d, CASE WHEN a THEN b END flag, 'x' 'y' xy FROM t");
    clean("SELECT explode(m) (k, v), inline(arr) AS (a, b), struct(a x) FROM t");
    clean("SELECT extract(dow FROM d), trim(BOTH 'x' FROM s), substring(s FROM 1 FOR 2) FROM t");
    clean("SELECT a IS NOT DISTINCT FROM b c, x COLLATE utf8_lcase y FROM t");
    clean("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) m FROM t");
    clean("SELECT * EXCEPT (a, b) FROM t");
    clean("SELECT a FROM t GROUP BY GROUPING SETS ((a), (b)) ORDER BY a DESC NULLS LAST, b");
    clean("SELECT sum(x) OVER (PARTITION BY a ORDER BY b ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) s FROM t");
    clean("SELECT * FROM t ORDER BY a OFFSET length('SPARK')");
    clean("GRANT SELECT, MODIFY ON TABLE t TO `data eng`");
  });

  it("warnings can be switched off", () => {
    assert.deepEqual(codes("SELECT id name email FROM t", false), []);
    assert.deepEqual(codes("SELECT a,, b FROM t", false), ["double-comma"]);
  });
});

describe("positions", () => {
  it("are 1-based and survive CRLF line endings", () => {
    const [d] = check("SELECT a\r\nFROM t\r\nWHERE (b = 1");
    assert.equal(d.line, 3);
    assert.equal(d.column, 7);
    assert.equal(d.endColumn, 8);
  });
});

describe("cli", () => {
  const cli = path.join(__dirname, "..", "cli.js");

  it("prints path:line:col and exits 1 on errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quickcheck-"));
    const bad = path.join(dir, "bad.sql");
    fs.writeFileSync(bad, "SELECT a,, b FROM t;\n");
    fs.writeFileSync(path.join(dir, "good.sql"), "SELECT a, b FROM t;\n");
    const r = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), `${bad}:1:10: error [double-comma] Two commas in a row`);
    fs.rmSync(dir, { recursive: true });
  });

  it("exits 0 on warnings unless --strict", () => {
    const run = (...flags: string[]) =>
      spawnSync(process.execPath, [cli, "--stdin", ...flags], { input: "SELECT id name email FROM t", encoding: "utf8" }).status;
    assert.equal(run(), 0);
    assert.equal(run("--strict"), 1);
  });

  it("serves a JSON-lines batch", () => {
    const out = execFileSync(process.execPath, [cli, "--jsonl"], {
      input: JSON.stringify({ id: "a", text: "SELECT (" }) + "\n" + JSON.stringify({ id: "b", text: "SELECT 1" }) + "\n",
      encoding: "utf8",
    });
    const rows = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.id, r.diagnostics.length]), [["a", 1], ["b", 0]]);
  });
});
