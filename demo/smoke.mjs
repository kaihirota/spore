// End-to-end check against the deployed gateway: two agents edit the same line of trunk.
// Usage: SPORE_URL=https://... SPORE_KEY=... node demo/smoke.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, git, timed } from "./client.mjs";

async function agentEdit(goal, agent, from, to) {
  const task = await api("POST", "/tasks", { goal, agent });
  const dir = join(mkdtempSync(join(tmpdir(), "spore-agent-")), "repo");
  git(tmpdir(), task.token, "clone", "-q", task.remote, dir);
  const file = join(dir, "src/flags.js");
  writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
  git(dir, task.token, "commit", "-qam", goal);
  git(dir, task.token, "push", "-q", "origin", "main");
  return { taskId: task.taskId, sha: git(dir, task.token, "rev-parse", "HEAD") };
}

const a = await agentEdit("raise the rate limit", "agent-1", "return 100;", "return 200;");
const b = await agentEdit("lower the rate limit", "agent-2", "return 100;", "return 50;");
await timed("submit A", () => api("POST", `/tasks/${a.taskId}/submit`, { sha: a.sha }));
const queued = await timed("submit B", () => api("POST", `/tasks/${b.taskId}/submit`, { sha: b.sha }));
if (queued.status === "queued") {
  const record = await api("GET", `/records/${queued.record}`);
  console.log("record:", JSON.stringify({ ...record, detail: record.detail.split("\n").slice(0, 12).join("\n") }, null, 2));
}
console.log("why src/flags.js:", JSON.stringify(await api("GET", "/why?path=src/flags.js"), null, 2));
