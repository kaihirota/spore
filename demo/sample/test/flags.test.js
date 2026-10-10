import { test } from "node:test";
import assert from "node:assert/strict";
import { getFlag, setFlag, listFlags } from "../src/flags.js";

test("unknown flags are off", () => {
  assert.equal(getFlag("missing"), false);
});

test("setFlag changes a flag", () => {
  setFlag("beta", true);
  assert.equal(getFlag("beta"), true);
});

test("listFlags names every flag", () => {
  assert.ok(listFlags().includes("newCheckout"));
});
