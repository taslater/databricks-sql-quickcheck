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

describe("keyword typos", () => {
  it("fire where only a keyword can go", () => {
    const cases: [string, string][] = [
      ["CRATE TABLE t (a INT)", "CREATE"],
      ["SELEC a FROM t", "SELECT"],
      ["SELECT a, b FORM t WHERE x = 1", "FROM"],
      ["SELECT * FORM t", "FROM"],
      ["SELECT a FROM t WHRE x = 1", "WHERE"],
      ["SELECT a, count(*) FROM t GROPU BY a", "GROUP"],
      ["SELECT rank() OVER (ORDRE BY a) FROM t", "ORDER"],
      ["SELECT * FROM a LEFT JION b ON a.id = b.id", "JOIN"],
      ["SELECT * FROM a JION b ON a.id = b.id", "JOIN"],
      ["CREATE TABLE t (a INT NOT NUL)", "NULL"],
      ["SELECT a FROM t WHERE b IS NUL", "NULL"],
      ["CREATE TABLE t (a INT COMENT 'x')", "COMMENT"],
      ["ALTER TABLE t SET TBLPROPERITES ('a' = 'b')", "TBLPROPERTIES"],
      ["SELECT CASE WEHN a = 1 THEN 'x' END FROM t", "WHEN"],
      ["SELECT sum(CAES WHEN a THEN 1 ELSE 0 END) FROM t", "CASE"],
      ["CREATE VIEW v AS SELCT a FROM t", "SELECT"],
      ["CREATE TABLE IF NOT EXIST t (a INT)", "EXISTS"],
      ["INSERT INOT t VALUES (1)", "INTO"],
      ["SHOW TABELS", "TABLES"],
      ["USE CATAOG main", "CATALOG"],
      ["MERGE INTO t USING s ON t.id = s.id WHEEN MATCHED THEN DELETE", "WHEN"],
      ["CREATE STREAMING TABLE t (CONSTRAINT c EXPECT (a > 0) ON VIOLATION RDOP ROW) AS SELECT 1", "DROP"],
      ["ALTER TABLE t ATLER COLUMN c COMMENT 'x'", "ALTER"],
      ["SELECT a FROM t WHERE EXSITS (SELECT 1)", "EXISTS"],
    ];
    for (const [sql, kw] of cases) {
      const d = check(sql).find((x) => x.code === "keyword-typo");
      assert.ok(d, `no keyword-typo for: ${sql}`);
      assert.match(d.message, new RegExp(`Did you mean ${kw}\\?`), sql);
    }
  });

  it("names that happen to be one letter off a keyword stay quiet", () => {
    clean("SELECT form, pull, wher FROM forms f JOIN joint j ON f.id = j.id");
    clean("SELECT a form, b limt FROM t");
    clean("SELECT x AS selct, y AS frm FROM t");
    clean("SELECT CASE status WHEN 1 THEN 'a' END FROM t");
    clean("DESCRIBE t col_name");
    clean("SELECT left(s, 2), right FROM t");
    clean("SELECT * FROM tabel");
  });
});

