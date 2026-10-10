import { fetchFork, gitIn, syncTrunk } from "../git/git";
import { findClashingTasks } from "../git/merge";
import type { Shell } from "../git/shell";

/** One changed region of a fork, in the lines of the trunk commit the fork started from. */
export type Change = { file: string; start: number; count: number; symbol: string | null };

// git puts the nearest enclosing declaration after the hunk header, e.g. "@@ -6,1 +6,1 @@ function limit() {".
export function symbolOf(context: string) {
  const match = context.match(/\b(?:function|class|const|let|var|def|fn|func)\s+([\w$]+)/) ?? context.match(/^\s*([\w$]+)\s*\(/);
  return match ? match[1] : null;
}

export function parseChanges(diff: string): Change[] {
  const changes: Change[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/\S+ b\/(\S+)/);
    if (header) file = header[1];
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@ ?(.*)$/);
    if (hunk && file) {
      changes.push({ file, start: Number(hunk[1]), count: hunk[2] === undefined ? 1 : Number(hunk[2]), symbol: symbolOf(hunk[3]) });
    }
  }
  return changes;
}

/**
 * Fetches an agent's latest pushed commit into the integrator's working copy and lists what it
 * changes. A ref per task keeps the commit available for later conflict checks.
 */
export async function inspectFork(req: {
  shell: Shell;
  workdir: string;
  trunkUrl: string;
  forkUrl: string;
  forkSha: string;
  taskId: string;
  trunkToken?: string;
  forkToken?: string;
}): Promise<{ changes: Change[]; committedAt: number }> {
  const repo = gitIn(req.shell, req.workdir, req.trunkToken);
  await syncTrunk(req.shell, repo, req.workdir, req.trunkUrl, req.trunkToken);
  await fetchFork(repo, req.forkUrl, req.forkSha, req.forkToken);
  await repo.must(`update-ref refs/inflight/${Number(req.taskId)} ${req.forkSha}`);
  const base = await repo.must(`merge-base HEAD ${req.forkSha}`);
  const committedAt = Number(await repo.must(`show -s --format=%ct ${req.forkSha}`)) * 1000;
  return { changes: parseChanges(await repo.must(`diff -U0 ${base} ${req.forkSha}`)), committedAt };
}

/** Test-merges one in-flight commit against others, without a checkout, and names the files that would conflict. */
export async function conflictsWith(req: { shell: Shell; workdir: string; sha: string; others: { id: string; sha: string }[] }) {
  const repo = gitIn(req.shell, req.workdir);
  const found: { id: string; files: string[] }[] = [];
  for (const other of req.others) {
    const result = await repo.run(`merge-tree --write-tree --name-only --no-messages ${req.sha} ${other.sha}`);
    if (result.exitCode === 1) found.push({ id: other.id, files: result.stdout.trim().split("\n").slice(1).filter(Boolean) });
    else if (result.exitCode !== 0) throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
  }
  return found;
}

/**
 * Names the trunk tasks an in-flight commit already conflicts with: test-merges it against trunk,
 * then blames the trunk lines that collide with its changes, as the merge step does for a submit.
 */
export async function trunkClashes(req: { shell: Shell; workdir: string; sha: string }) {
  const repo = gitIn(req.shell, req.workdir);
  const result = await repo.run(`merge-tree --write-tree --name-only --no-messages origin/main ${req.sha}`);
  if (result.exitCode === 0) return [];
  if (result.exitCode !== 1) throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
  const files = result.stdout.trim().split("\n").slice(1).filter(Boolean);
  return findClashingTasks(repo.must, req.sha, files, "origin/main");
}
