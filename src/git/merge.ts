import { fetchFork, gitIn, syncTrunk } from "./git";
import { quote, type Shell } from "./shell";

export type MergeResult =
  | { status: "merged"; trunkSha: string; files: string[]; diff: string }
  | { status: "conflict"; trunkSha: string; files: string[]; hunks: string; clashingTasks: string[] }
  | { status: "tests_failed"; trunkSha: string; output: string }
  | { status: "already_in_trunk"; trunkSha: string };

export type MergeRequest = {
  shell: Shell;
  workdir: string;
  trunkUrl: string;
  forkUrl: string;
  forkSha: string;
  testCommand: string;
  message: string;
  trailers: Record<string, string>;
  testTimeoutMs?: number;
  prefer?: "theirs";
  /** Paths removed from the merged tree before the tests run, e.g. the test of a goal a human ruled against. */
  dropPaths?: string[];
  trunkToken?: string;
  forkToken?: string;
};

const OUTPUT_LIMIT = 8000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number };

function parseHunks(diff: string): Hunk[] {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  }));
}

// Base-version line ranges that overlap or sit next to each other, which is when git refuses to merge them.
function collide(a: Hunk, b: Hunk) {
  const end = (h: Hunk) => h.oldStart + Math.max(h.oldCount, 1) - 1;
  return a.oldStart <= end(b) + 1 && b.oldStart <= end(a) + 1;
}

/**
 * Merges one fork commit into trunk: clean merges that pass the tests are pushed,
 * anything else is reported and trunk is left untouched.
 * Assumes the caller runs one merge at a time per workdir and is trunk's only writer.
 */
export async function mergeIntoTrunk(req: MergeRequest): Promise<MergeResult> {
  const { shell, workdir } = req;
  const repo = gitIn(shell, workdir, req.trunkToken);
  const { run: git, must } = repo;

  const trunkSha = await syncTrunk(shell, repo, workdir, req.trunkUrl, req.trunkToken);
  await fetchFork(repo, req.forkUrl, req.forkSha, req.forkToken);
  if ((await git(`merge-base --is-ancestor ${req.forkSha} HEAD`)).exitCode === 0) return { status: "already_in_trunk", trunkSha };

  const strategy = req.prefer === "theirs" ? "-X theirs " : "";
  const merge = await git(`merge -q --no-ff --no-commit ${strategy}${req.forkSha}`);
  if (merge.exitCode !== 0) {
    const merging = (await git("rev-parse -q --verify MERGE_HEAD")).exitCode === 0;
    const files = merging ? (await must("diff --name-only --diff-filter=U")).split("\n").filter(Boolean) : [];
    const hunks = (merging ? (await git("diff")).stdout : merge.stderr).slice(0, OUTPUT_LIMIT);
    const clashingTasks = files.length > 0 ? await findClashingTasks(must, req.forkSha, files) : [];
    await must(`reset -q --hard ${trunkSha}`);
    return { status: "conflict", trunkSha, files, hunks, clashingTasks };
  }

  if (req.dropPaths?.length) await must(`rm -q -r --ignore-unmatch -- ${req.dropPaths.map(quote).join(" ")}`);

  const trailers = Object.entries(req.trailers).map(([key, value]) => `${key}: ${value}`).join("\n");
  const commit = await git(`commit -q -m ${quote(req.message)} -m ${quote(trailers)}`);
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);

  const tests = await shell(req.testCommand, { cwd: workdir, timeoutMs: req.testTimeoutMs ?? TEST_TIMEOUT_MS });
  if (tests.exitCode !== 0) {
    await must(`reset -q --hard ${trunkSha}`);
    return { status: "tests_failed", trunkSha, output: (tests.stdout + tests.stderr).slice(-OUTPUT_LIMIT) };
  }

  // Everything that can fail runs before the push, so a pushed merge always reaches the caller.
  const files = (await must(`diff --name-only ${trunkSha} HEAD`)).split("\n").filter(Boolean);
  const diff = (await must(`diff ${trunkSha} HEAD`)).slice(0, OUTPUT_LIMIT);
  const mergedSha = await must("rev-parse HEAD");
  await must("push -q origin HEAD:main");
  return { status: "merged", trunkSha: mergedSha, files, diff };
}

/**
 * Names the trunk tasks whose lines the incoming change collides with: the trunk hunks that
 * overlap the fork's hunks are blamed along trunk's first parents, which lands on the
 * integrator's merge commits and their Task trailers.
 */
export async function findClashingTasks(must: (args: string) => Promise<string>, forkSha: string, files: string[], head = "HEAD") {
  const base = await must(`merge-base ${head} ${quote(forkSha)}`);
  const tasks = new Set<string>();
  for (const file of files) {
    const trunkHunks = parseHunks(await must(`diff -U0 ${base} ${head} -- ${quote(file)}`));
    const forkHunks = parseHunks(await must(`diff -U0 ${base} ${quote(forkSha)} -- ${quote(file)}`));
    for (const hunk of trunkHunks) {
      if (hunk.newCount === 0 || !forkHunks.some((other) => collide(hunk, other))) continue;
      const blame = await must(`blame --first-parent --porcelain -L ${hunk.newStart},+${hunk.newCount} ${head} -- ${quote(file)}`);
      const commits = new Set(blame.split("\n").filter((line) => /^[0-9a-f]{40} \d+ \d+/.test(line)).map((line) => line.slice(0, 40)));
      for (const commit of commits) {
        const task = await must(`log -1 --format=${quote("%(trailers:key=Task,valueonly)")} ${commit}`);
        if (task) tasks.add(task);
      }
    }
  }
  return [...tasks];
}