describe("missing semicolons", () => {
  it("fire when a line starts a new statement", () => {
    assert.deepEqual(found("CREATE CATALOG IF NOT EXISTS c\nCREATE SCHEMA IF NOT EXISTS c.s;"), ["missing-semicolon@2:1"]);
    assert.deepEqual(codes("DROP VIEW IF EXISTS v\nDROP TABLE IF EXISTS t;"), ["missing-semicolon"]);
    assert.deepEqual(codes("SELECT 1 AS a\nSELECT 2 AS b;"), ["missing-semicolon"]);
    assert.deepEqual(codes("USE CATALOG ${catalog}\nUSE SCHEMA s;"), ["missing-semicolon"]);
    assert.deepEqual(codes("CREATE TABLE t (a INT) USING DELTA\nCREATE TABLE u (b INT);"), ["missing-semicolon"]);
    assert.deepEqual(codes("MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT *\nMERGE INTO u USING s ON u.id = s.id WHEN MATCHED THEN DELETE"), ["missing-semicolon"]);
    // SET takes the rest as raw text: Spark would read the SELECT as part of the value.
    assert.deepEqual(codes("SET spark.sql.shuffle.partitions = 8\nSELECT 1"), ["missing-semicolon"]);
  });

  it("statements that continue on the next line stay quiet", () => {
    clean("INSERT INTO t\nSELECT * FROM s");
    clean("CREATE TABLE t AS\nSELECT * FROM s");
    clean("ALTER TABLE t\n  DROP COLUMN c");
    clean("ALTER TABLE t\n  ALTER COLUMN c COMMENT 'x'");
    clean("WITH x AS (SELECT 1 AS a)\nINSERT INTO t SELECT * FROM x");
    clean("SELECT 1 AS a\nUNION ALL\nSELECT 2 AS a");
    clean("EXPLAIN FORMATTED\n  CREATE VIEW v AS SELECT 1");
    clean("SELECT a FROM t ORDER BY a\nDESC");
    clean("FROM src\nINSERT INTO a SELECT x\nINSERT INTO b SELECT y");
    clean("CREATE SCHEMA s\nWITH DBPROPERTIES ('a' = 'b')");
    clean("MERGE INTO t USING s ON t.id = s.id\nWHEN MATCHED THEN\n  DELETE\nWHEN NOT MATCHED THEN\n  INSERT *");
    clean("BEGIN\n  CREATE TABLE t (a INT);\n  INSERT INTO t VALUES (1);\nEND");
  });
});

describe("column definitions", () => {
  it("a missing comma between two columns", () => {
    assert.deepEqual(found("CREATE TABLE t (\n  id STRING NOT NULL COMMENT 'id'\n  ts BIGINT,\n  x INT\n)"), ["missing-comma@3:3"]);
    assert.deepEqual(codes("CREATE TABLE t (id STRING ts BIGINT)"), ["missing-comma"]);
    assert.deepEqual(codes("CREATE FUNCTION f(a INT b STRING) RETURNS INT RETURN 1"), ["missing-comma"]);
  });

  it("valid column definitions stay quiet", () => {
    clean("CREATE TABLE t (a STRUCT<x INT, y STRING>, b MAP<STRING, ARRAY<INT>> COMMENT 'm', c DECIMAL(10, 2) NOT NULL)");
    clean("CREATE TABLE t (a INT GENERATED ALWAYS AS (b + 1), b INT DEFAULT 0, CONSTRAINT pk PRIMARY KEY (a))");
    clean("CREATE TABLE t (a STRING COLLATE UTF8_LCASE, b TIMESTAMP_NTZ, c VARIANT)");
  });
});

describe("clause order", () => {
  it("out of order, and twice", () => {
    assert.deepEqual(found("SELECT a, count(*) FROM t GROUP BY a WHERE a > 1"), ["clause-order@1:38"]);
    assert.deepEqual(codes("SELECT a FROM t WHERE a > 1 WHERE b < 2"), ["clause-order"]);
    assert.deepEqual(codes("SELECT a FROM t LIMIT 10 ORDER BY a"), ["clause-order"]);
  });

  it("each query block has its own clauses", () => {
    clean("SELECT a FROM t WHERE a IN (SELECT b FROM u WHERE b > 1) GROUP BY a HAVING count(*) > 1 QUALIFY 1 = 1 ORDER BY a LIMIT 5 OFFSET 1");
    clean("SELECT a FROM t WHERE a > 1 UNION ALL SELECT a FROM u WHERE a < 1 ORDER BY a");
    clean("INSERT INTO t REPLACE WHERE d > '2024' SELECT * FROM s WHERE d > '2024'");
    clean("FROM t |> WHERE a > 1 |> WHERE b > 1");
    clean("SELECT a FROM t DISTRIBUTE BY a SORT BY a");
  });
});

