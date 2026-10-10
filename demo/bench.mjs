// Runs one scripted workload through Spore and through plain git on Cloudflare Artifacts, and prints
// a scoreboard. Both use the same tasks, agents, work times and goal tests; only how changes reach
// trunk differs. Plain git is the rebase-retest-push loop of a branch protection rule that requires
// branches to be up to date: on a conflicting rebase the agent redoes its change on the new trunk.
// Usage: SPORE_URL=https://... SPORE_KEY=... node demo/bench.mjs [--strategy spore|git|both]
//          [--agents 16] [--tasks 48] [--seed 1] [--work 5000-20000] [--rework 10000] [--out dir]
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const MODULES = 6;
const FUNCTIONS = 4;
const MAX_ATTEMPTS = 25;

/** The project every run starts from: a hot registry file, modules of small functions, a config value, a helper and its caller. */
export function project() {
  const module = (k) =>
    `// Module ${k}\n` + Array.from({ length: FUNCTIONS }, (_, j) => `export function f${j}() {\n  return { base: 0 }; // f${j}\n}\n`).join("\n");
  const files = {
    "package.json": JSON.stringify({ name: "bench-project", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    "src/registry.js": "export const handlers = [\n  // end of handlers\n];\n",
    "src/config.js": "export const TIMEOUT = 30;\n",
    "src/text.js": "export function label(s) {\n  return s;\n}\n",
    "src/report.js": 'import { label } from "./text.js";\n\nexport function title(name) {\n  return label(name);\n}\n',
    "test/base.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/registry.js";
import { TIMEOUT } from "../src/config.js";

test("handlers is a list", () => assert.ok(Array.isArray(handlers)));
test("timeout is a positive number", () => assert.ok(TIMEOUT > 0));
`,
  };
  for (let k = 0; k < MODULES; k++) files[`src/m${k}.js`] = module(k);
  return files;
}

const goalTest = (name, imports, body) => `import { test } from "node:test";
import assert from "node:assert/strict";
${imports}

test(${JSON.stringify(name)}, () => {
  ${body}
});
`;

// mulberry32: a small seeded generator, so a seed gives the same tasks and work times every run.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The workload. Each task edits by rewriting file content, so it can be redone on any later trunk; an edit
 * that no longer applies returns null. Two tasks contradict (one value set two ways) and two break each
 * other only when combined (a helper's behaviour and a caller's expectation), so a person is needed for both.
 */
export function tasks(count, seed, work = [5000, 20000]) {
  const next = random(seed);
  const between = ([low, high]) => Math.round(low + next() * (high - low));
  const list = [
    {
      goal: "set TIMEOUT to exactly 10",
      edits: { "src/config.js": (c) => c.replace(/TIMEOUT = \d+;/, "TIMEOUT = 10;") },
      test: goalTest("TIMEOUT is 10", 'import { TIMEOUT } from "../../src/config.js";', "assert.equal(TIMEOUT, 10);"),
    },
    {
      goal: "set TIMEOUT to exactly 60",
      edits: { "src/config.js": (c) => c.replace(/TIMEOUT = \d+;/, "TIMEOUT = 60;") },
      test: goalTest("TIMEOUT is 60", 'import { TIMEOUT } from "../../src/config.js";', "assert.equal(TIMEOUT, 60);"),
    },
    {
      goal: "make label() lowercase its input",
      edits: { "src/text.js": (c) => (c.includes("return s;") ? c.replace("return s;", "return s.toLowerCase();") : null) },
      test: goalTest("label lowercases", 'import { label } from "../../src/text.js";', 'assert.equal(label("AbC"), "abc");'),
    },
    {
      goal: "end every title with an exclamation mark",
      edits: { "src/report.js": (c) => (c.includes("return label(name);") ? c.replace("return label(name);", 'return label(name) + "!";') : null) },
      test: goalTest("title keeps the name and adds !", 'import { title } from "../../src/report.js";', 'assert.equal(title("Ab"), "Ab!");'),
    },
  ];
  for (let i = list.length; i < count; i++) {
    if (next() < 0.4) {
      list.push({
        goal: `register handler h${i}`,
        edits: { "src/registry.js": (c) => (c.includes("  // end of handlers\n") ? c.replace("  // end of handlers\n", `  { name: "h${i}", run: () => ${i} },\n  // end of handlers\n`) : null) },
        test: goalTest(`handler h${i} is registered`, 'import { handlers } from "../../src/registry.js";', `assert.equal(handlers.find((h) => h.name === "h${i}")?.run(), ${i});`),
      });
    } else {
      const k = Math.floor(next() * MODULES);
      const j = Math.floor(next() * FUNCTIONS);
      const line = new RegExp(`(  return \\{[^}]*?) \\}; // f${j}\\n`);
      list.push({
        goal: `add field k${i} to m${k}.f${j}`,
        edits: { [`src/m${k}.js`]: (c) => (line.test(c) ? c.replace(line, `$1, k${i}: ${i} }; // f${j}\n`) : null) },
        test: goalTest(`m${k}.f${j} returns k${i}`, `import { f${j} } from "../../src/m${k}.js";`, `assert.equal(f${j}().k${i}, ${i});`),
      });
    }
  }
  // The four special tasks spread through the queue instead of all starting first.
  const special = list.splice(0, 4);
  special.forEach((task, n) => list.splice(Math.floor(((n + 1) * list.length) / 5), 0, task));
  return list.map((task, n) => ({ ...task, n, workMs: between(work) }));
}

