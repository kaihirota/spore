// Demo driver: 9 scripted agents fork the same trunk and push pre-written edits; the integrator
// sees each push through its event subscription, so each agent learns who it would clash with.
// agent-8 goes next, after the agents it was warned about; agent-9 starts late on agent-2's lines, and when
// the coordinator asks both whether their change there is required, both say yes, so agent-9's task goes to
// agent-2; the rest submit straight away. With --resolve the driver then watches the
// integrator's own resolver drain the conflict queue on Cloudflare.
// Usage: SPORE_URL=https://... SPORE_KEY=... node demo/swarm.mjs [--resolve]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, git } from "./client.mjs";

const SET_LINE = "  flags[name] = value;";

const flagsTest = (name, body) => `import { test } from "node:test";
import assert from "node:assert/strict";
import * as flags from "../../src/flags.js";
import * as limits from "../../src/limits.js";
import { health } from "../../src/health.js";
import { readFileSync } from "node:fs";

test(${JSON.stringify(name)}, () => {
${body}
});
`;

// Each agent ships a test for its own goal at test/goals/<taskId>.test.js, so a merge has to meet every goal.
const AGENTS = [
  {
    agent: "agent-1",
    goal: "document how to read a flag",
    edits: [["README.md", "A small feature flag service.\n", "A small feature flag service.\n\nRead a flag with `getFlag(name)`; unknown flags are off.\n"]],
    test: flagsTest("README explains getFlag", '  assert.match(readFileSync(new URL("../../README.md", import.meta.url), "utf8"), /getFlag\\(name\\)/);'),
  },
  {
    agent: "agent-2",
    goal: "report the service version from health",
    edits: [["src/health.js", "return { ok: true };", 'return { ok: true, version: "1.0.0" };']],
    test: flagsTest("health reports version 1.0.0", '  assert.equal(health().version, "1.0.0");'),
  },
  {
    agent: "agent-3",
    goal: "set the rate limit to exactly 200 for every client",
    edits: [["src/limits.js", "return 100;", "return 200;"]],
    test: flagsTest("rate limit is exactly 200 for every client", "  assert.equal(limits.rateLimit(), 200);"),
  },
  {
    agent: "agent-4",
    goal: "set the rate limit to exactly 50 for every client",
    edits: [["src/limits.js", "return 100;", "return 50;"]],
    test: flagsTest("rate limit is exactly 50 for every client", "  assert.equal(limits.rateLimit(), 50);"),
  },
  {
    agent: "agent-5",
    goal: "return flag names in sorted order",
    edits: [["src/flags.js", "return Object.keys(flags);", "return Object.keys(flags).sort();"]],
    test: flagsTest("flag names come back sorted", "  const names = flags.listFlags();\n  assert.deepEqual(names, [...names].sort());"),
  },
  {
    agent: "agent-6",
    goal: "record every flag change in an audit log",
    edits: [
      ["src/flags.js", "const flags = { newCheckout: false, darkMode: true };\n", "const flags = { newCheckout: false, darkMode: true };\nexport const audit = [];\n"],
      ["src/flags.js", SET_LINE, `  audit.push({ name, value });\n${SET_LINE}`],
    ],
    test: flagsTest("every flag change is in the audit log", '  flags.setFlag("beta", true);\n  assert.ok(flags.audit.some((entry) => entry.name === "beta" && entry.value === true));'),
  },
  {
    agent: "agent-7",
    goal: "reject non-boolean flag values",
    edits: [["src/flags.js", SET_LINE, `  if (typeof value !== "boolean") throw new TypeError("flag values must be booleans");\n${SET_LINE}`]],
    test: flagsTest("non-boolean flag values are rejected", '  assert.throws(() => flags.setFlag("beta", "yes"), TypeError);'),
  },
  {
    agent: "agent-8",
    goSecond: true,
    goal: "return the previous value from setFlag",
    edits: [["src/flags.js", SET_LINE, `  const previous = getFlag(name);\n${SET_LINE}\n  return previous;`]],
    test: flagsTest("setFlag returns the previous value", '  flags.setFlag("p", true);\n  assert.equal(flags.setFlag("p", false), true);'),
  },
  {
    agent: "agent-9",
    startsAfter: "agent-2",
    takesSuggestion: true,
    goal: "report the uptime from health",
    edits: [["src/health.js", "ok: true", "ok: true, uptime: Math.round(process.uptime())"]],
    test: flagsTest("health reports the uptime in seconds", '  assert.equal(typeof health().uptime, "number");'),
  },
];

