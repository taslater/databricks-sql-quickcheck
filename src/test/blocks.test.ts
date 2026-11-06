// SQL scripting block structure: BEGIN/END, IF, WHILE, LOOP, REPEAT, FOR, CASE.
// Every rule has a script that must fire and a valid twin that must stay
// quiet. The scripts were run on a Databricks SQL warehouse: the engine rejects
// every "fires" script and parses every "quiet" one, except the "gives up"
// group (which asserts silence where the checker cannot judge, so those may be
// invalid) and the two CREATE PROCEDURE bodies (they parse; a bare warehouse
// then refuses them for want of a schema).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { check } from "../check";

const blockCodes = (sql: string): string[] =>
  check(sql).map((d) => d.code).filter((c) => /-block$/.test(c));

function fires(sql: string, code: string, at?: string): void {
  const hits = check(sql).filter((d) => d.code === code);
  assert.equal(hits.length, 1, `expected one ${code} for:\n${sql}\ngot ${JSON.stringify(check(sql).map((d) => d.code))}`);
  if (at !== undefined) assert.equal(sql.slice(hits[0].start, hits[0].end), at);
}

function clean(sql: string): void {
  assert.deepEqual(check(sql), [], `expected no findings for:\n${sql}`);
}

describe("block structure: the four mistakes in the issue", () => {
  it("END IF missing", () => {
    fires("BEGIN IF 1 = 1 THEN SELECT 1; END", "mismatched-block", "END");
    clean("BEGIN IF 1 = 1 THEN SELECT 1; END IF; END");
  });
  it("a wrong closer", () => {
    fires("BEGIN WHILE false DO SELECT 1; END IF; END", "mismatched-block", "END");
    clean("BEGIN WHILE false DO SELECT 1; END WHILE; END");
  });
  it("END missing", () => {
    fires("BEGIN SELECT 1;", "unclosed-block", "BEGIN");
    clean("BEGIN SELECT 1; END");
  });
  it("UNTIL missing", () => {
    fires("BEGIN REPEAT SELECT 1; END REPEAT; END", "mismatched-block", "END");
    clean("BEGIN REPEAT SELECT 1; UNTIL true END REPEAT; END");
  });
});

describe("block structure: other mistakes", () => {
  it("every closer must match the block it closes", () => {
    for (const [open, body, right, wrong] of [
      ["IF 1 = 1 THEN", "SELECT 1;", "END IF", "END WHILE"],
      ["WHILE false DO", "SELECT 1;", "END WHILE", "END LOOP"],
      ["LOOP", "LEAVE;", "END LOOP", "END IF"],
      ["FOR r AS SELECT 1 AS n DO", "SELECT 1;", "END FOR", "END WHILE"],
      ["CASE 1 WHEN 1 THEN", "SELECT 1;", "END CASE", "END IF"],
    ]) {
      if (open === "LOOP") continue; // LEAVE needs a label; covered below
      fires(`BEGIN ${open} ${body} ${wrong}; END`, "mismatched-block");
      clean(`BEGIN ${open} ${body} ${right}; END`);
    }
  });
  it("an END label must match the begin label", () => {
    fires("BEGIN lbl: LOOP LEAVE lbl; END LOOP other; END", "mismatched-block", "other");
    clean("BEGIN lbl: LOOP LEAVE lbl; END LOOP lbl; END");
    clean("BEGIN lbl: LOOP LEAVE lbl; END LOOP LBL; END"); // identifiers are case-insensitive
    clean("BEGIN lbl: BEGIN SELECT 1; END lbl; END");
  });
  it("an END with nothing to close", () => {
    fires("BEGIN SELECT 1; END; END", "unmatched-block");
    fires("BEGIN SELECT 1; END IF", "mismatched-block");
  });
  it("a block left open in the middle of a script is named at its opener", () => {
    const sql = "BEGIN\n  IF 1 = 1 THEN\n    SELECT 1;\n  END IF;\n  WHILE false DO\n    SELECT 2;\nEND";
    fires(sql, "mismatched-block", "END");
    assert.match(check(sql)[0].message, /WHILE/);
    assert.equal(check(sql)[0].line, 7);
  });
  it("two blocks opened, one closed", () => {
    fires("BEGIN BEGIN SELECT 1; END", "unclosed-block", "BEGIN");
  });
});