describe("CASE structure", () => {
  it("THEN, WHEN and ELSE out of place", () => {
    assert.deepEqual(codes("SELECT CASE WHEN a = 1 'x' ELSE 'y' END FROM t"), ["case-structure"]);
    assert.deepEqual(codes("SELECT CASE a THEN 1 END FROM t"), ["case-structure"]);
    assert.deepEqual(codes("SELECT CASE ELSE 1 END FROM t"), ["case-structure"]);
    assert.deepEqual(codes("SELECT CASE WHEN a THEN 1 ELSE 2 ELSE 3 END FROM t"), ["case-structure"]);
    assert.deepEqual(codes("SELECT CASE WHEN a THEN 1 ELSE 2 WHEN b THEN 3 END FROM t"), ["case-structure"]);
  });

  it("nested and simple CASE, and scripting CASE statements", () => {
    clean("SELECT CASE WHEN a THEN CASE b WHEN 1 THEN 'x' ELSE 'y' END ELSE 'z' END FROM t");
    clean("BEGIN\n  CASE x\n    WHEN 1 THEN SELECT 1;\n    ELSE SELECT 2;\n  END CASE;\nEND;");
  });
});

describe("dangling keywords", () => {
  it("a keyword with nothing after it", () => {
    assert.deepEqual(found("SELECT a FROM t WHERE a > 1 AND;"), ["dangling-keyword@1:29"]);
    assert.deepEqual(codes("SELECT a FROM t WHERE a > 1 AND GROUP BY a"), ["dangling-keyword"]);
    assert.deepEqual(codes("SELECT a FROM t WHERE GROUP BY a"), ["dangling-keyword"]);
    assert.deepEqual(codes("SELECT FROM t"), ["dangling-keyword"]);
    assert.deepEqual(codes("SELECT * FROM a JOIN ON a.id = 1"), ["dangling-keyword"]);
    assert.deepEqual(codes("SELECT * FROM t ORDER BY;"), ["dangling-keyword"]);
  });

  it("keywords that are followed by what they need stay quiet", () => {
    clean("SELECT a IS NOT DISTINCT FROM b FROM t WHERE c BETWEEN 1 AND 2 GROUP BY ALL");
    clean("MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED BY SOURCE THEN DELETE");
    clean("CREATE OR REPLACE TABLE IF NOT EXISTS t (a INT)");
    clean("SELECT a, from, where FROM t");
  });
});

describe("truncated statements", () => {
  it("a statement that stops on a keyword still owing an operand", () => {
    assert.deepEqual(codes("ALTER VIEW v RENAME TO"), ["dangling-keyword"]);
    assert.deepEqual(codes("ALTER CATALOG c DEFAULT COLLATION"), ["dangling-keyword"]);
    assert.deepEqual(codes("CREATE VIEW v AS"), ["dangling-keyword"]);
    assert.deepEqual(codes("ALTER TABLE t SET TBLPROPERTIES"), ["dangling-keyword"]);
    assert.deepEqual(codes("SELECT a FROM t LIMIT"), ["dangling-keyword"]);
    assert.deepEqual(codes("CREATE SCHEMA s COMMENT"), ["dangling-keyword"]);
    assert.deepEqual(codes("CREATE EXTERNAL VOLUME v LOCATION"), ["dangling-keyword"]);
  });

  it("an object type with no object named", () => {
    assert.deepEqual(codes("DROP SCHEMA"), ["dangling-keyword"]);
    assert.deepEqual(codes("CACHE TABLE"), ["dangling-keyword"]);
    assert.deepEqual(codes("SHOW CREATE TABLE"), ["dangling-keyword"]);
    assert.deepEqual(codes("DESCRIBE EXTERNAL LOCATION"), ["dangling-keyword"]);
    assert.deepEqual(codes("DROP TEMPORARY VARIABLE"), ["dangling-keyword"]);
    assert.deepEqual(codes("SHOW GRANTS ON MATERIALIZED VIEW"), ["dangling-keyword"]);
  });

  // The near-misses. Every one of these is a real statement, and several were
  // found firing during the adversarial pass over Spark's own suite.
  it("statements that legitimately end in a keyword stay quiet", () => {
    clean("ANALYZE TABLE t COMPUTE STATISTICS");
    clean("VACUUM t LITE");
    clean("VACUUM t DRY RUN");
    clean("SHOW PARTITIONS t");
    clean("CLEAR CACHE");
    clean("SHOW TABLES");
    clean("SHOW CURRENT SCHEMA");
    clean("FSCK REPAIR TABLE t VERIFY ALL");
  });

  it("the keyword is the object's own name, not a missing one", () => {
    clean("DROP VIEW view");
    clean("SHOW TBLPROPERTIES view");
    clean("SELECT id, location");
    clean("ALTER TABLE t DROP COLUMN location");
    clean("ALTER TABLE t RENAME COLUMN a TO view");
    clean("GRANT SELECT ON view TO u");
    clean("SHOW TABLES IN share");
  });

  // CATALOG's name is optional in every production that takes it, so the
  // bare forms parse. Both are must-parse cases in the reference corpus.
  it("CATALOG without a name parses", () => {
    clean("USE CATALOG");
    clean("SHOW GRANTS ON CATALOG");
  });
});

