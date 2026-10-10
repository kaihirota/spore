const ZERO_SHA = "0".repeat(40);

/** The repo and new tip of an Artifacts push to main, or null for any other event. */
export function pushToMain(event: unknown): { repo: string; sha: string } | null {
  const e = event as { type?: string; source?: { repoName?: string }; payload?: { ref?: string; after?: string } };
  if (e?.type !== "cf.artifacts.repo.pushed" || e.payload?.ref !== "refs/heads/main") return null;
  const sha = e.payload.after;
  if (!e.source?.repoName || !sha || !/^[0-9a-f]{40}$/.test(sha) || sha === ZERO_SHA) return null;
  return { repo: e.source.repoName, sha };
}

/** Event subscription body for one repo's pushes. Artifacts push events can only be subscribed per repo. */
export function subscriptionRequest(input: { namespace: string; repo: string; queueId: string }) {
  return {
    name: `spore-fork ${input.repo}`,
    enabled: true,
    source: { type: "artifacts.repo", namespace: input.namespace, repo_name: input.repo },
    destination: { type: "queues.queue", queue_id: input.queueId },
    events: ["pushed"],
  };
}
