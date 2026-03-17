import test from "node:test";
import assert from "node:assert/strict";

import {
  boolOption,
  listify,
  parseArgs,
  parseInputs
} from "../bin/cli-utils.js";

test("parseArgs parses flags, duplicates, and positionals", () => {
  const parsed = parseArgs([
    "run",
    "hello",
    "--surface",
    "browser",
    "--input",
    "goal=ship",
    "--input",
    "mode=auto",
    "--json"
  ]);

  assert.equal(parsed.positionals[0], "run");
  assert.equal(parsed.positionals[1], "hello");
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.surface, "browser");
  assert.deepEqual(parsed.options.input, ["goal=ship", "mode=auto"]);
});

test("boolOption handles common false values and last-write-wins", () => {
  assert.equal(boolOption("true"), true);
  assert.equal(boolOption("false"), false);
  assert.equal(boolOption("0"), false);
  assert.equal(boolOption(["true", "0"]), false);
  assert.equal(boolOption(true), true);
  assert.equal(boolOption(undefined), false);
});

test("listify and parseInputs support repeated and invalid values", () => {
  assert.deepEqual(listify(undefined), []);
  assert.deepEqual(listify(["a", "b"]), ["a", "b"]);

  const parsed = parseInputs(["goal=ship", "invalid", "note=contains=equals"]);
  assert.deepEqual(parsed, {
    goal: "ship",
    note: "contains=equals"
  });
});