describe("empty lists", () => {
  it("a clause bracket with nothing in it", () => {
    assert.deepEqual(codes("ALTER SCHEMA s SET DBPROPERTIES ()"), ["empty-list"]);
    assert.deepEqual(codes("ALTER RECIPIENT r SET PROPERTIES ()"), ["empty-list"]);
    assert.deepEqual(codes("ALTER TABLE t SET TAGS ()"), ["empty-list"]);
    assert.deepEqual(codes("CREATE TABLE t (a INT) OPTIONS ()"), ["empty-list"]);
  });

  it("empty brackets that are a real call or a real grouping stay quiet", () => {
    clean("SELECT array(), map(), current_timestamp()");
    clean("SELECT a, count(*) FROM t GROUP BY GROUPING SETS (())");
    clean("SELECT uuid()");
  });

  it("EXCEPT and TABLESAMPLE own their lists too", () => {
    assert.deepEqual(codes("SELECT * EXCEPT () FROM t"), ["empty-list"]);
    assert.deepEqual(codes("SELECT * FROM test TABLESAMPLE ()"), ["empty-list"]);
  });

  it("a filled EXCEPT list and a set operation stay quiet", () => {
    clean("SELECT * EXCEPT (b) FROM t");
    clean("SELECT * FROM t TABLESAMPLE (10 PERCENT)");
    clean("SELECT a FROM x EXCEPT SELECT a FROM y");
    clean("SELECT a FROM x EXCEPT (SELECT a FROM y)");
  });

  it("the owner is the word before BY, not BY itself", () => {
    assert.deepEqual(codes("OPTIMIZE events ZORDER BY ()"), ["empty-list"]);
    assert.deepEqual(
      codes("CREATE TABLE t (a INT) CLUSTERED BY (a) SORTED BY () INTO 8 BUCKETS"),
      ["empty-list"],
    );
  });

  it("a BY that owns nothing stays quiet", () => {
    clean("OPTIMIZE events ZORDER BY (a)");
    clean("SELECT * FROM t ORDER BY a");
    clean("SELECT sum(x) OVER (PARTITION BY a) FROM t");
  });
});

describe("shape checks reach privilege statements", () => {
  it("a privilege statement truncated after TO or FROM", () => {
    assert.deepEqual(codes("GRANT SELECT ON TABLE t TO"), ["dangling-keyword"]);
    assert.deepEqual(codes("REVOKE SELECT ON TABLE t FROM"), ["dangling-keyword"]);
  });

  it("a privilege list is still not read as a broken query", () => {
    clean("GRANT SELECT, MODIFY ON TABLE t TO alf");
    clean("REVOKE SELECT, MODIFY ON TABLE t FROM alf");
    clean("GRANT ALL PRIVILEGES ON SCHEMA s TO `a@b.com`");
  });
});

