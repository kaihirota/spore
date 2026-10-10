import { fetchFork, gitIn, syncTrunk } from "../git/git";
import type { ConflictRecord, SubmitResult } from "../integrator/integrator";
import type { Resolution } from "./resolve";
import { quote, type Shell } from "../git/shell";

// UTF-8 safe, and available in both Workers and Node.
function base64(text: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type ResolverDeps = {
  name: string;
  shell: Shell;
  workdir: string;
  claim: (resolver: string) => Promise<ConflictRecord | null>;
  /** Claims the other untried records on the claimed record's files, to settle in the same fix. */
  claimAlso: (resolver: string, recordId: number) => Promise<ConflictRecord[]>;
  release: (recordId: number, resolver: string) => Promise<void>;
  escalate: (recordId: number, resolver: string, reason: string) => Promise<void>;
  /** Forks current trunk for the fix and starts its task. */
  startFork: (goal: string, resolves: number) => Promise<{ taskId: string; remote: string; token?: string }>;
  forkReadToken: (forkRepo: string) => Promise<string | undefined>;
  resolveFile: (input: { path: string; content: string; trunkGoal: string; incomingGoal: string }) => Promise<Resolution>;
  submit: (input: { taskId: string; forkSha: string; resolves: number; alsoResolves: number[] }) => Promise<SubmitResult>;
};

/**
 * Claims the oldest open record, plus any untried records on the same files, and settles them in one fix:
 * merges each incoming change in turn onto a fresh fork of trunk, asking the model to rewrite each
 * conflicted file so every goal so far holds, then pushes and submits the fix through the same merge and
 * tests as any change. A record the model cannot settle is escalated on its own; if it is the first,
 * the rest go back to the queue.
 */
export async function resolveNext(d: ResolverDeps): Promise<"empty" | "escalated" | "submitted"> {
  const record = await d.claim(d.name);
  if (!record) return "empty";
  if (record.kind !== "merge") {
    await d.escalate(record.id, d.name, "the resolver only handles merge conflicts");
    return "escalated";
  }
  const batch = [record, ...(await d.claimAlso(d.name, record.id))];

  const fork = await d.startFork(`resolve ${batch.map((r) => `#${r.id}`).join(", ")}: ${batch.map((r) => r.goal).join("; ")}`, record.id);
  await d.shell(`rm -rf ${quote(d.workdir)}`);
  const repo = gitIn(d.shell, d.workdir, fork.token);
  await syncTrunk(d.shell, repo, d.workdir, fork.remote, fork.token);

  const settled: ConflictRecord[] = [];
  for (const incoming of batch) {
    await fetchFork(repo, incoming.forkUrl, incoming.forkSha, await d.forkReadToken(incoming.forkRepo));
    const trunkGoal = [incoming.clashingGoal ?? "the version currently in trunk", ...settled.map((r) => r.goal)].join("; ");
    const problem = await mergeOne(d, repo, incoming, trunkGoal);
    if (!problem) {
      settled.push(incoming);
      continue;
    }
    await d.escalate(incoming.id, d.name, problem);
    if (settled.length === 0) {
      for (const rest of batch.slice(1)) await d.release(rest.id, d.name);
      return "escalated";
    }
  }
  await repo.must("push -q origin HEAD:main");
  await d.submit({ taskId: fork.taskId, forkSha: await repo.must("rev-parse HEAD"), resolves: record.id, alsoResolves: settled.slice(1).map((r) => r.id) });
  return "submitted";
}

/** Merges one incoming change into the working copy; returns why it could not, leaving the copy as it was. */
async function mergeOne(d: ResolverDeps, repo: ReturnType<typeof gitIn>, incoming: ConflictRecord, trunkGoal: string): Promise<string | null> {
  const merge = await repo.run(`-c merge.conflictStyle=diff3 merge -q --no-edit ${incoming.forkSha}`);
  if (merge.exitCode === 0) return null;
  const files = (await repo.must("diff --name-only --diff-filter=U")).split("\n").filter(Boolean);
  const giveUp = async (reason: string) => {
    await repo.run("merge --abort");
    return reason;
  };
  if (files.length === 0) return giveUp(`merge failed: ${merge.stderr.trim()}`);
  for (const path of files) {
    const content = (await d.shell(`cat ${quote(path)}`, { cwd: d.workdir })).stdout;
    if (!content.includes("<<<<<<<")) return giveUp(`${path} has no text conflict markers (binary, deleted or renamed)`);
    const resolution = await d.resolveFile({ path, content, trunkGoal, incomingGoal: incoming.goal });
    if ("escalate" in resolution) return giveUp(resolution.escalate);
    const written = await d.shell(`printf %s ${base64(resolution.content)} | base64 -d > ${quote(path)}`, { cwd: d.workdir });
    if (written.exitCode !== 0) throw new Error(`writing ${path} failed: ${written.stderr.trim()}`);
    await repo.must(`add -- ${quote(path)}`);
  }
  await repo.must("commit -q --no-edit");
  return null;
}
