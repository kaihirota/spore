import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConflictRecord } from "../../src/integrator/integrator";
import { mergeIntoTrunk } from "../../src/git/merge";
import { resolveNext, type ResolverDeps } from "../../src/resolver/resolver";
import { localShell } from "../../src/git/shell-local";
import { FLAGS, makeRepos, type Repos } from "../git/repos";

let repos: Repos;
let record: ConflictRecord;
let calls: { escalated: string[]; released: number[]; submitted: { taskId: string; forkSha: string; resolves: number; alsoResolves?: number[] }[] };
let batch: ConflictRecord[];
let fixFork: string;

function deps(overrides: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    name: "resolver-1",
    shell: localShell,
    workdir: join(repos.root, "resolver"),
    claim: async () => record,
    claimAlso: async () => batch,
    release: async (id) => void calls.released.push(id),
    escalate: async (id, _name, reason) => void calls.escalated.push(`#${id} ${reason}`),
    startFork: async () => {
      fixFork = join(repos.root, "fix.git");
      await repos.sh(`git clone -q --bare ${repos.trunk} ${fixFork}`);
      return { taskId: "9", remote: fixFork, token: undefined };
    },
    forkReadToken: async () => undefined,
    resolveFile: async ({ content }) => ({ content: content.replace(/<<<<<<<[\s\S]*?>>>>>>>[^\n]*\n/, "  return 125;\n") }),
    submit: async (input) => {
      calls.submitted.push({ taskId: input.taskId, forkSha: input.forkSha, resolves: input.resolves!, alsoResolves: input.alsoResolves });
      return { status: "merged", trunkSha: "t" };
    },
    ...overrides,
  };
}

beforeEach(async () => {
  repos = await makeRepos();
  calls = { escalated: [], released: [], submitted: [] };
  batch = [];
  const incoming = await repos.forkWithEdit("incoming", "flags.js", FLAGS.replace("return 100", "return 50"), "lower limit");
  const trunkSide = await repos.forkWithEdit("trunk-side", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");
  await mergeIntoTrunk({
    shell: localShell, workdir: join(repos.root, "integrator"), trunkUrl: repos.trunk, forkUrl: trunkSide.fork, forkSha: trunkSide.sha,
    testCommand: "true", message: "raise limit", trailers: { Task: "1" },
  });
  record = {
    id: 3, kind: "merge", state: "claimed", goal: "lower the limit", clashingGoal: "raise the limit", clashingTasks: ["1"],
    forkRepo: "incoming", forkUrl: incoming.fork, forkSha: incoming.sha, files: ["flags.js"], detail: "", attempts: 0, reason: null,
  };
});

describe("resolveNext", () => {
  it("merges the incoming change onto a fresh fork, writes the model's file, pushes and submits it", async () => {
    expect(await resolveNext(deps())).toBe("submitted");

    const [submitted] = calls.submitted;
    expect(submitted).toMatchObject({ taskId: "9", resolves: 3 });
    expect(await repos.sh(`git --git-dir=${fixFork} show ${submitted.forkSha}:flags.js`)).toContain("return 125;");
    expect(await repos.sh(`git --git-dir=${fixFork} rev-list --parents -n 1 ${submitted.forkSha}`)).toContain(record.forkSha);
  });

  it("escalates with the model's reason instead of submitting", async () => {
    expect(await resolveNext(deps({ resolveFile: async () => ({ escalate: "limits contradict" }) }))).toBe("escalated");

    expect(calls.escalated).toEqual(["#3 limits contradict"]);
    expect(calls.submitted).toEqual([]);
  });

  it("escalates a test-failure record without calling the model", async () => {
    record = { ...record, kind: "tests" };

    expect(await resolveNext(deps({ resolveFile: async () => { throw new Error("model called"); } }))).toBe("escalated");
    expect(calls.escalated).toEqual(["#3 the resolver only handles merge conflicts"]);
  });

  it("settles a batch of records on the same file with one fix", async () => {
    const other = await repos.forkWithEdit("other", "flags.js", FLAGS.replace("return 100", "return 75"), "limit 75");
    batch = [{ ...record, id: 4, goal: "set the limit to 75", forkRepo: "other", forkUrl: other.fork, forkSha: other.sha }];

    expect(await resolveNext(deps())).toBe("submitted");

    const [submitted] = calls.submitted;
    expect(submitted).toMatchObject({ resolves: 3, alsoResolves: [4] });
    const parents = await repos.sh(`git --git-dir=${fixFork} rev-list ${submitted.forkSha}`);
    expect([record.forkSha, other.sha].every((sha) => parents.includes(sha))).toBe(true);
  });

  it("escalates only the batched record the model cannot settle and fixes the rest", async () => {
    const other = await repos.forkWithEdit("other", "flags.js", FLAGS.replace("return 100", "return 75"), "limit 75");
    batch = [{ ...record, id: 4, goal: "set the limit to 75", forkRepo: "other", forkUrl: other.fork, forkSha: other.sha }];
    const model: ResolverDeps["resolveFile"] = async ({ content, incomingGoal }) =>
      incomingGoal === "set the limit to 75" ? { escalate: "75 contradicts" } : { content: content.replace(/<<<<<<<[\s\S]*?>>>>>>>[^\n]*\n/, "  return 125;\n") };

    expect(await resolveNext(deps({ resolveFile: model }))).toBe("submitted");

    expect(calls.escalated).toEqual(["#4 75 contradicts"]);
    expect(calls.submitted[0]).toMatchObject({ resolves: 3, alsoResolves: [] });
  });

  it("gives the rest of the batch back when the first record escalates", async () => {
    batch = [{ ...record, id: 4 }];

    expect(await resolveNext(deps({ resolveFile: async () => ({ escalate: "limits contradict" }) }))).toBe("escalated");

    expect(calls.released).toEqual([4]);
  });

  it("reports an empty queue", async () => {
    expect(await resolveNext(deps({ claim: async () => null }))).toBe("empty");
  });
});