describe("forbidden adjacency", () => {
  it("two exclusive alternatives both written", () => {
    assert.deepEqual(codes("SELECT ALL DISTINCT a FROM t"), ["statement-shape"]);
    assert.deepEqual(codes("EXPLAIN EXTENDED CODEGEN SELECT 1"), ["statement-shape"]);
    assert.deepEqual(codes("VACUUM t FULL LITE"), ["statement-shape"]);
    assert.deepEqual(codes("VACUUM t DRY RUN FULL"), ["statement-shape"]);
    assert.deepEqual(codes("CREATE TEMP EXTERNAL TABLE t (a INT)"), ["statement-shape"]);
  });

  it("each alternative on its own is fine", () => {
    clean("SELECT DISTINCT a FROM t");
    clean("SELECT ALL a FROM t");
    clean("EXPLAIN CODEGEN SELECT 1");
    clean("VACUUM t FULL");
    clean("VACUUM t LITE");
    clean("VACUUM t DRY RUN");
    clean("CREATE TEMP TABLE t (a INT)");
    clean("CREATE EXTERNAL TABLE t (a INT) LOCATION 's3://b/p'");
  });

  it("a mandatory slot with nothing in it", () => {
    assert.deepEqual(codes("ANALYZE TABLE t COMPUTE STATISTICS"), []);
    assert.deepEqual(codes("GRANT ON TABLE t TO p"), ["statement-shape"]);
    assert.deepEqual(codes("REVOKE ON TABLE t FROM p"), ["statement-shape"]);
    assert.deepEqual(codes("COPY INTO t FROM FILEFORMAT = CSV"), ["statement-shape"]);
    assert.deepEqual(codes("LOAD DATA INPATH INTO TABLE t"), ["statement-shape"]);
    assert.deepEqual(codes("ALTER TABLE RENAME TO t2"), ["statement-shape"]);
    assert.deepEqual(codes("CREATE TABLE t (a INT) CLUSTERED BY INTO 8 BUCKETS"), ["statement-shape"]);
  });

  it("the same statements with the slot filled stay quiet", () => {
    clean("GRANT SELECT ON TABLE t TO p");
    clean("REVOKE SELECT ON TABLE t FROM p");
    clean("COPY INTO t FROM 's3://b/p' FILEFORMAT = CSV");
    clean("LOAD DATA INPATH '/p' INTO TABLE t");
    clean("ALTER TABLE t1 RENAME TO t2");
    clean("CREATE TABLE t (a INT) CLUSTERED BY (a) INTO 8 BUCKETS");
  });

  it("a required modifier missing", () => {
    assert.deepEqual(codes("CREATE OR VIEW v AS SELECT a FROM t"), ["statement-shape"]);
    assert.deepEqual(codes("CREATE GLOBAL VIEW v AS SELECT a FROM t"), ["statement-shape"]);
    assert.deepEqual(codes("CREATE VIEW v WITH AS SELECT a FROM t"), ["statement-shape"]);
  });

  it("the correct forms of those stay quiet", () => {
    clean("CREATE OR REPLACE VIEW v AS SELECT a FROM t");
    clean("CREATE GLOBAL TEMPORARY VIEW v AS SELECT a FROM t");
    clean("CREATE VIEW v WITH SCHEMA BINDING AS SELECT a FROM t");
    clean("CREATE OR REFRESH STREAMING TABLE t AS SELECT * FROM STREAM s");
  });

  it("a pair says nothing outside the statement it belongs to", () => {
    // `full` and `run` are ordinary words once VACUUM is not the lead.
    clean("SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id");
    clean("SELECT * FROM logs run FULL JOIN b ON run.id = b.id");
    // `view` is a legal column name, so OR VIEW outside CREATE means nothing.
    clean("SELECT * FROM t WHERE flagged OR view");
    clean("SELECT a, all, distinct FROM t");
  });

  it("the pair must be keywords, not names", () => {
    clean("SELECT t.all AS x FROM t");
    clean("SELECT count(*) AS full FROM t");
  });
});

