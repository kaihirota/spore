import { describe, expect, it } from "vitest";
import { pushToMain, subscriptionRequest } from "../../src/integrator/events";

const SHA = "b".repeat(40);
const event = (ref: string, after = SHA) => ({
  type: "cf.artifacts.repo.pushed",
  source: { namespace: "spore", repoName: "task-1a2b3c4d" },
  payload: { ref, before: "a".repeat(40), after, commits: [], totalCommitsCount: 1, commitsTruncated: false },
  metadata: { accountId: "acc", eventSubscriptionId: "sub", timestamp: "2026-10-06T00:00:00Z" },
});

describe("pushToMain", () => {
  it("returns the repo and new commit of a push to main", () => {
    expect(pushToMain(event("refs/heads/main"))).toEqual({ repo: "task-1a2b3c4d", sha: SHA });
  });

  it("ignores pushes to other branches", () => {
    expect(pushToMain(event("refs/heads/wip"))).toBeNull();
  });

  it("ignores a branch deletion", () => {
    expect(pushToMain(event("refs/heads/main", "0".repeat(40)))).toBeNull();
  });

  it("ignores other event types", () => {
    expect(pushToMain({ ...event("refs/heads/main"), type: "cf.artifacts.repo.cloned" })).toBeNull();
  });
});

describe("subscriptionRequest", () => {
  it("subscribes one repo's pushes to the queue", () => {
    expect(subscriptionRequest({ namespace: "spore", repo: "task-1a2b3c4d", queueId: "q1" })).toEqual({
      name: "spore-fork task-1a2b3c4d",
      enabled: true,
      source: { type: "artifacts.repo", namespace: "spore", repo_name: "task-1a2b3c4d" },
      destination: { type: "queues.queue", queue_id: "q1" },
      events: ["pushed"],
    });
  });
});
