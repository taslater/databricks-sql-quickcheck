// The TextMate grammar behind the `databricks-sql` language mode. Each case
// pins a boundary the generic SQL grammar gets wrong for Databricks, and every
// case also asserts that the grammar and the lexer agree on it, character by
// character, so the editor never shows a string the checks do not see.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import type { IGrammar } from "vscode-textmate";
import { firstDisagreement, loadGrammar, tokenize, type Region } from "./textmate";

let g: IGrammar;
before(async () => {
  g = await loadGrammar();
});

/** The region of the `occurrence`-th appearance of `needle` in `text`. */
function regionOf(text: string, needle: string, occurrence = 1): Region {
  let at = -1;
  for (let i = 0; i < occurrence; i++) {
    at = text.indexOf(needle, at + 1);
    assert.ok(at >= 0, `\`${needle}\` (#${occurrence}) not in ${JSON.stringify(text)}`);
  }
  return tokenize(g, text).regions[at];
}

/** Every scope on the token holding the first character of `needle`. */
function scopesOf(text: string, needle: string): string[] {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `\`${needle}\` not in ${JSON.stringify(text)}`);
  const lineNo = text.slice(0, at).split("\n").length - 1;
  const column = at - (text.lastIndexOf("\n", at - 1) + 1);
  const line = tokenize(g, text).lines[lineNo];
  let start = 0;
  for (const t of line) {
    if (column < start + t.text.length) return t.scopes;
    start += t.text.length;
  }
  assert.fail(`no token at \`${needle}\` in ${JSON.stringify(text)}`);
}

function agrees(text: string): void {
  const d = firstDisagreement(g, text);
  assert.equal(d, undefined, d && `${d.line}:${d.column}: lexer says ${d.lexer}, grammar says ${d.grammar}: ${d.context}`);
}

/** Assert each needle's region, and that the grammar agrees with the lexer throughout. */
function expect(text: string, regions: [string, Region][]): void {
  for (const [needle, want] of regions) assert.equal(regionOf(text, needle), want, `\`${needle}\` in ${JSON.stringify(text)}`);
  agrees(text);
}

describe("strings", () => {
  it("a backslash escapes a quote", () => {
    // The generic grammar closes the string at `\'` and opens a new one at
    // the next apostrophe, inverting the colours of the rest of the file.
    expect("SELECT 'it\\'s here' AS a FROM t -- isn't\n", [
      ["s here", "string"],
      ["AS", "code"],
      ["FROM", "code"],
      ["isn", "comment"],
    ]);
  });

  it("a doubled quote does not end the string", () => {
    expect("SELECT 'a''b' AS c", [["b'", "string"], ["AS", "code"]]);
  });

  it("an escaped backslash before the closing quote", () => {
    expect("SELECT 'C:\\\\' AS p, 'x' AS q", [["AS p", "code"], ["x'", "string"], ["AS q", "code"]]);
  });

  it("double quotes delimit a string, with the same escapes", () => {
    expect('SELECT "say \\"hi\\"" AS a', [["hi", "string"], ["AS", "code"]]);
    assert.ok(scopesOf('SELECT "x" AS a', "x").includes("string.quoted.double.databricks-sql"));
  });

  it("a raw string takes backslash literally", () => {
    expect("SELECT r'C:\\' AS p, R\"D:\\\" AS q", [
      ["C:", "string"],
      ["AS p", "code"],
      ["D:", "string"],
      ["AS q", "code"],
    ]);
    assert.ok(scopesOf("SELECT r'x'", "r").includes("storage.type.string.raw.databricks-sql"));
  });

  it("r at the end of a name is not a raw-string prefix", () => {
    expect("SELECT bar'\\'x' AS a", [["x'", "string"], ["AS", "code"]]);
  });

  it("an unclosed string runs on, as the lexer reads it", () => {
    expect("SELECT 'open\nFROM t\n", [["FROM", "string"]]);
  });
});

