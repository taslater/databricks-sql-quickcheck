// Which documents the extension moves into the `databricks-sql` language mode.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { NotebookLanguage } from "../language";

const NOTEBOOK = "-- Databricks notebook source\nSELECT 1\n";
const SCRIPT = "SELECT 1\n";

/** A switcher whose ticks end only when the test says so. */
function switcher(): { lang: NotebookLanguage; endTick: () => void } {
  let pending: (() => void)[] = [];
  const lang = new NotebookLanguage((f) => pending.push(f));
  return {
    lang,
    endTick: () => {
      const run = pending;
      pending = [];
      run.forEach((f) => f());
    },
  };
}

describe("notebook language", () => {
  it("switches a notebook opened as sql", () => {
    const { lang } = switcher();
    assert.equal(lang.opened("a", "sql", NOTEBOOK), true);
    assert.equal(lang.opened("b", "sql", "﻿" + NOTEBOOK), true);
  });

  it("leaves scripts and other languages alone", () => {
    const { lang } = switcher();
    assert.equal(lang.opened("a", "sql", SCRIPT), false);
    assert.equal(lang.opened("a", "sql", "SELECT 1 -- Databricks notebook source"), false);
    assert.equal(lang.opened("b", "python", NOTEBOOK), false);
    assert.equal(lang.opened("c", "databricks-sql", NOTEBOOK), false);
  });

  it("does not undo the user choosing sql", () => {
    const { lang, endTick } = switcher();
    // The language picker: closed as databricks-sql, reopened as sql, one tick.
    lang.closed("a", "databricks-sql");
    assert.equal(lang.opened("a", "sql", NOTEBOOK), false);
    endTick();
    // Closed and reopened later in the session, it stays where the user put it.
    lang.closed("a", "sql");
    endTick();
    assert.equal(lang.opened("a", "sql", NOTEBOOK), false);
  });

  it("switches again after the user chooses databricks-sql", () => {
    const { lang, endTick } = switcher();
    lang.closed("a", "databricks-sql");
    lang.opened("a", "sql", NOTEBOOK);
    endTick();
    lang.closed("a", "sql");
    assert.equal(lang.opened("a", "databricks-sql", NOTEBOOK), false);
    endTick();
    lang.closed("a", "databricks-sql");
    endTick();
    assert.equal(lang.opened("a", "sql", NOTEBOOK), true);
  });

  it("a reopen in a later tick is not a language change", () => {
    const { lang, endTick } = switcher();
    lang.closed("a", "databricks-sql");
    endTick();
    assert.equal(lang.opened("a", "sql", NOTEBOOK), true);
  });

  it("a close of one document says nothing about another", () => {
    const { lang } = switcher();
    lang.closed("a", "databricks-sql");
    assert.equal(lang.opened("b", "sql", NOTEBOOK), true);
  });
});
