import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../src/integrator/inflight";
import { Integrator, Rejected, type MergeFn, type Watcher } from "../../src/integrator/integrator";
import type { MergeResult } from "../../src/git/merge";

let integrator: Integrator;
let results: MergeResult[];
let changesBySha: Record<string, Change[]>;
let clashes: Record<string, string[]>; // "shaA|shaB" -> conflicting files
let conflictChecks: string[][];
let trunkBySha: Record<string, string[]>;
let trunkChecks: string[];

const change = (file: string, symbol: string | null, start = 1): Change => ({ file, start, count: 1, symbol });

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  results = [];
  changesBySha = {};
  clashes = {};
  conflictChecks = [];
  trunkBySha = {};
  trunkChecks = [];
  const merge: MergeFn = async () => {
    const next = results.shift();
    if (!next) throw new Error("no scripted merge result");
    return next;
  };
  const watcher: Watcher = {
    inspect: async ({ forkSha }) => ({ changes: changesBySha[forkSha] ?? [] }),
    trunkClashes: async (sha) => {
      trunkChecks.push(sha);
      return trunkBySha[sha] ?? [];
    },
    conflicts: async (sha, others) => {
      conflictChecks.push(others.map((o) => o.id));
      return others.flatMap((o) => {
        const files = clashes[`${sha}|${o.sha}`] ?? clashes[`${o.sha}|${sha}`];
        return files ? [{ id: o.id, files }] : [];
      });
    },
  };
  integrator = new Integrator((query, ...params) => db.prepare(query).all(...(params as never[])) as never, merge, () => 5_000, watcher);
});

const task = (goal: string, agent: string) => integrator.startTask({ goal, agent, forkRepo: agent, forkUrl: `https://forks/${agent}` });

