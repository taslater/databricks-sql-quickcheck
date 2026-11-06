// Engine-refused scripting fixtures (eval/scripting/invalid.json): one
// block-structure mistake each, with the repaired twin the engine ran.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { check } from "../check";

interface Entry {
  id: string;
  kind: string;
  sql: string;
  twin_sql: string;
}
const data = JSON.parse(readFileSync(join(__dirname, "..", "..", "eval", "scripting", "invalid.json"), "utf8"));
const entries: Entry[] = data.invalid;
const misses = new Set<string>(data.checker_misses);

describe("scripting fixtures: the repaired twins stay quiet", () => {
  for (const e of entries) {
    it(`${e.id} ${e.kind} (twin)`, () => {
      assert.deepEqual(check(e.twin_sql).map((d) => d.code), [], `the engine runs this script:\n${e.twin_sql}`);
    });
  }
});

describe("scripting fixtures: the mistakes are caught", () => {
  for (const e of entries) {
    const missed = misses.has(e.id);
    it(`${e.id} ${e.kind}${missed ? " (known miss)" : ""}`, () => {
      const errors = check(e.sql).filter((d) => d.severity === "error");
      if (missed) {
        assert.equal(errors.length, 0, `${e.id} is now caught: remove it from checker_misses in invalid.json`);
      } else {
        assert.ok(errors.length > 0, `the engine refuses this script, so it needs an error:\n${e.sql}`);
      }
    });
  }
  it("catches most of them", () => {
    assert.ok(entries.length - misses.size >= entries.length * 0.9);
  });
});
