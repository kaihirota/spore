// Records one real run for the demo video: the live dashboard beside a terminal panel, while the
// swarm runs, a person settles the escalation, and an agent asks /touching and /why. Writes
// demo/video/out/recording/run.webm and events.json (seconds into the recording for each moment).
// Usage: SPORE_URL=https://... SPORE_KEY=... node demo/video/record.mjs   (resets trunk first; SPORE_KEY falls back to API_KEY in .dev.vars)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const devVars = join(root, ".dev.vars");
const KEY = process.env.SPORE_KEY ?? (existsSync(devVars) ? readFileSync(devVars, "utf8").match(/^API_KEY=(.+)$/m)?.[1].trim() : undefined);
const UPSTREAM = process.env.SPORE_URL;
if (!UPSTREAM || !KEY) throw new Error("set SPORE_URL and SPORE_KEY (or API_KEY in .dev.vars)");
const PORT = 8799;
const out = join(here, "out", "recording");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, SPORE_URL: UPSTREAM, SPORE_KEY: KEY };

// The stage page and dashboard are served locally; API calls are proxied with the key added here,
// so the key never enters the browser.
const server = createServer(async (req, res) => {
  if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(join(here, "stage.html")));
  if (req.url === "/dash") return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(join(root, "src", "dashboard", "dashboard.html")));
  const body = req.method === "POST" ? await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }) : undefined;
  const up = await fetch(UPSTREAM + req.url, { method: req.method, headers: { authorization: `Bearer ${KEY}` }, body });
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await up.arrayBuffer()));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, body: body && JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

