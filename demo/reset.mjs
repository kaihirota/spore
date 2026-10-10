// Recreates the trunk repo from demo/sample, clears the integrator, and deletes the forks and push
// subscriptions left by earlier runs, for a clean demo run. Needs a logged-in wrangler.
// Usage: SPORE_URL=https://... SPORE_KEY=... node demo/reset.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, git } from "./client.mjs";

const NAMESPACE = "spore";
const TRUNK = "trunk";
const PUSH_QUEUE = "spore-pushes";

export function wrangler(...args) {
  const output = execFileSync("npx", ["wrangler", "artifacts", "repos", ...args, "--namespace", NAMESPACE, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output.slice(output.search(/^[[{]/m)));
}

// Every task forks trunk; forks from earlier runs are finished with and would otherwise be kept and billed.
// A fork that will not delete is reported and left for the next reset; it does not stop this one.
function deleteForks() {
  let removed = 0;
  const failed = new Set();
  const remaining = () => wrangler("list").filter((r) => r.name.startsWith("task-") && !failed.has(r.name));
  for (let forks = remaining(); forks.length; forks = remaining()) {
    for (const fork of forks) {
      try {
        wrangler("delete", fork.name, "--force");
        removed++;
      } catch (error) {
        failed.add(fork.name);
        console.log(`could not delete ${fork.name}: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
      }
    }
  }
  return removed;
}

// Repo deletes and creates take a few seconds to be visible everywhere, so each step retries.
export async function retry(label, run) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 10) throw new Error(`${label} kept failing: ${error.stderr ?? error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// Each fork gets its own push subscription; the earlier run's forks are finished with.
function deleteForkSubscriptions() {
  const list = (page) =>
    JSON.parse(execFileSync("npx", ["wrangler", "queues", "subscription", "list", PUSH_QUEUE, "--json", "--per-page", "100", "--page", String(page)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/^[^[{]*/, ""));
  let removed = 0;
  for (let batch = list(1); ; batch = list(1)) {
    const forks = (Array.isArray(batch) ? batch : batch.result ?? []).filter((sub) => String(sub.name).startsWith("spore-fork "));
    if (forks.length === 0) return removed;
    for (const sub of forks) {
      execFileSync("npx", ["wrangler", "queues", "subscription", "delete", PUSH_QUEUE, "--id", sub.id, "--force"], { stdio: "ignore" });
      removed++;
    }
  }
}

/** Replaces a repo with a fresh one holding seedDir as its only commit; returns its remote and a write token. */
export async function recreateRepo(name, seedDir) {
  try {
    wrangler("delete", name, "--force");
  } catch (error) {
    if (!String(error.stderr).includes("not found")) throw error;
  }
  const repo = await retry(`create ${name}`, () => wrangler("create", name));
  const token = (await retry(`issue ${name} token`, () => wrangler("issue-token", name, "--scope", "write", "--ttl", "3600"))).plaintext;
  const seed = mkdtempSync(join(tmpdir(), "spore-seed-"));
  cpSync(seedDir, seed, { recursive: true });
  git(seed, token, "init", "-q", "-b", "main");
  git(seed, token, "add", ".");
  git(seed, token, "commit", "-qm", "Seed");
  await retry(`push seed to ${name}`, () => git(seed, token, "push", "-q", repo.remote, "main"));
  return { remote: repo.remote, token, head: git(seed, token, "rev-parse", "--short", "HEAD") };
}

/** Clears the forks, push subscriptions and integrator of earlier runs and reseeds trunk from seedDir. */
export async function resetSpore(seedDir) {
  console.log(`removed ${deleteForkSubscriptions()} fork push subscriptions`);
  console.log(`deleted ${deleteForks()} forks`);
  const trunk = await recreateRepo(TRUNK, seedDir);
  await retry("fork new trunk from the Worker", () => api("POST", "/tasks", { goal: "check trunk is visible", agent: "reset" }));
  await api("POST", "/reset");
  console.log(`trunk recreated at ${trunk.head} and integrator cleared`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await resetSpore(fileURLToPath(new URL("./sample", import.meta.url)));