describe("block structure: a notebook cell boundary ends every open block", () => {
  it("does not match an opener in one cell with a closer in the next", () => {
    const nb = "-- Databricks notebook source\nBEGIN SELECT 1;\n-- COMMAND ----------\nEND";
    assert.deepEqual(blockCodes(nb).sort(), ["unclosed-block", "unmatched-block"]);
  });
  it("checks each cell on its own", () => {
    clean("-- Databricks notebook source\nBEGIN SELECT 1; END\n-- COMMAND ----------\nBEGIN SELECT 2; END");
  });
});

describe("block structure: valid scripts stay quiet", () => {
  it("IF / ELSEIF / ELSE, nested, with every statement kind", () => {
    clean("BEGIN DECLARE c INT DEFAULT 3; IF c < 2 THEN VALUES (1); ELSEIF c < 4 THEN VALUES (2); ELSE VALUES (0); END IF; END");
    clean("BEGIN IF 1 = 1 THEN IF 2 = 2 THEN WHILE false DO SELECT 1; END WHILE; END IF; END IF; END");
  });
  it("the CASE statement, simple and searched, with and without ELSE", () => {
    clean("BEGIN DECLARE c INT DEFAULT 3; CASE c WHEN 1 THEN VALUES (1); WHEN 2 THEN VALUES (2); ELSE VALUES (0); END CASE; END");
    clean("BEGIN CASE WHEN 1 < 2 THEN VALUES (1); END CASE; END");
  });
  it("loops with labels", () => {
    clean("BEGIN DECLARE n INT DEFAULT 0; s: WHILE n < 3 DO SET n = n + 1; END WHILE s; END");
    clean("BEGIN DECLARE n INT DEFAULT 0; s: LOOP SET n = n + 1; IF n > 2 THEN LEAVE s; END IF; END LOOP s; END");
    clean("BEGIN DECLARE n INT DEFAULT 0; s: REPEAT SET n = n + 1; UNTIL n = 3 END REPEAT s; END");
    clean("BEGIN FOR r AS SELECT 1 AS n FROM range(2) DO SELECT r.n; END FOR; END");
  });
  it("a label named like a block word", () => {
    clean("BEGIN loop: LOOP LEAVE loop; END LOOP loop; END");
  });
  it("CASE expressions are not blocks, and their THEN and END are not the statement's", () => {
    clean("BEGIN IF CASE WHEN 1 = 1 THEN true ELSE false END THEN SELECT 1; END IF; END");
    clean("BEGIN SELECT CASE WHEN 1 = 1 THEN 'a' END; END");
    clean("BEGIN WHILE CASE WHEN 1 = 2 THEN true ELSE false END DO SELECT 1; END WHILE; END");
    clean("BEGIN REPEAT SELECT 1; UNTIL CASE WHEN 1 = 1 THEN true ELSE false END END REPEAT; END");
    clean("BEGIN CASE CASE WHEN 1 = 1 THEN 1 END WHEN 1 THEN SELECT 1; END CASE; END");
  });
  it("IF and REPEAT as functions are not blocks", () => {
    clean("BEGIN SELECT if(1 = 1, 'a', 'b'); END");
    clean("BEGIN SELECT repeat('x', 3); END");
    clean("BEGIN IF if(1 = 1, true, false) THEN SELECT 1; END IF; END");
  });
  it("block words inside strings, comments and quoted names are not tokens", () => {
    clean("BEGIN SELECT 'END IF', 'BEGIN', 1 AS `end`; /* END */ -- BEGIN\n END");
  });
  it("block words as aliases", () => {
    clean("BEGIN SELECT 1 AS loop, 2 AS until, 3 AS repeat; END");
    clean("CREATE VIEW v AS SELECT 1 AS begin");
  });
  it("a variable named case is not a CASE expression", () => {
    clean("BEGIN DECLARE case INT DEFAULT 1; VALUES (case); END");
  });
  it("BEGIN TRANSACTION is not a block", () => {
    clean("BEGIN TRANSACTION");
  });
  it("handlers, with a block or a single statement as the action", () => {
    clean("BEGIN DECLARE EXIT HANDLER FOR DIVIDE_BY_ZERO BEGIN VALUES (0); END; SELECT 1; END");
    clean("BEGIN DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET x = 1; SELECT 1; END");
  });
  it("CREATE PROCEDURE with a body", () => {
    clean("CREATE PROCEDURE p() LANGUAGE SQL AS BEGIN SELECT 1; END");
    clean("CREATE OR REPLACE PROCEDURE add(x INT, OUT s INT) LANGUAGE SQL AS BEGIN SET s = x + 1; END");
  });
  it("BEGIN ATOMIC", () => {
    clean("BEGIN ATOMIC SELECT 1; SELECT 2; END");
  });
  it("lowercase and spread over lines", () => {
    clean("begin\n  declare n int default 0;\n  while n < 2 do\n    set n = n + 1;\n  end while;\nend");
  });
});

