import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, burst } from "../src/limits.js";

test("limits are positive", () => {
  assert.ok(rateLimit() > 0);
  assert.ok(burst() > 0);
});
