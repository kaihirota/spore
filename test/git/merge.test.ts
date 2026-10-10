import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { mergeIntoTrunk } from "../../src/git/merge";
import { localShell } from "../../src/git/shell-local";
import { makeRepos, type Repos } from "./repos";

let repos: Repos;
let root: string;
let trunk: string;
const sh = (cmd: string, cwd?: string) => repos.sh(cmd, cwd);
const git = (args: string, cwd: string) => repos.git(args, cwd);
const forkWithEdit = (name: string, file: string, content: string, message: string) => repos.forkWithEdit(name, file, content, message);
const trunkHead = () => repos.trunkHead();
const trunkFile = (path: string) => repos.trunkFile(path);

function merge(fork: string, sha: string, trailers: Record<string, string> = { Task: "t1" }, extra: Partial<Parameters<typeof mergeIntoTrunk>[0]> = {}) {
  return mergeIntoTrunk({
    shell: localShell,
    workdir: join(root, "integrator"),
    trunkUrl: trunk,
    forkUrl: fork,
    forkSha: sha,
    testCommand: "node test.js",
    message: "Merge task",
    trailers,
    ...extra,
  });
}

beforeEach(async () => {
  repos = await makeRepos();
  ({ root, trunk } = repos);
});

describe("mergeIntoTrunk", () => {
  it("merges a clean change and advances trunk", async () => {
    const before = await trunkHead();
    const original = await trunkFile("flags.js");
    const { fork, sha } = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");

    const result = await merge(fork, sha);

    expect(result).toMatchObject({ status: "merged", trunkSha: await trunkHead(), files: ["flags.js"] });
    if (result.status === "merged") expect(result.diff).toContain("+  return 200;");
    expect(await trunkHead()).not.toBe(before);
    expect(await trunkFile("flags.js")).toContain("return 200");
  });

  it("merges two edits to different functions in one file", async () => {
    const original = await trunkFile("flags.js");
    const a = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");
    const b = await forkWithEdit("b", "flags.js", original.replace('return "none"', 'return "all"'), "audit all");

    expect((await merge(a.fork, a.sha)).status).toBe("merged");
    expect((await merge(b.fork, b.sha)).status).toBe("merged");

    const merged = await trunkFile("flags.js");
    expect(merged).toContain("return 200");
    expect(merged).toContain('return "all"');
  });

  it("returns conflict hunks and leaves trunk unchanged when the same line changes", async () => {
    const original = await trunkFile("flags.js");
    const a = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");
    const b = await forkWithEdit("b", "flags.js", original.replace("return 100", "return 50"), "lower limit");
    await merge(a.fork, a.sha);
    const before = await trunkHead();

    const result = await merge(b.fork, b.sha);

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.trunkSha).toBe(before);
    expect(result.files).toEqual(["flags.js"]);
    expect(result.hunks).toContain("<<<<<<<");
    expect(await trunkHead()).toBe(before);
  });

  it("names only the trunk task whose lines the incoming change collides with", async () => {
    const original = await trunkFile("flags.js");
    const a = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");
    const b = await forkWithEdit("b", "flags.js", original.replace('return "none"', 'return "all"'), "audit all");
    const c = await forkWithEdit("c", "flags.js", original.replace("return 100", "return 50"), "lower limit");
    await merge(a.fork, a.sha, { Task: "task-a" });
    await merge(b.fork, b.sha, { Task: "task-b" });

    const result = await merge(c.fork, c.sha, { Task: "task-c" });

    expect(result).toMatchObject({ status: "conflict", clashingTasks: ["task-a"] });
  });

  it("returns test output and leaves trunk unchanged when tests fail", async () => {
    const before = await trunkHead();
    const original = await trunkFile("flags.js");
    const { fork, sha } = await forkWithEdit("a", "flags.js", original.replace("return 100", "return -1"), "break limit");

    const result = await merge(fork, sha);

    expect(result.status).toBe("tests_failed");
    if (result.status !== "tests_failed") return;
    expect(result.output).toContain("limit must not be negative");
    expect(await trunkHead()).toBe(before);
  });

  it("writes Task and Resolves trailers on the merge commit", async () => {
    const original = await trunkFile("flags.js");
    const { fork, sha } = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");

    await merge(fork, sha, { Task: "t7", Resolves: "#3" });

    const body = await sh(`git --git-dir=${trunk} log -1 --format=%B main`);
    expect(body).toContain("Task: t7");
    expect(body).toContain("Resolves: #3");
  });

  it("reports a fork with no new commits as already in trunk without touching trunk", async () => {
    const before = await trunkHead();
    const fork = join(root, "empty.git");
    await sh(`git clone -q --bare ${trunk} ${fork}`);

    const result = await merge(fork, before);

    expect(result).toEqual({ status: "already_in_trunk", trunkSha: before });
    expect(await trunkHead()).toBe(before);
  });

  it("kills a test run that exceeds its timeout and leaves trunk unchanged", async () => {
    const before = await trunkHead();
    const original = await trunkFile("flags.js");
    const { fork, sha } = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");

    const result = await merge(fork, sha, { Task: "t1" }, { testCommand: "sleep 5", testTimeoutMs: 300 });

    expect(result.status).toBe("tests_failed");
    if (result.status !== "tests_failed") return;
    expect(result.output).toContain("timed out");
    expect(await trunkHead()).toBe(before);
  });

  it("queues unrelated history as a conflict instead of failing", async () => {
    const before = await trunkHead();
    const fork = join(root, "stranger.git");
    const work = join(root, "stranger");
    await sh(`git init -q -b main ${work}`);
    writeFileSync(join(work, "other.txt"), "unrelated\n");
    await git("add .", work);
    await git('commit -qm "unrelated"', work);
    await sh(`git clone -q --bare ${work} ${fork}`);

    const result = await merge(fork, await sh("git rev-parse HEAD", work));

    expect(result).toMatchObject({ status: "conflict", files: [], clashingTasks: [] });
    if (result.status === "conflict") expect(result.hunks).toContain("unrelated histories");
    expect(await trunkHead()).toBe(before);
  });

  it("does not run git hooks planted in the integrator's working copy", async () => {
    const original = await trunkFile("flags.js");
    const a = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");
    await merge(a.fork, a.sha);
    const marker = join(root, "hook-ran");
    const hook = join(root, "integrator", ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    const b = await forkWithEdit("b", "flags.js", original.replace('return "none"', 'return "all"'), "audit all");

    expect((await merge(b.fork, b.sha)).status).toBe("merged");
    expect(existsSync(marker)).toBe(false);
  });

  it("takes the incoming side of a conflict when asked to prefer it", async () => {
    const original = await trunkFile("flags.js");
    const a = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");
    const b = await forkWithEdit("b", "flags.js", original.replace("return 100", "return 50"), "lower limit");
    await merge(a.fork, a.sha);

    const result = await merge(b.fork, b.sha, { Task: "t2" }, { prefer: "theirs" });

    expect(result.status).toBe("merged");
    expect(await trunkFile("flags.js")).toContain("return 50");
  });

  it("drops the given paths from the merge before running the tests", async () => {
    const original = await trunkFile("flags.js");
    const a = await forkWithEdit("a", "flags.js", original.replace("return 100", "return 200"), "raise limit");
    await merge(a.fork, a.sha);
    const b = await forkWithEdit("b", "flags.js", original.replace('return "none"', 'return "all"'), "audit all");

    const result = await merge(b.fork, b.sha, { Task: "t2" }, { dropPaths: ["test.js", "not-there.js"], testCommand: "test ! -e test.js" });

    expect(result.status).toBe("merged");
    await expect(trunkFile("test.js")).rejects.toThrow();
  });
});