describe("block structure: required words and misplaced words", () => {
  // [script, the code it must raise, or null when the engine accepts it and
  // the checker must say nothing]. Each was run on a Databricks SQL warehouse.
  const rows: [string, string | null][] = [
    ["BEGIN IF 1 = 1 VALUES (1); END IF; END", "incomplete-block"],
    ["BEGIN IF 1 = 1 THEN VALUES (1); END IF; END", null],
    ["BEGIN IF 1 = 2 THEN VALUES (1); ELSEIF 1 = 1 VALUES (2); END IF; END", "incomplete-block"],
    ["BEGIN WHILE false VALUES (1); END WHILE; END", "incomplete-block"],
    ["BEGIN FOR r AS SELECT 1 AS n VALUES (1); END FOR; END", "incomplete-block"],
    ["BEGIN CASE 1 WHEN 1 VALUES (1); END CASE; END", "incomplete-block"],
    ["BEGIN REPEAT VALUES (1); UNTIL true; END", "incomplete-block"],
    ["BEGIN REPEAT VALUES (1); UNTIL true END WHILE; END", "mismatched-block"],
    ["BEGIN REPEAT VALUES (1); UNTIL true END REPEAT; END", null],
    ["BEGIN WHILE false DO END WHILE; END", "incomplete-block"],
    ["BEGIN lp: LOOP END LOOP lp; END", "incomplete-block"],
    ["BEGIN WHILE false DO BEGIN END; END WHILE; END", null],
    ["BEGIN BEGIN END; END", null],
    ["BEGIN IF 1 = 2 THEN VALUES (1); ELSE VALUES (2); ELSE VALUES (3); END IF; END", "misplaced-block-word"],
    ["BEGIN IF 1 = 2 THEN VALUES (1); ELSE VALUES (2); ELSEIF 1 = 1 THEN VALUES (3); END IF; END", "misplaced-block-word"],
    ["BEGIN VALUES (1); ELSE VALUES (2); END", "misplaced-block-word"],
    ["BEGIN VALUES (1); ELSEIF 1 = 1 THEN VALUES (2); END", "misplaced-block-word"],
    ["BEGIN CASE 1 WHEN 1 THEN VALUES (1); ELSE VALUES (2); WHEN 2 THEN VALUES (3); END CASE; END", "misplaced-block-word"],
    ["BEGIN VALUES (1); WHEN 1 THEN VALUES (2); END", "misplaced-block-word"],
    ["BEGIN VALUES (1); UNTIL true; END", "misplaced-block-word"],
    ["BEGIN CASE 1 WHEN 1 THEN VALUES (1); WHEN 2 THEN VALUES (2); ELSE VALUES (3); END CASE; END", null],
    ["BEGIN IF 1 = 1 THEN VALUES (1); END IF a; END", "mismatched-block"],
    ["BEGIN BEGIN VALUES (1); END a; END", "mismatched-block"],
    ["BEGIN BEGIN VALUES (1); END 'lbl'; END", "misplaced-block-word"],
    ["BEGIN IF 1 = 1 THEN VALUES (1); END IF 'x'; END", "misplaced-block-word"],
    ["BEGIN VALUES (1); END SELECT 1; END", "misplaced-block-word"],
    ["BEGIN REPEAT VALUES (1); UNTIL true END REPEAT END REPEAT; END", "misplaced-block-word"],
    ["BEGIN VALUES (1); THEN VALUES (2); END", "misplaced-block-word"],
    ["BEGIN VALUES (1); DO VALUES (2); END", "misplaced-block-word"],
    ["BEGIN CASE 1 END CASE; END", "incomplete-block"],
    ["BEGIN CASE END CASE; END", "incomplete-block"],
  ];
  for (const [sql, code] of rows) {
    it(code === null ? `quiet: ${sql}` : `${code}: ${sql}`, () => {
      if (code === null) clean(sql);
      else fires(sql, code);
    });
  }
});

describe("block structure: gives up rather than guess", () => {
  it("a lone BEGIN could be a transaction", () => {
    clean("BEGIN; SELECT 1; COMMIT");
  });
  it("an opener it cannot read leaves the rest of the cell unjudged", () => {
    // `REPEAT (` could be the function or an opener the matcher cannot see.
    clean("BEGIN REPEAT (1); END IF");
  });
  it("a lexical error leaves block structure unjudged", () => {
    assert.deepEqual(blockCodes("BEGIN SELECT 'unterminated; END IF"), []);
  });
});
