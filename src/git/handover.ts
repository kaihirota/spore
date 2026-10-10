/**
 * Container work behind the coordinator's verdicts. Both operations work on a task's fork, run the
 * tests without the task's own goal test (which is unfinished by definition), and push only if they pass.
 */
import { symbolOf } from "../integrator/inflight";
import { fetchFork, gitIn, syncTrunk } from "./git";
import { quote, type Shell } from "./shell";

const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_LIMIT = 4000;

type Common = {
  shell: Shell;
  workdir: string;
  trunkUrl: string;
  forkUrl: string;
  forkSha: string;
  goalTest: string;
  testCommand: string;
  trunkToken?: string;
  forkToken?: string;
  testTimeoutMs?: number;
};
export type HandoverResult = { status: "done"; sha: string } | { status: "refused"; reason: string };

// Runs the tests with the task's own goal test set aside, then puts it back.
async function testsWithoutGoal(req: Common, must: (args: string) => Promise<string>) {
  const hadGoal = (await req.shell(`test -e ${quote(req.goalTest)}`, { cwd: req.workdir })).exitCode === 0;
  if (hadGoal) await req.shell(`rm -f ${quote(req.goalTest)}`, { cwd: req.workdir });
  const tests = await req.shell(req.testCommand, { cwd: req.workdir, timeoutMs: req.testTimeoutMs ?? TEST_TIMEOUT_MS });
  if (hadGoal) await must(`checkout -q -- ${quote(req.goalTest)}`);
  return tests.exitCode === 0 ? null : `tests failed: ${(tests.stdout + tests.stderr).trim().slice(-OUTPUT_LIMIT)}`;
}

// The hunks of a zero-context diff whose enclosing function is one of `symbols`, as a patch.
function hunksIn(diff: string, symbols: string[]) {
  const out: string[] = [];
  let header: string[] = [];
  let keep = false;
  let headerWritten = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      header = [line];
      headerWritten = false;
      keep = false;
    } else if (/^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode)/.test(line) && !line.startsWith("@@")) {
      header.push(line);
    } else if (line.startsWith("@@")) {
      const context = line.match(/^@@ [^@]* @@ ?(.*)$/)?.[1] ?? "";
      keep = symbols.length === 0 || symbols.includes(symbolOf(context) ?? "");
      if (keep && !headerWritten) {
        out.push(...header);
        headerWritten = true;
      }
      if (keep) out.push(line);
    } else if (keep && line !== "") {
      out.push(line);
    }
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/** Removes the task's changes in the given functions (all of the given files when none are named) from its branch. */
export async function dropChange(req: Common & { files: string[]; symbols: string[] }): Promise<HandoverResult> {
  const repo = gitIn(req.shell, req.workdir, req.trunkToken);
  const trunkSha = await syncTrunk(req.shell, repo, req.workdir, req.trunkUrl, req.trunkToken);
  await fetchFork(repo, req.forkUrl, req.forkSha, req.forkToken);
  await repo.must(`checkout -q -B handover ${req.forkSha}`);
  const base = await repo.must(`merge-base ${trunkSha} ${req.forkSha}`);
  const diff = (await repo.run(`diff -U0 ${base} ${req.forkSha} -- ${req.files.map(quote).join(" ")}`)).stdout;
  const patch = hunksIn(diff, req.symbols);
  if (!patch) return { status: "refused", reason: "the branch has no change there to drop" };
  await req.shell(`printf %s ${quote(patch)} > .git/drop.patch`, { cwd: req.workdir });
  const applied = await repo.run("apply -R --unidiff-zero .git/drop.patch");
  if (applied.exitCode !== 0) return { status: "refused", reason: `could not remove the change: ${applied.stderr.trim()}` };
  await repo.must(`commit -qam ${quote(`Drop change to ${req.symbols.join(", ") || req.files.join(", ")}`)}`);
  const failed = await testsWithoutGoal(req, repo.must);
  if (failed) return { status: "refused", reason: failed };
  await repo.must(`push -q --force ${quote(req.forkUrl)} HEAD:main`, req.forkToken);
  return { status: "done", sha: await repo.must("rev-parse HEAD") };
}

/** Squashes the task's work onto current trunk as one commit and makes it the fork's main, ready to hand over. */
export async function flattenOntoTrunk(req: Common & { message: string; trailers: Record<string, string> }): Promise<HandoverResult> {
  const repo = gitIn(req.shell, req.workdir, req.trunkToken);
  const trunkSha = await syncTrunk(req.shell, repo, req.workdir, req.trunkUrl, req.trunkToken);
  await fetchFork(repo, req.forkUrl, req.forkSha, req.forkToken);
  const merge = await repo.run(`merge -q --squash ${req.forkSha}`);
  if (merge.exitCode !== 0) {
    await repo.must(`reset -q --hard ${trunkSha}`);
    return { status: "refused", reason: "the work no longer applies cleanly to trunk" };
  }
  if ((await repo.run("diff --cached --quiet")).exitCode === 0) return { status: "refused", reason: "the task has nothing beyond trunk" };
  const failed = await testsWithoutGoal(req, repo.must);
  if (failed) {
    await repo.must(`reset -q --hard ${trunkSha}`);
    return { status: "refused", reason: failed };
  }
  const trailers = Object.entries(req.trailers).map(([key, value]) => `${key}: ${value}`).join("\n");
  await repo.must(`commit -q -m ${quote(req.message)} -m ${quote(trailers)}`);
  await repo.must(`push -q --force ${quote(req.forkUrl)} HEAD:main`, req.forkToken);
  return { status: "done", sha: await repo.must("rev-parse HEAD") };
}