const KEEP_WORKING_MS = 25_000;
const started = Date.now();
const log = (message) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${message}`);

async function fork({ agent, goal }) {
  const task = await api("POST", "/tasks", { goal, agent });
  const dir = join(mkdtempSync(join(tmpdir(), `spore-${agent}-`)), "repo");
  git(tmpdir(), task.token, "clone", "-q", task.remote, dir);
  log(`${agent} forked trunk for "${goal}"`);
  return { ...task, dir };
}

function applyEdits(spec, task) {
  for (const [path, from, to] of spec.edits) {
    const file = join(task.dir, path);
    const content = readFileSync(file, "utf8");
    if (!content.includes(from)) throw new Error(`${spec.agent}: ${path} does not contain ${JSON.stringify(from)}`);
    writeFileSync(file, content.replace(from, to));
  }
  mkdirSync(join(task.dir, "test/goals"), { recursive: true });
  writeFileSync(join(task.dir, `test/goals/${task.taskId}.test.js`), spec.test);
  git(task.dir, task.token, "add", "-A");
  git(task.dir, task.token, "commit", "-qm", spec.goal);
}

// Waits for the push event to reach the integrator; reports the push directly if forks are not watched.
async function inflightAfterPush(task) {
  for (let waited = 0; task.watched && waited < 60_000; waited += 500) {
    const { inflight } = await api("GET", `/tasks/${task.taskId}`);
    if (inflight?.sha === task.sha) return inflight;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (task.watched) log(`no push event for task ${task.taskId} within 60 s, reporting the push directly`);
  const reported = await api("POST", `/tasks/${task.taskId}/progress`, { sha: task.sha });
  return {
    changes: reported.changes,
    conflictsWith: reported.conflictsWith.map((c) => c.taskId),
    conflictsWithTrunk: reported.conflictsWithTrunk.map((c) => c.taskId),
  };
}

async function report(spec, task, known = []) {
  const inflight = await inflightAfterPush(task);
  const { changes } = inflight;
  const tasks = await api("GET", "/tasks");
  const describe = (onTrunk) => (id) => {
    const other = tasks.find((t) => t.id === id);
    return { taskId: id, agent: other?.agent ?? `task ${id}`, goal: other?.goal ?? "", onTrunk };
  };
  const conflictsWith = [...inflight.conflictsWith.map(describe(false)), ...(inflight.conflictsWithTrunk ?? []).map(describe(true))];
  const where = [...new Set(changes.filter((c) => !c.file.startsWith("test/")).map((c) => (c.symbol ? `${c.symbol} in ${c.file}` : c.file)))].join(", ");
  if (known.length === 0 && !task.reported) log(`${spec.agent} is changing ${where}`);
  for (const other of conflictsWith.filter((c) => !known.some((k) => k.taskId === c.taskId))) {
    const what = other.onTrunk ? "already changed the same lines on trunk to" : "is changing the same lines to";
    log(`${known.length || task.reported ? `${spec.agent} now ` : "  "}warned: ${other.agent} ${what} "${other.goal}"`);
  }
  return conflictsWith;
}

async function edit(spec, task) {
  applyEdits(spec, task);
  git(task.dir, task.token, "push", "-q", "origin", "main");
  return { ...task, sha: git(task.dir, task.token, "rev-parse", "HEAD") };
}

// Waits until the agents it clashes with are merged or queued, then rebuilds its change on the new trunk.
async function goSecond(spec, task, conflictsWith) {
  const waitFor = new Set(conflictsWith.map((c) => c.taskId));
  log(`${spec.agent} goes next, after ${conflictsWith.map((c) => c.agent).join(" and ")}`);
  while ((await api("GET", "/tasks")).some((t) => waitFor.has(t.id) && (t.state === "active" || t.state === "submitted"))) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  git(task.dir, task.trunkToken, "fetch", "-q", task.trunkRemote, "main");
  git(task.dir, task.token, "reset", "-q", "--hard", "FETCH_HEAD");
  applyEdits(spec, task);
  git(task.dir, task.token, "push", "-q", "--force", "origin", "main");
  const rebuilt = { ...task, sha: git(task.dir, task.token, "rev-parse", "HEAD") };
  if ((await report(spec, rebuilt)).length === 0) log(`${spec.agent} rebuilt on the new trunk and is clear`);
  return rebuilt;
}

async function submit(spec, task) {
  const result = await api("POST", `/tasks/${task.taskId}/submit`, { sha: task.sha });
  const outcome = {
    merged: () => `merged ${result.trunkSha.slice(0, 7)}`,
    queued: () => `queued as #${result.record}, moving on`,
    already_in_trunk: () => "had nothing new to merge",
  }[result.status];
  log(`${spec.agent} ${outcome()}`);
  return result;
}

// Fork concurrently from the same trunk commit, as a real swarm would. Pushes leave 300 ms apart
// in AGENTS order, so push events, warnings and the merge queue come out the same every run.
const settle = (outcomes, step) =>
  Promise.allSettled(AGENTS.map((spec, i) => (outcomes[i].status === "fulfilled" ? step(spec, outcomes[i].value, i) : Promise.reject(outcomes[i].reason))));