describe("identifiers, comments and bodies", () => {
  it("a backtick identifier doubles its backtick and takes backslash literally", () => {
    expect("SELECT `a``b`, `c\\` AS d", [["b`", "identifier"], ["c", "identifier"], ["AS", "code"]]);
  });

  it("bracketed comments nest", () => {
    expect("/* a /* b */ c */ SELECT 1", [["c", "comment"], ["SELECT", "code"]]);
  });

  it("a quote inside a comment opens nothing", () => {
    expect("-- don't\nSELECT 1 /* it's */ AS a", [["SELECT", "code"], ["AS", "code"]]);
  });

  it("a $$ body is opaque, whatever it contains", () => {
    expect("CREATE FUNCTION f() RETURNS INT AS $$ it's -- ' $$; SELECT 1", [
      ["it", "body"],
      ["--", "body"],
      ["SELECT", "code"],
    ]);
  });

  it("LANGUAGE PYTHON and LANGUAGE YAML embed their bodies", () => {
    const py = "CREATE FUNCTION f(x INT) RETURNS INT\nLANGUAGE PYTHON\nAS $$\nreturn x + 1\n$$;\nSELECT 1";
    expect(py, [["return", "body"], ["SELECT", "code"]]);
    assert.ok(scopesOf(py, "return x + 1").includes("meta.embedded.block.python"));
    const yaml = "CREATE VIEW v WITH METRICS LANGUAGE YAML AS $$\nversion: 1.1\n$$";
    expect(yaml, [["version", "body"]]);
    assert.ok(scopesOf(yaml, "version: 1.1").includes("meta.embedded.block.yaml"));
  });

  it("a LANGUAGE region with no body closes at the end of the statement", () => {
    const text = "CREATE FUNCTION f() RETURNS INT LANGUAGE PYTHON;\nSELECT $$ x $$";
    expect(text, [["x", "body"]]);
    assert.ok(!scopesOf(text, " x ").includes("meta.embedded.block.python"));
  });

  it("templates and widget parameters", () => {
    expect("SELECT ${a.b}, $w, {{ p }} FROM t {% if x %} {# c #}", [
      ["a.b", "template"],
      ["$w", "template"],
      ["p }}", "template"],
      ["if", "template"],
      ["c #", "template"],
      ["FROM", "code"],
    ]);
  });
});

describe("notebooks", () => {
  const header = "-- Databricks notebook source\n";
  const sep = "\n-- COMMAND ----------\n";

  it("an unclosed quote stops at the cell boundary", () => {
    expect(`${header}SELECT 'open${sep}SELECT 1 AS a`, [["AS", "code"]]);
  });

  it("an unclosed comment stops at the cell boundary", () => {
    expect(`${header}/* open${sep}SELECT 1 AS a`, [["AS", "code"]]);
  });

  it("separators and the header are comments", () => {
    const text = `${header}SELECT 1${sep}SELECT 2`;
    expect(text, [["COMMAND", "comment"], ["Databricks", "comment"]]);
    assert.ok(scopesOf(text, "-- COMMAND ----------").includes("meta.separator.cell.databricks-sql"));
  });

  it("a magic command opens a cell only as its first text", () => {
    // From SQLFluff's bare_magic_first_line fixture: later in a cell, `%md`
    // is the modulo operator applied to a column called md.
    const text = `${header}${sep}%python\nprint("it's")${sep}SELECT\n    a\n    %md AS still_modulo\nFROM t`;
    expect(text, [
      ["print", "comment"],
      ["SELECT", "code"],
      ["md AS", "code"],
    ]);
  });

  it("a %sql cell is SQL", () => {
    expect(`${header}${sep}%sql\nSELECT 'x' AS a`, [["SELECT", "code"], ["x'", "string"]]);
  });

  it("a file may open with a magic command", () => {
    expect("%python\nprint('x')\n", [["print", "comment"]]);
    expect("%sql\nSELECT 1", [["SELECT", "code"]]);
  });

  it("MAGIC lines are comments, coloured as markdown or Python", () => {
    const text = `${header}${sep}-- MAGIC %md\n-- MAGIC # Title it's\n${sep}-- MAGIC %python\n-- MAGIC x = 'a'${sep}SELECT 1`;
    expect(text, [["Title", "comment"], ["x =", "comment"], ["SELECT", "code"]]);
    assert.ok(scopesOf(text, " # Title it's").includes("meta.magic-cell.markdown.databricks-sql"));
    assert.ok(scopesOf(text, " x = 'a'").includes("meta.magic-cell.python.databricks-sql"));
  });
});