/** Applies a task's edits and goal test in a working copy; false when an edit no longer applies. */
export function applyTask(dir, task, testName) {
  for (const [path, edit] of Object.entries(task.edits)) {
    const file = join(dir, path);
    const changed = edit(readFileSync(file, "utf8"));
    if (changed === null) return false;
    writeFileSync(file, changed);
  }
  mkdirSync(join(dir, "test/goals"), { recursive: true });
  writeFileSync(join(dir, "test/goals", `${testName}.test.js`), task.test);
  return true;
}

export function writeProject(dir) {
  for (const [path, content] of Object.entries(project())) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The bench measures Spore and git, not this machine's connection: transport failures are retried,
// while a rejected push or an HTTP error from Spore is returned as it is.
const NETWORK = /Could not resolve host|Failed to connect|timed out|Connection reset|SSL|early EOF|unable to access|fetch failed|ECONNRESET|ETIMEDOUT/i;

async function retryNetwork(attempt) {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      const text = `${error.message} ${error.stderr ?? ""} ${error.cause?.message ?? ""}`;
      if (n >= 6 || !NETWORK.test(text) || /rejected|non-fast-forward|fetch first/.test(text)) throw error;
      await sleep(2000 * n);
    }
  }
}

async function git(cwd, token, ...args) {
  const auth = token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
  const { stdout } = await retryNetwork(() => run("git", [...auth, "-c", "user.name=agent", "-c", "user.email=agent@spore", ...args], { cwd, maxBuffer: 1 << 24 }));
  return stdout.trim();
}

async function gitStatus(cwd, token, ...args) {
  try {
    await git(cwd, token, ...args);
    return 0;
  } catch (error) {
    return error.code ?? 1;
  }
}

async function nodeTests(cwd) {
  try {
    const { stdout } = await run("node", ["--test"], { cwd, maxBuffer: 1 << 24 });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: String(error.stdout ?? "") };
  }
}

const workdir = (label) => join(mkdtempSync(join(tmpdir(), `spore-bench-${label}-`)), "repo");

/** Runs the queue of tasks with `agents` workers pulling the next task as each finishes its last; a task that throws is counted, not retried. */
async function swarm(queue, agents, doTask, stats) {
  let next = 0;
  stats.errors = [];
  await Promise.all(Array.from({ length: agents }, async (_, a) => {
    while (next < queue.length) {
      const task = queue[next++];
      await doTask(`agent-${a + 1}`, task).catch((error) => {
        stats.errors.push({ task: task.n, error: String(error.message).slice(0, 300) });
        console.error(`task ${task.n} failed: ${error.message}`);
      });
    }
  }));
}

// Plain git: rebase onto the latest trunk, retest, push; a conflicting rebase means redoing the change.
async function plainGitTask(trunk, reworkMs, agent, task, stats) {
  const dir = workdir(agent);
  await git(tmpdir(), trunk.token, "clone", "-q", trunk.remote, dir);
  await sleep(task.workMs);
  const id = `t${task.n}`;
  applyTask(dir, task, id);
  await git(dir, null, "add", "-A");
  await git(dir, null, "commit", "-qm", task.goal);
  const blockedFrom = Date.now();
  let outcome = "needs_person";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!(await nodeTests(dir)).ok) break;
    if ((await gitStatus(dir, trunk.token, "push", "-q", "origin", "HEAD:main")) === 0) {
      outcome = "landed";
      break;
    }
    stats.rejectedPushes++;
    await git(dir, trunk.token, "fetch", "-q", "origin", "main");
    if ((await gitStatus(dir, null, "rebase", "-q", "origin/main")) !== 0) {
      stats.conflicts++;
      await gitStatus(dir, null, "rebase", "--abort");
      await git(dir, null, "reset", "-q", "--hard", "origin/main");
      await sleep(reworkMs);
      stats.reworkMs += reworkMs;
      if (!applyTask(dir, task, id)) break;
      await git(dir, null, "add", "-A");
      await git(dir, null, "commit", "-qm", task.goal);
    }
    if (attempt === MAX_ATTEMPTS) outcome = "gave_up";
  }
  stats.blockedMs += Date.now() - blockedFrom;
  stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
  stats.log.push({ at: Date.now(), agent, task: task.n, outcome });
}

async function plainGit(queue, options) {
  const { recreateRepo } = await import("./reset.mjs");
  const seed = mkdtempSync(join(tmpdir(), "spore-bench-seed-"));
  writeProject(seed);
  const trunk = await recreateRepo(options.gitRepo, seed);
  const stats = { blockedMs: 0, reworkMs: 0, conflicts: 0, rejectedPushes: 0, outcomes: {}, log: [] };
  const started = Date.now();
  await swarm(queue, options.agents, (agent, task) => plainGitTask(trunk, options.reworkMs, agent, task, stats), stats);
  return { ...stats, wallMs: Date.now() - started, trunk };
}