describe("in-flight changes", () => {
  it("records what an agent is changing and reports no conflicts when it is alone", async () => {
    const audit = task("record every flag change", "agent-audit");
    changesBySha.a1 = [change("src/flags.js", "setFlag", 8)];

    expect(await integrator.progress(audit, "a1")).toEqual({ changes: changesBySha.a1, conflictsWith: [], conflictsWithTrunk: [] });
  });

  it("warns both agents when their in-flight changes would conflict", async () => {
    const audit = task("record every flag change", "agent-audit");
    const validate = task("reject non-boolean values", "agent-validate");
    changesBySha.a1 = [change("src/flags.js", "setFlag", 8)];
    changesBySha.v1 = [change("src/flags.js", "setFlag", 8)];
    clashes["v1|a1"] = ["src/flags.js"];
    await integrator.progress(audit, "a1");

    const result = await integrator.progress(validate, "v1");

    expect(result.conflictsWith).toEqual([{ taskId: audit, agent: "agent-audit", goal: "record every flag change", files: ["src/flags.js"] }]);
    expect(integrator.listInflight().map((t) => [t.agent, t.conflictsWith])).toEqual([
      ["agent-audit", [validate]],
      ["agent-validate", [audit]],
    ]);
  });

  it("only test-merges against agents touching the same files", async () => {
    const audit = task("record every flag change", "agent-audit");
    const docs = task("document flags", "agent-docs");
    const validate = task("reject non-boolean values", "agent-validate");
    changesBySha.a1 = [change("src/flags.js", "setFlag")];
    changesBySha.d1 = [change("README.md", null)];
    changesBySha.v1 = [change("src/flags.js", "setFlag")];
    await integrator.progress(audit, "a1");
    await integrator.progress(docs, "d1");

    await integrator.progress(validate, "v1");

    expect(conflictChecks.at(-1)).toEqual([audit]);
  });

  it("answers who is touching a file: in flight, waiting in the queue, and recently merged", async () => {
    const list = task("sort flag names", "agent-list");
    const audit = task("record every flag change", "agent-audit");
    const previous = task("return the previous value", "agent-previous");
    results.push({ status: "merged", trunkSha: "t1", files: ["src/flags.js"], diff: "" });
    results.push({ status: "conflict", trunkSha: "t1", files: ["src/flags.js"], hunks: "", clashingTasks: [] });
    await integrator.submit({ taskId: list, forkSha: "l1" });
    await integrator.submit({ taskId: previous, forkSha: "p1" });
    changesBySha.a1 = [change("src/flags.js", "setFlag")];
    await integrator.progress(audit, "a1");

    const answer = integrator.touching("src/flags.js");

    expect(answer.inFlight.map((t) => t.agent)).toEqual(["agent-audit"]);
    expect(answer.waiting.map((r) => r.goal)).toEqual(["return the previous value"]);
    expect(answer.merged.map((m) => m.goal)).toEqual(["sort flag names"]);
  });

  it("narrows in-flight agents to those changing a given function", async () => {
    const audit = task("record every flag change", "agent-audit");
    const list = task("sort flag names", "agent-list");
    changesBySha.a1 = [change("src/flags.js", "setFlag")];
    changesBySha.l1 = [change("src/flags.js", "listFlags")];
    await integrator.progress(audit, "a1");
    await integrator.progress(list, "l1");

    expect(integrator.touching("src/flags.js", "listFlags").inFlight.map((t) => t.agent)).toEqual(["agent-list"]);
  });

  it("drops an agent from in flight, and its warnings, once it submits", async () => {
    const audit = task("record every flag change", "agent-audit");
    const validate = task("reject non-boolean values", "agent-validate");
    changesBySha.a1 = [change("src/flags.js", "setFlag")];
    changesBySha.v1 = [change("src/flags.js", "setFlag")];
    clashes["v1|a1"] = ["src/flags.js"];
    await integrator.progress(audit, "a1");
    await integrator.progress(validate, "v1");
    results.push({ status: "merged", trunkSha: "t1", files: ["src/flags.js"], diff: "" });

    await integrator.submit({ taskId: audit, forkSha: "a1" });

    expect(integrator.listInflight()).toEqual([expect.objectContaining({ agent: "agent-validate", conflictsWith: [] })]);
  });

  it("refuses progress for a task that has already been submitted", async () => {
    const audit = task("record every flag change", "agent-audit");
    results.push({ status: "merged", trunkSha: "t1", files: ["src/flags.js"], diff: "" });
    await integrator.submit({ taskId: audit, forkSha: "a1" });

    await expect(integrator.progress(audit, "a2")).rejects.toThrow(Rejected);
  });

  it("finds the task behind a fork so a push event can be attributed", () => {
    const audit = task("record every flag change", "agent-audit");

    expect(integrator.taskForFork("agent-audit")).toBe(audit);
    expect(integrator.taskForFork("unknown-fork")).toBeNull();
  });

  it("returns one task with its in-flight entry so an agent can check its own warnings", async () => {
    const audit = task("record every flag change", "agent-audit");
    const validate = task("reject non-boolean values", "agent-validate");
    changesBySha.a1 = [change("src/flags.js", "setFlag")];
    changesBySha.v1 = [change("src/flags.js", "setFlag")];
    clashes["v1|a1"] = ["src/flags.js"];
    await integrator.progress(audit, "a1");
    await integrator.progress(validate, "v1");

    expect(integrator.task(validate)).toMatchObject({
      id: validate,
      state: "active",
      inflight: { sha: "v1", conflictsWith: [audit] },
    });
    expect(integrator.task("99")).toBeNull();
  });

  it("warns an agent whose push already conflicts with a change on trunk", async () => {
    const audit = task("record every flag change", "agent-audit");
    const validate = task("reject non-boolean values", "agent-validate");
    results.push({ status: "merged", trunkSha: "t1", files: ["src/flags.js"], diff: "" });
    await integrator.submit({ taskId: audit, forkSha: "a1" });
    changesBySha.v1 = [change("src/flags.js", "setFlag")];
    trunkBySha.v1 = [audit];

    const result = await integrator.progress(validate, "v1");

    expect(result.conflictsWithTrunk).toEqual([{ taskId: audit, agent: "agent-audit", goal: "record every flag change" }]);
    expect(integrator.task(validate)?.inflight?.conflictsWithTrunk).toEqual([audit]);
  });

  it("re-checks in-flight agents on the merged files after every merge", async () => {
    const audit = task("record every flag change", "agent-audit");
    const previous = task("return the previous value", "agent-previous");
    const docs = task("document flags", "agent-docs");
    changesBySha.a1 = [change("src/flags.js", "setFlag")];
    changesBySha.p1 = [change("src/flags.js", "setFlag")];
    changesBySha.d1 = [change("README.md", null)];
    await integrator.progress(audit, "a1");
    await integrator.progress(previous, "p1");
    await integrator.progress(docs, "d1");
    trunkChecks = [];
    trunkBySha.p1 = [audit];
    results.push({ status: "merged", trunkSha: "t1", files: ["src/flags.js"], diff: "" });

    await integrator.submit({ taskId: audit, forkSha: "a1" });

    expect(trunkChecks).toEqual(["p1"]);
    expect(integrator.task(previous)?.inflight?.conflictsWithTrunk).toEqual([audit]);
  });
});