describe("two-word tails that owe a follower", () => {
  it("neither word alone would be evidence", () => {
    assert.deepEqual(codes("CREATE CATALOG c MANAGED LOCATION"), ["dangling-keyword"]);
    assert.deepEqual(codes("CREATE SCHEMA s MANAGED LOCATION"), ["dangling-keyword"]);
    assert.deepEqual(codes("ALTER SHARE s ADD TABLE"), ["dangling-keyword"]);
    assert.deepEqual(codes("LOAD DATA INPATH '/p' INTO TABLE"), ["dangling-keyword"]);
    assert.deepEqual(codes("SHOW GRANTS TO RECIPIENT"), ["dangling-keyword"]);
    assert.deepEqual(codes("SHOW SHARES IN PROVIDER"), ["dangling-keyword"]);
  });

  it("the single word on its own is still not evidence", () => {
    clean("ALTER TABLE t DROP COLUMN location");
    clean("SELECT provider FROM t");
    clean("CREATE CATALOG c MANAGED LOCATION 's3://b/p'");
    clean("ALTER SHARE s ADD TABLE tbl");
    clean("SHOW GRANTS TO RECIPIENT r");
  });
});

describe("a query that lost its SELECT", () => {
  it("inside a bracket whose owner says a query goes there", () => {
    assert.deepEqual(codes("SELECT * FROM (a, b FROM t) x"), ["missing-keyword"]);
    assert.deepEqual(codes("SELECT * FROM t WHERE EXISTS (* FROM u WHERE u.id = t.id)"), ["missing-keyword"]);
    assert.deepEqual(codes("WITH c AS (a, sum(b) FROM t GROUP BY a) SELECT * FROM c"), ["missing-keyword"]);
    assert.deepEqual(codes("SELECT * FROM t WHERE a > (avg(b) * 1.2 FROM u)"), ["missing-keyword"]);
  });

  it("after a set operator, and after a CTE list", () => {
    assert.deepEqual(codes("SELECT a FROM x UNION ALL b, c FROM y"), ["missing-keyword"]);
    assert.deepEqual(codes("WITH c AS (SELECT 1 AS a) a, b FROM c"), ["missing-keyword"]);
  });

  it("a function call's FROM is ordinary syntax", () => {
    clean("SELECT extract(YEAR FROM d), substring(s FROM 2 FOR 3), trim(BOTH ' ' FROM s) FROM t");
    clean("SELECT a FROM t WHERE a > (extract(YEAR FROM d) + 1)");
  });

  it("a FROM-first query is not a lost SELECT", () => {
    clean("SELECT * FROM (FROM t SELECT a)");
    clean("SELECT * FROM (FROM t |> WHERE a > 1)");
    clean("WITH c AS (SELECT 1 AS a) FROM c SELECT a");
    clean("FROM src INSERT OVERWRITE TABLE t1 SELECT a WHERE a > 1");
  });

  it("star EXCEPT is not a set operator, and a CTE may feed any statement", () => {
    clean("SELECT * EXCEPT (a) FROM t");
    clean("SELECT a, t.* EXCEPT (b) FROM t");
    clean("MERGE INTO t USING s ON t.k = s.k WHEN MATCHED THEN UPDATE SET * EXCEPT (b)");
    clean("WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c");
    clean("SELECT a FROM x UNION ALL BY NAME SELECT a FROM y");
    clean("SELECT a FROM x UNION VALUES (1)");
  });

  it("a query after CREATE ... AS is not checked: AUTO CDC has a FROM and no SELECT", () => {
    clean("CREATE FLOW f AS AUTO CDC INTO t FROM stream(s) KEYS (id) SEQUENCE BY ts");
  });
});

