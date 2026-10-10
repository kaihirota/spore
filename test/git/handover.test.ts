import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { dropChange, flattenOntoTrunk } from "../../src/git/handover";
import { localShell } from "../../src/git/shell-local";
import { FLAGS, makeRepos, type Repos } from "./repos";

let repos: Repos;
const workdir = () => join(repos.root, "handover");
const TESTS = "node test.js";

// A fork whose one commit changes limit() and audit(), plus a goal test for its task.
async function forkChangingBoth(goalTest = 'process.exit(require("../../flags.js").limit() === 200 ? 0 : 1);\n') {
  const name = "worker";
  const fork = join(repos.root, `${name}.git`);
  await repos.sh(`git clone -q --bare ${repos.trunk} ${fork}`);
  const work = join(repos.root, name);
  await repos.sh(`git clone -q ${fork} ${work}`);
  writeFileSync(join(work, "flags.js"), FLAGS.replace("return 100", "return 200").replace('return "none"', 'return "all"'));
  await repos.sh(`mkdir -p ${join(work, "test/goals")}`);
  writeFileSync(join(work, "test/goals/7.test.js"), goalTest);
  await repos.git("add -A", work);
  await repos.git('commit -qm "work in progress"', work);
  await repos.git("push -q origin main", work);
  return { fork, sha: await repos.sh("git rev-parse HEAD", work) };
}

const show = (fork: string, path: string) => repos.sh(`git --git-dir=${fork} show main:${path}`);

beforeEach(async () => {
  repos = await makeRepos();
});

describe("dropChange", () => {
  it("removes the task's change to one function, keeps the rest, and pushes it to the fork", async () => {
    const { fork, sha } = await forkChangingBoth();

    const result = await dropChange({ shell: localShell, workdir: workdir(), trunkUrl: repos.trunk, forkUrl: fork, forkSha: sha, symbols: ["audit"], files: ["flags.js"], goalTest: "test/goals/7.test.js", testCommand: TESTS });

    expect(result.status).toBe("done");
    const flags = await show(fork, "flags.js");
    expect(flags).toContain('return "none"');
    expect(flags).toContain("return 200");
  });

  it("refuses when the tests fail without the change", async () => {
    const { fork, sha } = await forkChangingBoth();

    const result = await dropChange({ shell: localShell, workdir: workdir(), trunkUrl: repos.trunk, forkUrl: fork, forkSha: sha, symbols: ["audit"], files: ["flags.js"], goalTest: "test/goals/7.test.js", testCommand: 'grep -q "return \\"all\\"" flags.js' });

    expect(result).toMatchObject({ status: "refused" });
    expect(await show(fork, "flags.js")).toContain('return "all"');
  });
});

describe("flattenOntoTrunk", () => {
  it("squashes the task's work onto trunk as one commit and pushes it to the fork", async () => {
    const { fork, sha } = await forkChangingBoth();
    await repos.forkWithEdit("other", "test.js", readFileSync(join(repos.root, "seed", "test.js"), "utf8") + "// trunk moved\n", "trunk moved");
    await repos.sh(`git --git-dir=${join(repos.root, "other.git")} push -q ${repos.trunk} main`);

    const result = await flattenOntoTrunk({ shell: localShell, workdir: workdir(), trunkUrl: repos.trunk, forkUrl: fork, forkSha: sha, goalTest: "test/goals/7.test.js", testCommand: TESTS, message: "Task 7: raise the limit", trailers: { Task: "7" } });

    expect(result.status).toBe("done");
    expect(await repos.sh(`git --git-dir=${fork} rev-parse main^`)).toBe(await repos.trunkHead());
    expect(await repos.sh(`git --git-dir=${fork} log -1 --format=%B main`)).toContain("Task: 7");
    expect(await show(fork, "test.js")).toContain("// trunk moved");
  });

  it("runs the tests without the task's own unfinished goal test", async () => {
    const { fork, sha } = await forkChangingBoth("process.exit(1);\n");

    const result = await flattenOntoTrunk({ shell: localShell, workdir: workdir(), trunkUrl: repos.trunk, forkUrl: fork, forkSha: sha, goalTest: "test/goals/7.test.js", testCommand: "test ! -e test/goals/7.test.js && node test.js", message: "Task 7", trailers: { Task: "7" } });

    expect(result.status).toBe("done");
    expect(await show(fork, "test/goals/7.test.js")).toBe("process.exit(1);");
  });

  it("refuses when the work breaks trunk's tests", async () => {
    const { fork, sha } = await forkChangingBoth();

    const result = await flattenOntoTrunk({ shell: localShell, workdir: workdir(), trunkUrl: repos.trunk, forkUrl: fork, forkSha: sha, goalTest: "test/goals/7.test.js", testCommand: "exit 1", message: "Task 7", trailers: { Task: "7" } });

    expect(result).toMatchObject({ status: "refused" });
    expect(await repos.sh(`git --git-dir=${fork} rev-parse main`)).toBe(sha);
  });
});