// A late starter begins once the agent it follows has a push in flight.
async function waitForPush(agent) {
  for (;;) {
    const mine = (await api("GET", "/tasks")).find((t) => t.agent === agent);
    if (mine && (await api("GET", `/tasks/${mine.id}`)).inflight) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Answers the coordinator's question about the agent's own change, then waits for the verdict.
async function answerCoordinator(spec, task) {
  const { question } = await api("GET", `/tasks/${task.taskId}`);
  if (!question) return false;
  log(`coordinator asks ${spec.agent} whether its change to ${question.about} is required`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await api("POST", `/tasks/${task.taskId}/answer`, { agent: spec.agent, required: true, reason: `"${spec.goal}" changes it` });
  log(`${spec.agent} answers: required`);
  for (let waited = 0; waited < 60_000; waited += 500) {
    const { verdict } = await api("GET", `/tasks/${task.taskId}`);
    if (verdict?.decision === "handover" && verdict.state === "done") {
      log(`${spec.agent} hands "${spec.goal}" to ${verdict.to} and moves on`);
      return true;
    }
    if (verdict && verdict.state !== "pending") return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// It stops exactly on time, since submits leave in a fixed order only 300 ms apart.
async function keepWorking(spec, ms) {
  const answered = new Set();
  const until = Date.now() + ms;
  const pause = (wanted) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(wanted, until - Date.now()))));
  while (until - Date.now() > 1500) {
    // While it works, an agent answers the coordinator's questions about its own tasks.
    for (const t of (await api("GET", "/tasks")).filter((t) => t.agent === spec.agent && t.question && !t.question.answer && !t.verdict && !answered.has(t.id))) {
      answered.add(t.id);
      await pause(4000);
      await api("POST", `/tasks/${t.id}/answer`, { agent: spec.agent, required: true, reason: `"${t.goal}" changes it` });
      log(`${spec.agent} answers: required`);
    }
    await pause(1000);
  }
  await pause(until - Date.now());
}

// After its own submit, an agent picks up the tasks handed to it and does each on the new trunk.
async function pickUpHandovers(spec) {
  const results = [];
  for (const handed of (await api("GET", "/tasks")).filter((t) => t.agent === spec.agent && t.handedFrom && t.state === "active")) {
    const work = AGENTS.find((a) => a.goal === handed.goal);
    const access = await api("POST", `/tasks/${handed.id}/access`, { agent: spec.agent });
    const dir = join(mkdtempSync(join(tmpdir(), `spore-${spec.agent}-handed-`)), "repo");
    git(tmpdir(), access.token, "clone", "-q", access.remote, dir);
    const task = { taskId: handed.id, dir, token: access.token };
    git(dir, access.trunkToken, "fetch", "-q", access.trunkRemote, "main");
    git(dir, access.token, "reset", "-q", "--hard", "FETCH_HEAD");
    log(`${spec.agent} picks up "${handed.goal}" from ${handed.handedFrom} on the new trunk`);
    applyEdits({ ...work, agent: spec.agent }, task);
    git(dir, access.token, "push", "-q", "--force", "origin", "main");
    results.push(await submit({ ...work, agent: spec.agent }, { ...task, sha: git(dir, access.token, "rev-parse", "HEAD") }));
  }
  return results;
}

// A late starter takes its task only once the agent it follows has pushed, so its start time says so too.
const forks = await Promise.allSettled(AGENTS.map((spec) => (spec.startsAfter ? null : fork(spec))));
const settled = await settle(forks, async (spec, forked, i) => {
  await new Promise((resolve) => setTimeout(resolve, i * 300));
  if (spec.startsAfter) {
    await waitForPush(spec.startsAfter);
    forked = await fork(spec);
  }
  const task = await edit(spec, forked);
  const first = await report(spec, task);
  if (spec.takesSuggestion && (await answerCoordinator(spec, task))) return [];
  // Agents keep working after pushing, so every push event arrives while the others are still in flight.
  await keepWorking(spec, KEEP_WORKING_MS);
  const later = await report(spec, { ...task, reported: true }, first);
  // An agent remembers every warning: the agents it clashed with may have submitted by now.
  const conflictsWith = [...first, ...later.filter((c) => !first.some((f) => f.taskId === c.taskId))];
  const own = await submit(spec, spec.goSecond && conflictsWith.length > 0 ? await goSecond(spec, task, conflictsWith) : task);
  return [own, ...(await pickUpHandovers(spec))];
});
const results = [];
let failed = 0;
settled.forEach((outcome, i) => {
  if (outcome.status === "fulfilled") results.push(...outcome.value);
  else {
    failed++;
    log(`${AGENTS[i].agent} failed: ${outcome.reason.message}`);
  }
});
const queued = results.filter((r) => r.status === "queued").map((r) => r.record);
log(`${results.filter((r) => r.status === "merged").length} merged, ${queued.length} queued, ${failed} failed`);

if (process.argv.includes("--resolve")) {
  const settled = new Set();
  for (const started = Date.now(); Date.now() - started < 5 * 60_000; ) {
    const records = await api("GET", "/records");
    for (const r of records.filter((r) => !settled.has(r.id) && ["merged", "escalated", "dismissed"].includes(r.state))) {
      settled.add(r.id);
      log(`#${r.id} "${r.goal}": ${r.state}${r.reason && r.state === "escalated" ? ` (${r.reason})` : ""}`);
    }
    if (records.every((r) => settled.has(r.id))) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
