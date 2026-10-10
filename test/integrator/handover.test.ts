import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../src/integrator/inflight";
import { Integrator, Rejected, type Handovers, type MergeFn, type Watcher } from "../../src/integrator/integrator";
import type { MergeResult } from "../../src/git/merge";

let integrator: Integrator;
let results: MergeResult[];
let changesBySha: Record<string, Change[]>;
let clashes: Record<string, string[]>; // "shaA|shaB" -> conflicting files
let clock: number;
let madeAt: Record<string, number>; // commit time by sha; the clock when absent
let operations: string[];
let refuse: Set<string>; // task ids whose container operation fails its tests

const change = (file: string, symbol: string, count = 1): Change => ({ file, start: 2, count, symbol });

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  results = [];
  changesBySha = {};
  clashes = {};
  clock = 1_000;
  madeAt = {};
  operations = [];
  refuse = new Set();
  const merge: MergeFn = async () => {
    const next = results.shift();
    if (!next) throw new Error("no scripted merge result");
    return next;
  };
  const watcher: Watcher = {
    inspect: async ({ forkSha }) => ({ changes: changesBySha[forkSha] ?? [], committedAt: madeAt[forkSha] ?? clock }),
    trunkClashes: async () => [],
    conflicts: async (sha, others) =>
      others.flatMap((o) => {
        const files = clashes[`${sha}|${o.sha}`] ?? clashes[`${o.sha}|${sha}`];
        return files ? [{ id: o.id, files }] : [];
      }),
  };
  const handovers: Handovers = {
    drop: async (req) => {
      operations.push(`drop ${req.taskId} ${req.symbols.join(",")}`);
      return refuse.has(req.taskId) ? { status: "refused", reason: "tests failed: drop breaks it" } : { status: "done", sha: `dropped-${req.taskId}` };
    },
    flatten: async (req) => {
      operations.push(`flatten ${req.taskId}`);
      return refuse.has(req.taskId) ? { status: "refused", reason: "tests failed: before check" } : { status: "done", sha: `flat-${req.taskId}` };
    },
  };
  integrator = new Integrator((query, ...params) => db.prepare(query).all(...(params as never[])) as never, merge, () => clock, watcher, handovers);
});

const task = (goal: string, agent: string) => integrator.startTask({ goal, agent, forkRepo: agent, forkUrl: `https://forks/${agent}` });
const summary = (id: string) => integrator.listTasks().find((t) => t.id === id)!;