console.log("resetting trunk");
execFileSync("node", [join(root, "demo", "reset.mjs")], { env, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
// The 1920x1080 stage is drawn at twice its size, so the composer can zoom into a region and stay sharp.
const ZOOM = 2;
const context = await browser.newContext({
  viewport: { width: 1920 * ZOOM, height: 1080 * ZOOM },
  recordVideo: { dir: out, size: { width: 1920 * ZOOM, height: 1080 * ZOOM } },
});
const page = await context.newPage();
const started = Date.now();
const events = [];
const mark = (name, extra = {}) => {
  const t = (Date.now() - started) / 1000;
  events.push({ name, t, ...extra });
  console.log(`[${t.toFixed(1).padStart(6)}s] ${name}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ""}`);
};
const term = (text, kind = "", mark = "") => page.evaluate(([t, k, m]) => window.termLine(t, k, m), [text, kind, mark]);

async function click(selector) {
  const target = page.frameLocator("#dash").locator(selector).first();
  // Scroll and click through the DOM: Playwright's own pointer actions misplace targets under page zoom.
  await target.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const box = await target.boundingBox();
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.evaluate(([cx, cy]) => window.moveCursor(cx, cy), [x, y]);
  await sleep(900);
  await page.evaluate(([cx, cy]) => window.clickRipple(cx, cy), [x, y]);
  await target.evaluate((el) => el.click());
  setTimeout(() => page.evaluate(() => window.hideCursor()).catch(() => {}), 1500);
}

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.evaluate((zoom) => (document.documentElement.style.zoom = String(zoom)), ZOOM);
await page.evaluate(() => document.fonts.ready);
// Where each region is on screen, five times a second, so the composer can spotlight what the narration names.
const boxes = [];
const tracking = setInterval(async () => {
  const before = Date.now();
  try {
    const regions = await page.evaluate(() => window.regions());
    boxes.push({ t: ((before + Date.now()) / 2 - started) / 1000, regions });
  } catch {}
}, 200);
// The video's first frame arrives some time after this clock starts; a marker the composer finds in the
// footage ties the two together.
await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="sync" style="position:fixed;left:0;top:0;width:200px;height:200px;background:#ff00ff;z-index:99"></div>'));
mark("sync");
await sleep(600);
await page.evaluate(() => document.getElementById("sync").remove());
await sleep(1400);
mark("stage_ready");

async function showTouching() {
  mark("touching_query");
  await term("GET /touching?path=src/flags.js&symbol=setFlag", "cmd", "touching");
  const answer = await api("GET", "/touching?path=src/flags.js&symbol=setFlag");
  for (const t of answer.inFlight) await term(`in flight  ${t.agent}: ${t.goal}`, "warn", "touching");
  for (const r of answer.waiting) await term(`waiting    #${r.id} ${r.goal}`, "dim", "touching");
  if (answer.inFlight.length + answer.waiting.length === 0) await term("no one", "dim", "touching");
}

// The swarm's own log streams into the terminal panel; its lines also mark the moments the editor needs.
const swarm = spawn("node", [join(root, "demo", "swarm.mjs"), "--resolve"], { env });
let buffered = "";
const swarmLog = [];
let touchingShown = false;
const seen = new Set();
const once = (name, extra) => { if (!seen.has(name)) { seen.add(name); mark(name, extra); } };
swarm.stdout.on("data", async (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/^\[\+\s*[\d.]+s\]\s*/, "");
    swarmLog.push(line);
    if (/forked trunk/.test(line)) once("forks_created");
    if (/is changing/.test(line)) once("first_push_seen");
    if (/warned:/.test(line)) once("first_warning");
    if (/goes next/.test(line)) once("goes_second");
    if (/rebuilt on the new trunk/.test(line)) once("rebuilt");
    if (/ merged [0-9a-f]{7}/.test(line)) once("first_merge");
    if (/queued as #/.test(line)) once("first_queued");
    if (/\d+ merged, \d+ queued/.test(line)) once("submits_done");
    if (/^coordinator asks agent-9/.test(line)) once("handover_suggested");
    if (/^agent-9 hands /.test(line)) once("handed_over");
    if (/^agent-2 picks up /.test(line)) once("picked_up");
    if (events.some((e) => e.name === "picked_up") && /^agent-2 merged/.test(line)) once("handover_merged");
    const settled = line.match(/^#(\d+) ".*": (merged|escalated)/);
    if (settled) mark(`record_${settled[2]}`, { record: Number(settled[1]) });
    const kind = /warned/.test(line) ? "warn" : /queued as|goes next/.test(line) ? "warn" : /escalated/.test(line) ? "bad" : /merged|is clear/.test(line) ? "ok" : /forked/.test(line) ? "dim" : "";
    await term(line, kind, /goes next|rebuilt on the new trunk/.test(line) ? "second" : "");
    if (!touchingShown && /agent-8 is changing/.test(line)) {
      touchingShown = true;
      setTimeout(() => showTouching().catch((e) => console.error(e)), 1500);
    }
  }
});
swarm.stderr.on("data", (chunk) => process.stderr.write(chunk));
await new Promise((resolve) => swarm.on("close", resolve));
mark("swarm_done");
await sleep(2000);

// The resolved record, opened from the trunk line.
const records = await api("GET", "/records");
const resolved = records.find((r) => r.state === "merged");
if (resolved) {
  mark("record_view_open", { record: resolved.id });
  await click(`.from-record[data-record="${resolved.id}"]`);
  await sleep(26000);
  await click("[data-close]");
  mark("record_view_closed");
  await sleep(1500);
}

// The one human decision.
const escalated = records.find((r) => r.state === "escalated");
if (escalated) {
  // The inbox stays on screen while the narration explains the contradiction.
  await sleep(18000);
  mark("decision_click", { record: escalated.id });
  await click(`button[data-keep="incoming"][data-decide="${escalated.id}"]`);
  for (let i = 0; i < 60 && (await api("GET", `/records/${escalated.id}`)).state !== "merged"; i++) await sleep(1000);
  mark("decision_merged", { state: (await api("GET", `/records/${escalated.id}`)).state });
  await sleep(6000);
}

// Why does set flag look the way it does?
mark("why_query");
await term("GET /why?path=src/flags.js", "cmd", "why");
for (const m of await api("GET", "/why?path=src/flags.js")) {
  await term(`${m.agent}: ${m.goal}`, m.record ? "ok" : "", "why");
  if (m.record) await term(`  through #${m.record.id}: "${m.record.goal}" with "${m.record.clashingGoal}"`, "dim", "why");
}
await sleep(20000);

// One agent's view: start, push, check, submit, with real calls against the live system.
mark("agent_view_start");
await term("", "");
await term('POST /tasks {"goal": "document the burst limit", "agent": "agent-10"}', "cmd", "agent");
const task = await api("POST", "/tasks", { goal: "document the burst limit", agent: "agent-10" });
await term(`task ${task.taskId}, your fork: ${task.remote.split("/").pop()}`, "dim", "agent");
await sleep(1500);
const dir = join(mkdtempSync(join(tmpdir(), "spore-notes-")), "repo");
const git = (cwd, ...args) => execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${task.token}`, "-c", "user.name=agent-10", "-c", "user.email=agent-10@spore", ...args], { cwd, encoding: "utf8" }).trim();
await term("git clone <fork> && edit README.md", "cmd", "agent");
git(tmpdir(), "clone", "-q", task.remote, dir);
writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\nBursts are capped by `burst()` in src/limits.js.\n");
mkdirSync(join(dir, "test", "goals"), { recursive: true });
const goalTest = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\n\ntest("README documents the burst limit", () => {\n  assert.match(readFileSync(new URL("../../README.md", import.meta.url), "utf8"), /burst\\(\\)/);\n});\n`;
writeFileSync(join(dir, "test", "goals", `${task.taskId}.test.js`), goalTest);
await term(`cat test/goals/${task.taskId}.test.js`, "cmd", "goaltest");
for (const line of goalTest.trimEnd().split("\n")) await term(line, "dim", "goaltest");
await sleep(2500);
await term("git push", "cmd", "agent");
git(dir, "add", "-A");
git(dir, "commit", "-qm", "document the burst limit");
git(dir, "push", "-q", "origin", "main");
const sha = git(dir, "rev-parse", "HEAD");
await term(`pushed ${sha.slice(0, 7)}`, "dim", "agent");
mark("agent_view_pushed");
await term("GET /touching?path=README.md", "cmd", "agent");
for (let i = 0; i < 40 && (await api("GET", `/tasks/${task.taskId}`)).inflight?.sha !== sha; i++) await sleep(500);
const touching = await api("GET", "/touching?path=README.md");
for (const t of touching.inFlight) await term(`in flight  ${t.agent}: ${t.goal}`, t.agent === "agent-10" ? "" : "warn", "agent");
await term(touching.inFlight.length <= 1 ? "no one else is changing these lines" : "", "dim", "agent");
await sleep(1500);
await term(`POST /tasks/${task.taskId}/submit`, "cmd", "agent");
const result = await api("POST", `/tasks/${task.taskId}/submit`, { sha });
await term(result.status === "merged" ? `merged ${result.trunkSha.slice(0, 7)}` : JSON.stringify(result), result.status === "merged" ? "ok" : "warn", "agent");
mark("agent_view_end", { status: result.status });
await sleep(4000);

clearInterval(tracking);
const video = page.video();
await context.close();
await browser.close();
server.close();
renameSync(await video.path(), join(out, "run.webm"));
for (const f of readdirSync(out)) if (f.endsWith(".webm") && f !== "run.webm") rmSync(join(out, f));
writeFileSync(join(out, "events.json"), JSON.stringify(events, null, 2));
writeFileSync(join(out, "swarm.log"), swarmLog.join("\n") + "\n");
writeFileSync(join(out, "boxes.json"), JSON.stringify(boxes));
console.log(`wrote ${join(out, "run.webm")} and events.json`);