describe("a FROM list that lost its WHERE", () => {
  it("a comparison where only table references belong", () => {
    assert.deepEqual(codes("SELECT a FROM t1, t2 t1.id = t2.id AND t1.x > 3"), ["missing-keyword"]);
    assert.deepEqual(codes("SELECT a FROM store_sales, item i ss_item_sk = i.i_item_sk"), ["missing-keyword"]);
  });

  it("the same comparisons in their proper place stay quiet", () => {
    clean("SELECT a FROM t1, t2 WHERE t1.id = t2.id AND t1.x > 3");
    clean("SELECT * FROM a JOIN b ON a.id = b.id");
    clean("SELECT a FROM t QUALIFY row_number() OVER (PARTITION BY a ORDER BY b) = 1");
    clean("SELECT * FROM t PIVOT (sum(v) FOR k IN ('a', 'b')) WHERE a = 1");
  });

  it("a FROM that is not a query's FROM ends at its first unknown keyword", () => {
    clean("COPY INTO t FROM 's3://b/p' FILEFORMAT = CSV");
    clean("APPLY CHANGES INTO t FROM stream(s) KEYS (id) APPLY AS DELETE WHEN op = 'DELETE' SEQUENCE BY ts");
    clean("SELECT * FROM t TIMESTAMP AS OF current_timestamp() - INTERVAL 1 DAY");
    clean("FROM t |> WHERE a = 1 |> SELECT a");
  });

  it("SELECT ... WHERE with no FROM at all is valid", () => {
    // The SELECT production makes FROM optional and WHERE independent of it.
    clean("SELECT 1 WHERE true");
  });
});

describe("AS OF is a pair, not an alias", () => {
  it("nothing after AS OF", () => {
    assert.deepEqual(codes("RESTORE TABLE employee TO VERSION AS OF"), ["dangling-keyword"]);
    assert.deepEqual(codes("RESTORE TABLE employee TO TIMESTAMP AS OF"), ["dangling-keyword"]);
  });

  it("a real AS OF, and a real alias, stay quiet", () => {
    clean("RESTORE TABLE t TO VERSION AS OF 3");
    clean("SELECT * FROM t VERSION AS OF 2");
    clean("SELECT count(*) AS of FROM t");
  });
});

describe("casts and JSON paths with nothing after them", () => {
  it("a clause keyword cannot be a type or a field", () => {
    assert.deepEqual(codes("SELECT a:: FROM t"), ["missing-operand"]);
    assert.deepEqual(codes("SELECT '2147483648' :: SELECT"), ["missing-operand"]);
  });

  it("real casts and paths stay quiet", () => {
    clean("SELECT a::date, b::string, c::INTERVAL DAY FROM t");
    clean("SELECT v:name, v:items[0].id FROM t");
    clean("SELECT CAST(a AS STRUCT<f: INT>) FROM t");
  });
});

describe("operator typos", () => {
  it("=< and a stray =>", () => {
    assert.deepEqual(codes("SELECT * FROM t WHERE a =< 1"), ["operator-typo"]);
    assert.deepEqual(codes("SELECT * FROM t WHERE a => 1"), ["operator-typo"]);
    clean("SELECT read_files('/p', format => 'csv'), transform(arr, x -> x + 1) FROM t WHERE a <= 1");
  });
});

describe("statement starts", () => {
  it("an unknown first word is a warning; a typo of a real one is an error", () => {
    assert.deepEqual(check("foo bar;").map((d) => [d.code, d.severity]), [["unknown-statement", "warning"]]);
    assert.deepEqual(check("DELTE FROM t;").map((d) => [d.code, d.severity]), [["keyword-typo", "error"]]);
    clean("lbl: BEGIN\n  SELECT 1;\nEND lbl;");
  });

  it("non-SQL magic cells are skipped whole", () => {
    clean("-- Databricks notebook source\n%python\nprint(\"it's\"); x = {1: 2}\n\n-- COMMAND ----------\n\n%run ./other\n\n-- COMMAND ----------\n\n%sql\nSELECT 1");
    assert.deepEqual(codes("-- Databricks notebook source\n%sql\nSELECT a,, b FROM t"), ["double-comma"]);
  });
});

describe("explicit aliases (opt-in)", () => {
  it("reports every implicit column alias when asked", () => {
    assert.deepEqual(codes("SELECT a b, c FROM t"), []);
    assert.deepEqual(check("SELECT a b, c FROM t", { explicitAliases: true }).map((d) => d.code), ["implicit-alias"]);
    assert.deepEqual(check("SELECT a AS b, count(*) AS n FROM t", { explicitAliases: true }), []);
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
