import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Integrator, LEASE_MS, Rejected, notifyOnWrite, type MergeFn } from "../../src/integrator/integrator";
import type { MergeResult } from "../../src/git/merge";

let results: MergeResult[];
let calls: Parameters<MergeFn>[0][];
let clock: number;
let integrator: Integrator;

const merged = (trunkSha: string, files: string[]): MergeResult => ({ status: "merged", trunkSha, files, diff: `diff for ${trunkSha}` });
const conflict = (files: string[], clashingTasks: string[] = []): MergeResult => ({
  status: "conflict",
  trunkSha: "t0",
  files,
  hunks: "<<<<<<< HEAD",
  clashingTasks,
});
const failed: MergeResult = { status: "tests_failed", trunkSha: "t0", output: "1 failing" };

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  results = [];
  calls = [];
  clock = 1_000;
  const merge: MergeFn = async (req) => {
    calls.push(req);
    const next = results.shift();
    if (!next) throw new Error("no scripted merge result");
    return next;
  };
  integrator = new Integrator((query, ...params) => db.prepare(query).all(...(params as never[])) as never, merge, () => clock);
});

function task(goal: string, agent = "agent-1") {
  const name = goal.replaceAll(" ", "-");
  return integrator.startTask({ goal, agent, forkRepo: name, forkUrl: `https://forks/${name}` });
}

