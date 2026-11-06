// Engine-verified scripting fixtures (eval/scripting/*.json). Each script was
// run on a Databricks SQL warehouse: everything in `valid` ran, so the
// checker must say nothing about it. This is the false-positive gate for the
// block-structure pass, because the published corpus holds almost no
// scripting to guard it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { check } from "../check";

const load = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "eval", "scripting", name), "utf8"));

describe("scripting fixtures: engine-accepted scripts stay quiet", () => {
  const valid: { id: string; tags: string[]; sql: string }[] = load("valid.json").valid;
  it("has the fixtures", () => assert.ok(valid.length >= 200));
  for (const v of valid) {
    it(`${v.id} ${v.tags.join(",")}`, () => {
      assert.deepEqual(
        check(v.sql).map((d) => `${d.code}@${d.line}:${d.column}`),
        [],
        `the engine accepts this script, so nothing may be reported:\n${v.sql}`,
      );
    });
  }
});