// Spore: fork, work, push, submit without waiting for the merge, move on. Conflicts and failing tests wait
// in the queue for the resolver or a person.
async function sporeTask(api, agent, task, stats) {
  const started = await api("POST", "/tasks", { goal: task.goal, agent });
  stats.trunk ??= { remote: started.trunkRemote, token: started.trunkToken };
  const dir = workdir(agent);
  await git(tmpdir(), started.token, "clone", "-q", started.remote, dir);
  await sleep(task.workMs);
  applyTask(dir, task, started.taskId);
  await git(dir, null, "add", "-A");
  await git(dir, null, "commit", "-qm", task.goal);
  await git(dir, started.token, "push", "-q", "origin", "main");
  const sha = await git(dir, null, "rev-parse", "HEAD");
  const blockedFrom = Date.now();
  const result = await api("POST", `/tasks/${started.taskId}/submit`, { sha, wait: false });
  stats.blockedMs += Date.now() - blockedFrom;
  stats.outcomes[result.status] = (stats.outcomes[result.status] ?? 0) + 1;
  stats.log.push({ at: Date.now(), agent, task: task.n, taskId: started.taskId, outcome: result.status });
}

async function spore(queue, options) {
  const client = await import("./client.mjs");
  const api = (...args) => retryNetwork(() => client.api(...args));
  const { resetSpore } = await import("./reset.mjs");
  const seed = mkdtempSync(join(tmpdir(), "spore-bench-seed-"));
  writeProject(seed);
  await resetSpore(seed);
  const stats = { blockedMs: 0, outcomes: {}, log: [] };
  const started = Date.now();
  await swarm(queue, options.agents, (agent, task) => sporeTask(api, agent, task, stats), stats);
  const agentsDoneMs = Date.now() - started;
  // The run ends when every submit has merged or become a record, and the resolver has merged or escalated every record.
  let records = [];
  let states = {};
  for (const until = Date.now() + 30 * 60_000; Date.now() < until; await sleep(2000)) {
    const state = await api("GET", "/state");
    records = state.records;
    states = {};
    for (const t of state.tasks.filter((t) => t.resolves === null)) states[t.state] = (states[t.state] ?? 0) + 1;
    if (!states.submitted && records.every((r) => ["merged", "escalated", "dismissed"].includes(r.state))) break;
  }
  const count = (state) => records.filter((r) => r.state === state).length;
  return {
    ...stats,
    taskStates: states,
    agentsDoneMs,
    wallMs: Date.now() - started,
    records: { total: records.length, conflicts: records.filter((r) => r.kind === "merge").length, failingTests: records.filter((r) => r.kind === "tests").length, resolved: count("merged"), escalated: count("escalated") },
  };
}

/** Clones the final trunk, counts the goal tests on it and runs every test. */
async function inspectTrunk(trunk) {
  const dir = workdir("final");
  await git(tmpdir(), trunk.token, "clone", "-q", trunk.remote, dir);
  let goals = [];
  try {
    goals = readdirSync(join(dir, "test/goals"));
  } catch {
    // no goal tests landed
  }
  const tests = await nodeTests(dir);
  const count = (name) => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(tests.output)?.[1] ?? 0);
  return { goalsOnTrunk: goals.length, green: tests.ok, passed: count("pass"), failed: count("fail") };
}

function parse(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const [low, high = low] = flag("work", "5000-20000").split("-").map(Number);
  return {
    strategy: flag("strategy", "both"),
    agents: Number(flag("agents", 16)),
    tasks: Number(flag("tasks", 48)),
    seed: Number(flag("seed", 1)),
    work: [low, high],
    reworkMs: Number(flag("rework", 10000)),
    gitRepo: flag("git-repo", "bench-git"),
    out: flag("out", fileURLToPath(new URL("../docs/bench", import.meta.url))),
  };
}

const minutes = (ms) => (ms / 60000).toFixed(1);

async function main() {
  const options = parse(process.argv.slice(2));
  const queue = tasks(options.tasks, options.seed, options.work);
  const results = { options: { ...options, out: undefined }, at: new Date().toISOString() };
  for (const strategy of options.strategy === "both" ? ["git", "spore"] : [options.strategy]) {
    console.log(`\n${strategy}: ${options.tasks} tasks, ${options.agents} agents, seed ${options.seed}`);
    const result = strategy === "git" ? await plainGit(queue, options) : await spore(queue, options);
    const final = await inspectTrunk(result.trunk);
    delete result.trunk;
    results[strategy] = { ...result, final };
    console.log(`${strategy}: ${final.goalsOnTrunk}/${options.tasks} goals on trunk, ${final.green ? "green" : "red"} (${final.passed} passed, ${final.failed} failed), `
      + `wall ${minutes(result.wallMs)} min, agents blocked ${minutes(result.blockedMs)} agent-min`);
  }
  mkdirSync(options.out, { recursive: true });
  const file = join(options.out, `bench-${options.tasks}x${options.agents}-seed${options.seed}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(results, null, 1) + "\n");
  console.log(`\nwrote ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