describe("coordinator queries", () => {
  // agent-2 changes health first; agent-9's first push lands on the same lines ten seconds later.
  const newcomer = async () => {
    const version = task("report the service version", "agent-2");
    const uptime = task("report the uptime", "agent-9");
    changesBySha.v1 = changesBySha.u1 = [change("src/health.js", "health")];
    clashes["u1|v1"] = ["src/health.js"];
    await integrator.progress(version, "v1");
    clock += 10_000;
    await integrator.progress(uptime, "u1");
    return { version, uptime };
  };

  it("asks both agents whether their change is required when a first push meets established work", async () => {
    const { version, uptime } = await newcomer();

    expect(summary(uptime).question).toMatchObject({ about: "health in src/health.js", answer: null });
    expect(summary(version).question).toMatchObject({ about: "health in src/health.js", answer: null });
  });

  it("does not ask agents that started on the lines together", async () => {
    const audit = task("record every flag change", "agent-6");
    const validate = task("reject non-boolean values", "agent-7");
    changesBySha.a1 = changesBySha.b1 = [change("src/flags.js", "setFlag")];
    clashes["b1|a1"] = ["src/flags.js"];
    await integrator.progress(audit, "a1");
    clock += 1_000;

    await integrator.progress(validate, "b1");

    expect(summary(validate).question).toBeNull();
  });

  it("measures the head start by when commits were made, not when pushes were inspected", async () => {
    const up = task("rate limit 200", "agent-3");
    const down = task("rate limit 50", "agent-4");
    changesBySha.a1 = changesBySha.b1 = [change("src/limits.js", "rateLimit")];
    clashes["b1|a1"] = ["src/limits.js"];
    await integrator.progress(up, "a1");
    madeAt.b1 = clock + 300;
    clock += 10_000;

    await integrator.progress(down, "b1");

    expect(summary(down).question).toBeNull();
  });

  it("waits for every answer before giving verdicts", async () => {
    const { uptime } = await newcomer();

    expect(await integrator.answer(uptime, "agent-9", true, "uptime is the health response")).toEqual({ state: "waiting" });
    expect(summary(uptime).verdict).toBeNull();
  });

  it("hands the later task to the earliest when both changes are required", async () => {
    const { version, uptime } = await newcomer();
    await integrator.answer(version, "agent-2", true, "the version goes in the health response");

    await integrator.answer(uptime, "agent-9", true, "uptime goes in the health response");

    expect(operations).toEqual([`flatten ${uptime}`]);
    expect(summary(version).verdict).toMatchObject({ decision: "continue", state: "done" });
    expect(summary(uptime)).toMatchObject({ agent: "agent-2", handedFrom: "agent-9", verdict: { decision: "handover", to: "agent-2", state: "done" } });
  });

  it("has an agent drop an optional change and keep its task", async () => {
    const { version, uptime } = await newcomer();
    await integrator.answer(version, "agent-2", true, "the version goes in the health response");

    await integrator.answer(uptime, "agent-9", false, "only tidied the health function");

    expect(operations).toEqual([`drop ${uptime} health`]);
    expect(summary(uptime)).toMatchObject({ agent: "agent-9", verdict: { decision: "drop", state: "done" } });
  });

  it("keeps the task where it is when the before check fails", async () => {
    const { version, uptime } = await newcomer();
    refuse.add(uptime);
    await integrator.answer(version, "agent-2", true, "needed");

    await integrator.answer(uptime, "agent-9", true, "needed");

    expect(summary(uptime)).toMatchObject({ agent: "agent-9", verdict: { decision: "handover", state: "refused", reason: "tests failed: before check" } });
  });

  it("counts an agent that does not answer in time as required", async () => {
    const { version, uptime } = await newcomer();
    await integrator.answer(uptime, "agent-9", true, "needed");
    clock += 30_000;

    await integrator.settleDue();

    expect(summary(version).verdict).toMatchObject({ decision: "continue" });
    expect(summary(uptime)).toMatchObject({ agent: "agent-2", verdict: { decision: "handover" } });
  });

  it("never hands over between agents whose goals contradict", async () => {
    const { version, uptime } = await newcomer();
    integrator.recordJudgement(version, uptime, true, "both set the health response");
    await integrator.answer(version, "agent-2", true, "needed");

    await integrator.answer(uptime, "agent-9", true, "needed");

    expect(operations).toEqual([]);
    expect(summary(uptime)).toMatchObject({ agent: "agent-9", verdict: { decision: "continue" } });
  });

  it("drops the warning between two tasks once one agent holds both", async () => {
    const { version, uptime } = await newcomer();
    await integrator.answer(version, "agent-2", true, "needed");
    await integrator.answer(uptime, "agent-9", true, "needed");

    expect(integrator.task(version)?.inflight?.conflictsWith).toEqual([]);
  });

  it("refuses an answer from an agent that does not hold the task", async () => {
    const { uptime } = await newcomer();

    await expect(integrator.answer(uptime, "agent-3", true, "")).rejects.toThrow(Rejected);
  });

  it("refuses an answer for a task with no question", async () => {
    const lone = task("document a flag", "agent-1");

    await expect(integrator.answer(lone, "agent-1", true, "")).rejects.toThrow(Rejected);
  });

  it("checks that an agent holds a task before it gets access to the fork", async () => {
    const { version, uptime } = await newcomer();
    await integrator.answer(version, "agent-2", true, "needed");
    await integrator.answer(uptime, "agent-9", true, "needed");

    expect(integrator.forkOf(uptime, "agent-2")).toEqual({ repo: "agent-9", url: "https://forks/agent-9" });
    expect(() => integrator.forkOf(uptime, "agent-9")).toThrow(Rejected);
  });
});

describe("contradictions", () => {
  const clashingPair = async () => {
    const up = task("set the rate limit to exactly 200", "agent-3");
    const down = task("set the rate limit to exactly 50", "agent-4");
    changesBySha.a1 = changesBySha.b1 = [change("src/limits.js", "rateLimit")];
    clashes["b1|a1"] = ["src/limits.js"];
    await integrator.progress(up, "a1");
    await integrator.progress(down, "b1");
    return { up, down };
  };

  it("lists each pair of clashing tasks once for judging", async () => {
    const { up, down } = await clashingPair();

    expect(integrator.pairsToJudge()).toEqual([{ a: up, b: down, goalA: "set the rate limit to exactly 200", goalB: "set the rate limit to exactly 50" }]);
    integrator.recordJudgement(up, down, false, "");
    expect(integrator.pairsToJudge()).toEqual([]);
  });

  it("flags both tasks when their goals contradict", async () => {
    const { up, down } = await clashingPair();

    integrator.recordJudgement(up, down, true, "200 and 50 cannot both be the limit");

    expect(summary(down).contradiction).toEqual({ with: up, agent: "agent-3", reason: "200 and 50 cannot both be the limit" });
    expect(summary(up).contradiction).toMatchObject({ with: down, agent: "agent-4" });
  });

  it("sends a record between contradicting tasks straight to a person", async () => {
    const { up, down } = await clashingPair();
    integrator.recordJudgement(up, down, true, "200 and 50 cannot both be the limit");
    results.push({ status: "merged", trunkSha: "t1", files: ["src/limits.js"], diff: "" });
    await integrator.submit({ taskId: up, forkSha: "a1" });
    results.push({ status: "conflict", trunkSha: "t1", files: ["src/limits.js"], hunks: "<<<<<<<", clashingTasks: [up] });

    await integrator.submit({ taskId: down, forkSha: "b1" });

    expect(integrator.record(1)).toMatchObject({ state: "escalated", reason: "contradicts agent-3: 200 and 50 cannot both be the limit" });
    expect(integrator.claim("resolver-1")).toBeNull();
  });
});