describe("Integrator", () => {
  it("returns merged with the new trunk commit for a clean change", async () => {
    const id = task("rate limit flags");
    results.push(merged("t1", ["flags.ts"]));

    expect(await integrator.submit({ taskId: id, forkSha: "f1" })).toEqual({ status: "merged", trunkSha: "t1" });
    expect(calls[0]).toMatchObject({ forkRepo: "rate-limit-flags", forkUrl: "https://forks/rate-limit-flags", forkSha: "f1", trailers: { Task: id } });
  });

  it("queues a conflict as a record naming the goal it clashed with", async () => {
    const first = task("rate limit flags");
    const second = task("lower the limit", "agent-2");
    results.push(merged("t1", ["flags.ts"]), conflict(["flags.ts"]));
    await integrator.submit({ taskId: first, forkSha: "f1" });

    const result = await integrator.submit({ taskId: second, forkSha: "f2" });

    expect(result).toEqual({ status: "queued", record: 1 });
    expect(integrator.claim("resolver-1")).toMatchObject({
      id: 1,
      kind: "merge",
      goal: "lower the limit",
      clashingGoal: "rate limit flags",
      forkRepo: "lower-the-limit",
      forkUrl: "https://forks/lower-the-limit",
      forkSha: "f2",
      files: ["flags.ts"],
      detail: "<<<<<<< HEAD",
    });
  });

  it("maps the blamed task ids to their goals instead of the latest change to the file", async () => {
    const audit = task("record every flag change");
    const list = task("sort flag names");
    const validate = task("reject non-boolean values");
    results.push(merged("t1", ["flags.ts"]), merged("t2", ["flags.ts"]), conflict(["flags.ts"], [audit]));
    await integrator.submit({ taskId: audit, forkSha: "f1" });
    await integrator.submit({ taskId: list, forkSha: "f2" });

    await integrator.submit({ taskId: validate, forkSha: "f3" });

    expect(integrator.record(1)?.clashingGoal).toBe("record every flag change");
  });

  it("queues failing tests as a record of kind tests", async () => {
    const id = task("break the limit");
    results.push(failed);

    expect(await integrator.submit({ taskId: id, forkSha: "f1" })).toEqual({ status: "queued", record: 1 });
    expect(integrator.claim("resolver-1")).toMatchObject({ kind: "tests", detail: "1 failing" });
  });

  it("runs concurrent submits one at a time", async () => {
    let running = 0;
    let maxRunning = 0;
    const db = new DatabaseSync(":memory:");
    const slow = new Integrator(
      (query, ...params) => db.prepare(query).all(...(params as never[])) as never,
      async () => {
        maxRunning = Math.max(maxRunning, ++running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return { status: "merged", trunkSha: "t", files: ["a.ts"], diff: "" };
      },
      () => clock,
    );
    const ids = [1, 2, 3].map((n) => slow.startTask({ goal: `g${n}`, agent: "a", forkRepo: `r${n}`, forkUrl: `u${n}` }));

    await Promise.all(ids.map((taskId) => slow.submit({ taskId, forkSha: "s" })));

    expect(maxRunning).toBe(1);
  });

  it("gives out the oldest open record and holds it for the lease", async () => {
    const a = task("first");
    const b = task("second");
    results.push(conflict(["x.ts"]), conflict(["y.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    await integrator.submit({ taskId: b, forkSha: "f2" });

    expect(integrator.claim("resolver-1")?.id).toBe(1);
    expect(integrator.claim("resolver-2")?.id).toBe(2);
    expect(integrator.claim("resolver-3")).toBeNull();
  });

  it("holds back a record on a file another resolver is already fixing", async () => {
    const ids = ["a", "b", "c"].map((goal) => task(goal));
    results.push(conflict(["x.ts"]), conflict(["x.ts", "z.ts"]), conflict(["y.ts"]));
    for (const id of ids) await integrator.submit({ taskId: id, forkSha: "f" });

    expect(integrator.claim("resolver-1")?.id).toBe(1);
    expect(integrator.claim("resolver-2")?.id).toBe(3);
    expect(integrator.claim("resolver-3")).toBeNull();
  });

  it("gives out a held-back record once the one on its file is settled", async () => {
    const ids = ["a", "b"].map((goal) => task(goal));
    results.push(conflict(["x.ts"]), conflict(["x.ts"]));
    for (const id of ids) await integrator.submit({ taskId: id, forkSha: "f" });
    integrator.claim("resolver-1");

    integrator.escalate(1, "resolver-1", "cannot");

    expect(integrator.claim("resolver-2")?.id).toBe(2);
  });

  it("adds the other first-try records on the same files to a resolver's claim", async () => {
    const ids = ["a", "b", "c", "d"].map((goal) => task(goal));
    results.push(conflict(["x.ts"]), conflict(["x.ts"]), conflict(["y.ts"]), conflict(["x.ts", "y.ts"]));
    for (const id of ids) await integrator.submit({ taskId: id, forkSha: "f" });
    integrator.claim("resolver-1");

    expect(integrator.claimAlso("resolver-1", 1).map((r) => r.id)).toEqual([2]);
    expect(integrator.record(2)?.state).toBe("claimed");
  });

  it("closes every record a batched fix resolves", async () => {
    const ids = ["a", "b"].map((goal) => task(goal));
    results.push(conflict(["x.ts"]), conflict(["x.ts"]), merged("t3", ["x.ts"]));
    for (const id of ids) await integrator.submit({ taskId: id, forkSha: "f" });
    integrator.claim("resolver-1");
    integrator.claimAlso("resolver-1", 1);
    const fix = integrator.startTask({ goal: "resolve #1, #2", agent: "resolver-1", forkRepo: "fix", forkUrl: "fix", resolves: 1 });

    await integrator.submit({ taskId: fix, forkSha: "f9", resolves: 1, alsoResolves: [2] });

    expect([integrator.record(1)?.state, integrator.record(2)?.state]).toEqual(["merged", "merged"]);
    expect(calls[2].trailers).toEqual({ Task: fix, Resolves: "#1, #2" });
    expect(integrator.fixFor(2)?.taskId).toBe(fix);
  });

  it("reopens every record of a batched fix that fails", async () => {
    const ids = ["a", "b"].map((goal) => task(goal));
    results.push(conflict(["x.ts"]), conflict(["x.ts"]), failed);
    for (const id of ids) await integrator.submit({ taskId: id, forkSha: "f" });
    integrator.claim("resolver-1");
    integrator.claimAlso("resolver-1", 1);
    const fix = integrator.startTask({ goal: "resolve #1, #2", agent: "resolver-1", forkRepo: "fix", forkUrl: "fix", resolves: 1 });

    await integrator.submit({ taskId: fix, forkSha: "f9", resolves: 1, alsoResolves: [2] });

    expect([integrator.record(1), integrator.record(2)].map((r) => [r?.state, r?.attempts])).toEqual([["open", 1], ["open", 1]]);
  });

  it("refuses a batched fix for a record the resolver does not hold", async () => {
    const ids = ["a", "b"].map((goal) => task(goal));
    results.push(conflict(["x.ts"]), conflict(["x.ts"]));
    for (const id of ids) await integrator.submit({ taskId: id, forkSha: "f" });
    integrator.claim("resolver-1");
    const fix = integrator.startTask({ goal: "resolve #1", agent: "resolver-1", forkRepo: "fix", forkUrl: "fix", resolves: 1 });

    await expect(integrator.submit({ taskId: fix, forkSha: "f9", resolves: 1, alsoResolves: [2] })).rejects.toThrow(/#2 is not claimed/);
  });

  it("releases a claimed record back to the queue", async () => {
    const a = task("a");
    results.push(conflict(["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f" });
    integrator.claim("resolver-1");

    integrator.release(1, "resolver-1");

    expect(integrator.claim("resolver-2")?.id).toBe(1);
  });

  it("reopens a record whose lease expired", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");

    clock += LEASE_MS + 1;

    expect(integrator.claim("resolver-2")?.id).toBe(1);
  });

  it("closes a record when the resolver's fix merges", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]), merged("t2", ["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");
    const fix = task("resolve #1", "resolver-1");

    const result = await integrator.submit({ taskId: fix, forkSha: "f9", resolves: 1 });

    expect(result).toEqual({ status: "merged", trunkSha: "t2" });
    expect(calls[1].trailers).toEqual({ Task: fix, Resolves: "#1" });
    expect(integrator.record(1)?.state).toBe("merged");
    expect(integrator.claim("resolver-2")).toBeNull();
  });

  it("reopens a record after one failed fix and escalates after two", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]), conflict(["x.ts"]), failed);
    await integrator.submit({ taskId: a, forkSha: "f1" });
    const fix = task("resolve #1", "resolver-1");

    integrator.claim("resolver-1");
    expect(await integrator.submit({ taskId: fix, forkSha: "f2", resolves: 1 })).toEqual({ status: "queued", record: 1 });
    expect(integrator.record(1)?.state).toBe("open");

    integrator.claim("resolver-1");
    await integrator.submit({ taskId: fix, forkSha: "f3", resolves: 1 });

    expect(integrator.record(1)).toMatchObject({ state: "escalated", attempts: 2 });
    expect(integrator.claim("resolver-2")).toBeNull();
  });

  it("escalates a record when a resolver gives up", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");

    integrator.escalate(1, "resolver-1", "goals contradict");

    expect(integrator.record(1)).toMatchObject({ state: "escalated", reason: "goals contradict" });
  });

  it("hands a resolver's task to a person when it escalates the record", async () => {
    results.push(conflict(["x.ts"]));
    await integrator.submit({ taskId: task("first"), forkSha: "f1" });
    integrator.claim("resolver-1");
    const fix = integrator.startTask({ goal: "resolve #1", agent: "resolver-1", forkRepo: "r", forkUrl: "https://forks/r", resolves: 1 });
    expect(integrator.listTasks().find((t) => t.id === fix)?.state).toBe("active");

    integrator.escalate(1, "resolver-1", "goals contradict");

    expect(integrator.listTasks().find((t) => t.id === fix)?.state).toBe("handed_off");
  });

  it("marks a resolver's task failed when its fix fails and the record reopens", async () => {
    results.push(conflict(["x.ts"]), failed);
    await integrator.submit({ taskId: task("first"), forkSha: "f1" });
    integrator.claim("resolver-1");
    const fix = integrator.startTask({ goal: "resolve #1", agent: "resolver-1", forkRepo: "r", forkUrl: "https://forks/r", resolves: 1 });

    await integrator.submit({ taskId: fix, forkSha: "f2", resolves: 1 });

    expect(integrator.listTasks().find((t) => t.id === fix)?.state).toBe("failed");
  });

  it("explains a file with the goal, agent and record behind each change, newest first", async () => {
    const a = task("rate limit flags", "agent-1");
    const b = task("audit flag writes", "agent-2");
    results.push(merged("t1", ["flags.ts"]), conflict(["flags.ts"]), merged("t2", ["flags.ts", "log.ts"]), merged("t3", ["readme.md"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    await integrator.submit({ taskId: b, forkSha: "f2" });
    integrator.claim("resolver-1");
    const fix = task("resolve #1", "resolver-1");
    await integrator.submit({ taskId: fix, forkSha: "f3", resolves: 1 });
    await integrator.submit({ taskId: task("docs"), forkSha: "f4" });

    expect(integrator.why("flags.ts")).toEqual([
      { trunkSha: "t2", goal: "resolve #1", agent: "resolver-1", record: { id: 1, goal: "audit flag writes", clashingGoal: "rate limit flags" } },
      { trunkSha: "t1", goal: "rate limit flags", agent: "agent-1", record: null },
    ]);
  });

  it("reports a task as submitted while its merge is running", async () => {
    let finish!: (result: MergeResult) => void;
    const db = new DatabaseSync(":memory:");
    const slow = new Integrator(
      (query, ...params) => db.prepare(query).all(...(params as never[])) as never,
      () => new Promise<MergeResult>((resolve) => (finish = resolve)),
      () => clock,
    );
    const id = slow.startTask({ goal: "g", agent: "a", forkRepo: "r", forkUrl: "u" });

    const submitting = slow.submit({ taskId: id, forkSha: "f1" });
    await Promise.resolve();
    expect(slow.listTasks()[0].state).toBe("submitted");

    finish(merged("t1", ["x.ts"]));
    await submitting;
    expect(slow.listTasks()[0].state).toBe("merged");
  });

  it("accepts a submit at once and merges it afterwards", async () => {
    let finish!: (result: MergeResult) => void;
    const db = new DatabaseSync(":memory:");
    const slow = new Integrator(
      (query, ...params) => db.prepare(query).all(...(params as never[])) as never,
      () => new Promise<MergeResult>((resolve) => (finish = resolve)),
      () => clock,
    );
    const id = slow.startTask({ goal: "g", agent: "a", forkRepo: "r", forkUrl: "u" });

    const { reply, done } = slow.accept({ taskId: id, forkSha: "f1" });
    expect(reply).toEqual({ status: "accepted", ahead: 0 });
    await Promise.resolve();
    expect(slow.listTasks()[0].state).toBe("submitted");

    finish(merged("t1", ["x.ts"]));
    expect(await done).toEqual({ status: "merged", trunkSha: "t1" });
    expect(slow.listTasks()[0].state).toBe("merged");
  });

  it("says how many accepted submits are ahead in the queue", () => {
    const db = new DatabaseSync(":memory:");
    const stuck = new Integrator((query, ...params) => db.prepare(query).all(...(params as never[])) as never, () => new Promise<MergeResult>(() => {}), () => clock);
    const ids = ["a", "b", "c"].map((goal) => stuck.startTask({ goal, agent: goal, forkRepo: goal, forkUrl: goal }));

    const replies = ids.map((taskId) => stuck.accept({ taskId, forkSha: "f" }).reply);

    expect(replies.map((r) => r.ahead)).toEqual([0, 1, 2]);
  });

  it("does not count settled submits as ahead in the queue", async () => {
    const first = task("a");
    results.push(merged("t1", ["x.ts"]));
    await integrator.submit({ taskId: first, forkSha: "f1" });
    results.push(merged("t2", ["y.ts"]));

    expect(integrator.accept({ taskId: task("b"), forkSha: "f2" }).reply.ahead).toBe(0);
  });

  it("refuses to accept a submit for an unknown task", () => {
    expect(() => integrator.accept({ taskId: "99", forkSha: "f1" })).toThrow(Rejected);
  });

  it("refuses to accept a task that is already submitted", () => {
    const id = task("g");
    results.push(merged("t1", ["x.ts"]));
    integrator.accept({ taskId: id, forkSha: "f1" });

    expect(() => integrator.accept({ taskId: id, forkSha: "f2" })).toThrow(/already submitted/);
  });

  it("records when each task started", () => {
    clock = 7_000;
    const id = task("rate limit flags");

    expect(integrator.listTasks().find((t) => t.id === id)?.startedAt).toBe(7_000);
  });

  it("names the record a resolver's task is fixing", () => {
    integrator.startTask({ goal: "resolve #3", agent: "resolver-1", forkRepo: "r", forkUrl: "u", resolves: 3 });

    expect(integrator.listTasks()[0]).toMatchObject({ resolves: 3 });
  });

  it("snapshots tasks, records, merges and in-flight agents in one call", async () => {
    const id = task("rate limit flags");
    results.push(merged("t1", ["flags.ts"]));
    await integrator.submit({ taskId: id, forkSha: "f1" });

    expect(integrator.snapshot()).toMatchObject({
      tasks: [{ id, state: "merged" }],
      records: [],
      merges: [{ trunkSha: "t1" }],
      inflight: [],
    });
  });

  it("reports each write through notifyOnWrite, and no reads", () => {
    const db = new DatabaseSync(":memory:");
    let writes = 0;
    const sql = notifyOnWrite((query, ...params) => db.prepare(query).all(...(params as never[])) as never, () => writes++);
    const watched = new Integrator(sql, async () => merged("t1", []), () => clock);
    writes = 0;

    watched.listTasks();
    expect(writes).toBe(0);
    watched.startTask({ goal: "g", agent: "a", forkRepo: "r", forkUrl: "u" });
    expect(writes).toBe(1);
  });

  it("reset clears tasks, records and merge history and restarts ids", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]), merged("t1", ["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });

    integrator.reset();

    expect(integrator.record(1)).toBeNull();
    expect(integrator.why("x.ts")).toEqual([]);
    expect(task("again")).toBe("1");
  });

  it("passes through a submit that is already in trunk without logging a merge", async () => {
    const id = task("no-op");
    results.push({ status: "already_in_trunk", trunkSha: "t0" });

    expect(await integrator.submit({ taskId: id, forkSha: "f1" })).toEqual({ status: "already_in_trunk", trunkSha: "t0" });
    expect(integrator.listTasks()).toMatchObject([{ id, state: "active" }]);
  });

  it("rejects a fix from a resolver that does not hold the claim, without merging", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");
    const intruder = task("resolve #1", "resolver-2");

    await expect(integrator.submit({ taskId: intruder, forkSha: "f2", resolves: 1 })).rejects.toThrow(Rejected);
    expect(calls).toHaveLength(1);
    expect(integrator.record(1)?.state).toBe("claimed");
  });

  it("keeps a record merged when a resolver whose lease expired submits late", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]), merged("t2", ["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");
    clock += LEASE_MS + 1;
    integrator.claim("resolver-2");
    await integrator.submit({ taskId: task("resolve #1", "resolver-2"), forkSha: "f2", resolves: 1 });

    await expect(integrator.submit({ taskId: task("resolve #1", "resolver-1"), forkSha: "f3", resolves: 1 })).rejects.toThrow(Rejected);
    expect(integrator.record(1)?.state).toBe("merged");
  });

  it("only lets the claiming resolver escalate a record", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");

    expect(() => integrator.escalate(1, "resolver-2", "nope")).toThrow(Rejected);
    expect(integrator.record(1)?.state).toBe("claimed");
  });

  it("lists every task with its state so agents can see what others are doing", async () => {
    const a = task("raise limit", "agent-1");
    const b = task("lower limit", "agent-2");
    task("write docs", "agent-3");
    results.push(merged("t1", ["limits.ts"]), conflict(["limits.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    await integrator.submit({ taskId: b, forkSha: "f2" });

    expect(integrator.listTasks()).toEqual([
      { id: "1", goal: "raise limit", agent: "agent-1", state: "merged", record: null, resolves: null, startedAt: 1_000, handedFrom: null, contradiction: null, question: null, verdict: null },
      { id: "2", goal: "lower limit", agent: "agent-2", state: "queued", record: 1, resolves: null, startedAt: 1_000, handedFrom: null, contradiction: null, question: null, verdict: null },
      { id: "3", goal: "write docs", agent: "agent-3", state: "active", record: null, resolves: null, startedAt: 1_000, handedFrom: null, contradiction: null, question: null, verdict: null },
    ]);
  });

  it("lists records filtered by state, without their hunks", async () => {
    const a = task("first");
    const b = task("second");
    results.push(conflict(["x.ts"]), conflict(["y.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    await integrator.submit({ taskId: b, forkSha: "f2" });
    integrator.claim("resolver-1");
    integrator.escalate(1, "resolver-1", "contradiction");

    expect(integrator.listRecords(["escalated"])).toMatchObject([{ id: 1, state: "escalated", reason: "contradiction" }]);
    expect(integrator.listRecords().map((r) => r.id)).toEqual([1, 2]);
    expect(integrator.listRecords()[0]).not.toHaveProperty("detail");
  });

  it("lists trunk history newest first with time, files, diff and the record each merge resolved", async () => {
    const a = task("first", "agent-1");
    results.push(conflict(["x.ts"]), merged("t1", ["y.ts"]), merged("t2", ["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    clock = 2_000;
    await integrator.submit({ taskId: task("docs", "agent-2"), forkSha: "f2" });
    integrator.claim("resolver-1");
    clock = 3_000;
    await integrator.submit({ taskId: task("resolve #1", "resolver-1"), forkSha: "f3", resolves: 1 });

    expect(integrator.listMerges()).toEqual([
      { trunkSha: "t2", taskId: "3", goal: "resolve #1", agent: "resolver-1", record: 1, files: ["x.ts"], at: 3_000 },
      { trunkSha: "t1", taskId: "2", goal: "docs", agent: "agent-2", record: null, files: ["y.ts"], at: 2_000 },
    ]);
    expect(integrator.fixFor(1)).toMatchObject({ trunkSha: "t2", goal: "resolve #1", diff: "diff for t2" });
    expect(integrator.fixFor(2)).toBeNull();
  });

  async function escalatedRecord() {
    const a = task("lower the limit", "agent-1");
    results.push(conflict(["limits.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");
    integrator.escalate(1, "resolver-1", "contradiction");
  }

  it("closes an escalated record without merging when the human keeps trunk", async () => {
    await escalatedRecord();

    expect(await integrator.decide(1, "trunk")).toEqual({ status: "dismissed" });
    expect(integrator.record(1)?.state).toBe("dismissed");
    expect(integrator.listTasks()[0].state).toBe("dismissed");
    expect(calls).toHaveLength(1);
  });

  it("merges the incoming change preferring its side when the human takes it", async () => {
    await escalatedRecord();
    results.push(merged("t9", ["limits.ts"]));

    expect(await integrator.decide(1, "incoming")).toEqual({ status: "merged", trunkSha: "t9" });
    expect(calls[1]).toMatchObject({ forkSha: "f1", prefer: "theirs", trailers: { Task: "1", Resolves: "#1" } });
    expect(integrator.record(1)?.state).toBe("merged");
    expect(integrator.listMerges()[0]).toMatchObject({ record: 1, goal: "lower the limit" });
  });

  it("keeps the record escalated with the reason when taking the incoming side fails its tests", async () => {
    await escalatedRecord();
    results.push(failed);

    expect(await integrator.decide(1, "incoming")).toEqual({ status: "tests_failed" });
    expect(integrator.record(1)).toMatchObject({ state: "escalated", reason: "taking the incoming side failed the tests" });
  });

  it("refuses a decision on a record that is not escalated", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]));
    await integrator.submit({ taskId: a, forkSha: "f1" });

    await expect(integrator.decide(1, "trunk")).rejects.toThrow(Rejected);
  });

  it("remembers which trunk tasks a conflict clashes with", async () => {
    const up = task("rate limit exactly 200", "agent-up");
    const down = task("rate limit exactly 50", "agent-down");
    results.push(merged("t1", ["limits.ts"]), conflict(["limits.ts"], [up]));
    await integrator.submit({ taskId: up, forkSha: "f1" });
    await integrator.submit({ taskId: down, forkSha: "f2" });

    expect(integrator.record(1)?.clashingTasks).toEqual([up]);
  });

  it("drops the goal tests of the tasks it clashes with when the human takes the incoming side", async () => {
    const up = task("rate limit exactly 200", "agent-up");
    const down = task("rate limit exactly 50", "agent-down");
    results.push(merged("t1", ["limits.ts"]), conflict(["limits.ts"], [up]), merged("t2", ["limits.ts"]));
    await integrator.submit({ taskId: up, forkSha: "f1" });
    await integrator.submit({ taskId: down, forkSha: "f2" });
    integrator.claim("resolver-1");
    integrator.escalate(1, "resolver-1", "contradiction");

    await integrator.decide(1, "incoming");

    expect(calls.at(-1)).toMatchObject({ prefer: "theirs", dropPaths: [`test/goals/${up}.test.js`] });
  });

  it("names the failing tests in the reason when a fix fails them", async () => {
    const a = task("first");
    results.push(conflict(["x.ts"]), { status: "tests_failed", trunkSha: "t0", output: "ok 1 - other\nnot ok 2 - rate limit is exactly 200\n" });
    await integrator.submit({ taskId: a, forkSha: "f1" });
    integrator.claim("resolver-1");

    await integrator.submit({ taskId: task("resolve #1", "resolver-1"), forkSha: "f2", resolves: 1 });

    expect(integrator.record(1)?.reason).toBe("tests failed: rate limit is exactly 200");
  });
});