describe("parameters and names", () => {
  it(":name is a parameter, but not a JSON path or a cast", () => {
    const text = "SELECT raw:owner, x::INT FROM t WHERE k = :wanted";
    assert.ok(scopesOf(text, "wanted").includes("variable.parameter.named.databricks-sql"));
    assert.ok(!scopesOf(text, "owner").some((s) => s.startsWith("variable.parameter")));
    assert.ok(scopesOf(text, "::").includes("keyword.operator.cast.databricks-sql"));
    agrees(text);
  });

  it("a keyword after a dot is a name", () => {
    const text = "SELECT t.from FROM t";
    assert.ok(!scopesOf(text, "from").some((s) => s.startsWith("keyword")));
    assert.ok(scopesOf(text, "FROM").includes("keyword.other.databricks-sql"));
  });
});

describe("keyword groups", () => {
  const CLAUSE = "keyword.other.databricks-sql";
  const PREDICATE = "keyword.operator.wordlike.predicate.databricks-sql";
  const LOGIC = "keyword.operator.wordlike.logical.databricks-sql";
  const FLOW = "keyword.control.flow.databricks-sql";

  /** The single scope-carrying token that `phrase` must be, whole. */
  function phrase(text: string, words: string, scope: string): void {
    const at = text.indexOf(words);
    assert.ok(at >= 0, `\`${words}\` not in ${JSON.stringify(text)}`);
    const lineNo = text.slice(0, at).split("\n").length - 1;
    const column = at - (text.lastIndexOf("\n", at - 1) + 1);
    let start = 0;
    for (const t of tokenize(g, text).lines[lineNo]) {
      if (column < start + t.text.length) {
        assert.equal(t.text, words, `\`${words}\` is split in ${JSON.stringify(text)}`);
        assert.ok(t.scopes.includes(scope), `\`${words}\` is ${t.scopes.at(-1)}, want ${scope}`);
        return;
      }
      start += t.text.length;
    }
    assert.fail(`no token at \`${words}\``);
  }

  it("keeps a predicate phrase whole", () => {
    const text = "SELECT 1 WHERE a IS NOT DISTINCT FROM b AND c IS NULL AND d NOT IN (1) AND NOT EXISTS (SELECT 1)";
    phrase(text, "IS NOT DISTINCT FROM", PREDICATE);
    phrase(text, "IS NULL", PREDICATE);
    phrase(text, "NOT IN", PREDICATE);
    phrase(text, "NOT EXISTS", PREDICATE);
    phrase(text, "AND", LOGIC);
  });

  it("gives AND, OR and NOT the connective group", () => {
    const text = "SELECT 1 WHERE a OR NOT b";
    phrase(text, "OR", LOGIC);
    phrase(text, "NOT", LOGIC);
  });

  it("gives BETWEEN its own AND, and a window frame's to the clause", () => {
    const text = "SELECT sum(x) OVER (ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t WHERE h BETWEEN 1 AND 5 AND k";
    phrase(text, "ROWS BETWEEN", CLAUSE);
    assert.ok(scopesOf(text, "AND CURRENT").includes(CLAUSE));
    assert.ok(scopesOf(text, "BETWEEN 1 AND 5").includes(PREDICATE));
    assert.ok(scopesOf(text, "AND 5").includes(PREDICATE));
    assert.ok(scopesOf(text, "AND k").includes(LOGIC));
  });

  it("frames a MERGE branch as flow, with its condition and action apart", () => {
    const text = "MERGE INTO t USING s ON t.id = s.id\nWHEN NOT MATCHED BY SOURCE AND t.x THEN DELETE\nWHEN NOT MATCHED\n  BY TARGET THEN INSERT *";
    phrase(text, "WHEN NOT MATCHED BY SOURCE", FLOW);
    phrase(text, "BY TARGET", FLOW);
    phrase(text, "THEN", FLOW);
    assert.ok(scopesOf(text, "AND t.x").includes(LOGIC));
    assert.ok(scopesOf(text, "DELETE").includes(CLAUSE));
  });

  it("colours a CASE as flow", () => {
    const text = "SELECT CASE WHEN a THEN 1 ELSE 2 END";
    for (const w of ["CASE", "WHEN", "THEN", "ELSE", "END"]) assert.ok(scopesOf(text, w).includes(FLOW), w);
  });

  it("reads DDL: types, constraints, OR REPLACE, schedules", () => {
    const text = [
      "CREATE OR REPLACE TABLE main.s.orders (",
      "  id BIGINT NOT NULL COMMENT 'k',",
      "  CONSTRAINT fk FOREIGN KEY (id) REFERENCES main.s.customers (id) NOT ENFORCED RELY",
      ") SCHEDULE EVERY 2 HOURS AS SELECT * FROM STREAM read_files('x')",
    ].join("\n");
    phrase(text, "OR REPLACE", CLAUSE);
    assert.ok(scopesOf(text, "BIGINT").includes("support.type.databricks-sql"));
    phrase(text, "NOT NULL", CLAUSE);
    phrase(text, "NOT ENFORCED", CLAUSE);
    phrase(text, "RELY", CLAUSE);
    phrase(text, "HOURS", CLAUSE);
    phrase(text, "STREAM", CLAUSE);
    for (const w of ["orders (", "customers ("]) {
      assert.ok(!scopesOf(text, w).some((s) => s.startsWith("support.function")), `${w} is a table, not a call`);
    }
    assert.ok(scopesOf(text, "read_files").includes("support.function.databricks-sql"));
  });

  it("leaves a table called stream alone", () => {
    const text = "SELECT * FROM stream WHERE x";
    assert.ok(!scopesOf(text, "stream").some((s) => s.startsWith("keyword")));
  });

  it("reads DECLARE as a statement, not flow", () => {
    assert.ok(scopesOf("BEGIN DECLARE v INT; END", "DECLARE").includes(CLAUSE));
  });

  it("reads a constraint and IF NOT EXISTS as clauses", () => {
    const text = "CREATE TABLE IF NOT EXISTS t (id BIGINT NOT NULL, PRIMARY KEY (id))";
    phrase(text, "IF NOT EXISTS", CLAUSE);
    phrase(text, "NOT NULL", CLAUSE);
    phrase(text, "PRIMARY KEY", CLAUSE);
  });

  it("leaves SOURCE, TARGET and KEY as names elsewhere", () => {
    const text = "SELECT source, target, key FROM t ORDER BY target\nGROUP BY source";
    for (const w of ["source,", "target,", "key", "target\n", "source\n".trim()]) {
      assert.ok(!scopesOf(text, w).some((s) => s.startsWith("keyword")), w);
    }
    const last = tokenize(g, text).lines[1].at(-1)!;
    assert.equal(last.text.trim(), "source");
    assert.ok(!last.scopes.some((s) => s.startsWith("keyword")));
  });

  it("reads if( as a function and IF as flow", () => {
    const text = "BEGIN IF x THEN SELECT if(a, 1, 0); END IF; END";
    assert.ok(scopesOf(text, "if(").includes("support.function.databricks-sql"));
    assert.ok(scopesOf(text, "IF x").includes(FLOW));
    for (const w of ["END IF", "IF;"]) assert.ok(scopesOf(text, w).includes(FLOW), w);
  });
});

describe("agreement with the lexer", () => {
  it("on every example in the repo", () => {
    const dir = path.join(__dirname, "..", "..", "examples");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql"))) agrees(fs.readFileSync(path.join(dir, f), "utf8"));
  });
});
