import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { conflictsWith, inspectFork, parseChanges, trunkClashes } from "../../src/integrator/inflight";
import { mergeIntoTrunk } from "../../src/git/merge";
import { localShell } from "../../src/git/shell-local";
import { FLAGS, makeRepos, type Repos } from "../git/repos";

let repos: Repos;
const workdir = () => join(repos.root, "integrator");

const inspect = (fork: string, sha: string, taskId: string) =>
  inspectFork({ shell: localShell, workdir: workdir(), trunkUrl: repos.trunk, forkUrl: fork, forkSha: sha, taskId });

beforeEach(async () => {
  repos = await makeRepos();
});

describe("inspectFork", () => {
  it("reports each changed file with its lines and the function the change sits in", async () => {
    const { fork, sha } = await repos.forkWithEdit("a", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");

    expect((await inspect(fork, sha, "1")).changes).toEqual([{ file: "flags.js", start: 6, count: 1, symbol: "limit" }]);
  });

  it("reports when the pushed commit was made", async () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const { fork, sha } = await repos.forkWithEdit("a", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");

    const { committedAt } = await inspect(fork, sha, "1");

    expect(committedAt).toBeGreaterThanOrEqual(before);
    expect(committedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("parseChanges", () => {
  it("names exported functions and handles several files and insertions", () => {
    const diff = [
      "diff --git a/src/flags.js b/src/flags.js",
      "@@ -8,0 +9,1 @@ export function setFlag(name, value) {",
      "+  audit.push({ name, value });",
      "diff --git a/README.md b/README.md",
      "@@ -3 +3,2 @@ A small feature flag service.",
    ].join("\n");

    expect(parseChanges(diff)).toEqual([
      { file: "src/flags.js", start: 8, count: 0, symbol: "setFlag" },
      { file: "README.md", start: 3, count: 1, symbol: null },
    ]);
  });
});

describe("conflictsWith", () => {
  it("flags another in-flight fork that changes the same lines", async () => {
    const a = await repos.forkWithEdit("a", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");
    const b = await repos.forkWithEdit("b", "flags.js", FLAGS.replace("return 100", "return 50"), "lower limit");
    await inspect(a.fork, a.sha, "1");
    await inspect(b.fork, b.sha, "2");

    const result = await conflictsWith({ shell: localShell, workdir: workdir(), sha: b.sha, others: [{ id: "1", sha: a.sha }] });

    expect(result).toEqual([{ id: "1", files: ["flags.js"] }]);
  });

  it("does not flag a fork that changes a different function in the same file", async () => {
    const a = await repos.forkWithEdit("a", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");
    const b = await repos.forkWithEdit("b", "flags.js", FLAGS.replace('return "none"', 'return "all"'), "audit all");
    await inspect(a.fork, a.sha, "1");
    await inspect(b.fork, b.sha, "2");

    expect(await conflictsWith({ shell: localShell, workdir: workdir(), sha: b.sha, others: [{ id: "1", sha: a.sha }] })).toEqual([]);
  });
});

describe("trunkClashes", () => {
  const mergeTask = (fork: string, sha: string, taskId: string) =>
    mergeIntoTrunk({
      shell: localShell, workdir: workdir(), trunkUrl: repos.trunk, forkUrl: fork, forkSha: sha,
      testCommand: "true", message: `task ${taskId}`, trailers: { Task: taskId },
    });

  it("names the trunk tasks an in-flight fork already conflicts with", async () => {
    const a = await repos.forkWithEdit("a", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");
    const b = await repos.forkWithEdit("b", "flags.js", FLAGS.replace("return 100", "return 50"), "lower limit");
    await inspect(b.fork, b.sha, "2");
    await mergeTask(a.fork, a.sha, "1");

    expect(await trunkClashes({ shell: localShell, workdir: workdir(), sha: b.sha })).toEqual(["1"]);
  });

  it("names only the trunk task whose lines collide, not every task that touched the file", async () => {
    const a = await repos.forkWithEdit("a", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");
    const b = await repos.forkWithEdit("b", "flags.js", FLAGS.replace('return "none"', 'return "all"'), "audit all");
    const c = await repos.forkWithEdit("c", "flags.js", FLAGS.replace("return 100", "return 50"), "lower limit");
    await inspect(c.fork, c.sha, "3");
    await mergeTask(a.fork, a.sha, "1");
    await mergeTask(b.fork, b.sha, "2");

    expect(await trunkClashes({ shell: localShell, workdir: workdir(), sha: c.sha })).toEqual(["1"]);
  });

  it("finds nothing when trunk changed a different function", async () => {
    const a = await repos.forkWithEdit("a", "flags.js", FLAGS.replace("return 100", "return 200"), "raise limit");
    const b = await repos.forkWithEdit("b", "flags.js", FLAGS.replace('return "none"', 'return "all"'), "audit all");
    await inspect(b.fork, b.sha, "2");
    await mergeTask(a.fork, a.sha, "1");

    expect(await trunkClashes({ shell: localShell, workdir: workdir(), sha: b.sha })).toEqual([]);
  });
});
