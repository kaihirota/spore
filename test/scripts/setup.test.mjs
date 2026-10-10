import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseQueueId, pickAccount, readConfig, workerUrl } from "../../scripts/setup.mjs";

describe("setup", () => {
  it("reads the namespace, trunk repo and queue from wrangler.jsonc", () => {
    expect(readConfig(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8"))).toEqual({ namespace: "spore", trunk: "trunk", queue: "spore-pushes" });
  });

  it("finds the queue id in queues info output", () => {
    expect(parseQueueId("Queue Name: spore-pushes\nQueue ID: 0123abcd\nCreated On: ...")).toBe("0123abcd");
  });

  it("fails loudly when queues info has no id", () => {
    expect(() => parseQueueId("not found")).toThrow(/no queue id/);
  });

  it("uses the only account the login sees", () => {
    expect(pickAccount({ accounts: [{ name: "me", id: "acc1" }] })).toBe("acc1");
  });

  it("prefers an account named in the environment", () => {
    expect(pickAccount({ accounts: [{ name: "a", id: "1" }, { name: "b", id: "2" }] }, "2")).toBe("2");
  });

  it("asks for an account when the login sees several", () => {
    expect(() => pickAccount({ accounts: [{ name: "a", id: "1" }, { name: "b", id: "2" }] })).toThrow(/CLOUDFLARE_ACCOUNT_ID.*a \(1\), b \(2\)/);
  });

  it("finds the workers.dev URL in deploy output", () => {
    expect(workerUrl("Uploaded spore\nDeployed spore triggers\n  https://spore.me.workers.dev\nCurrent Version ID: x")).toBe("https://spore.me.workers.dev");
  });
});
