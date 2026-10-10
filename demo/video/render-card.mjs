// Renders an animated card to video, frame by frame in step with its narration, so every cue lands on its word.
// Usage: node demo/video/render-card.mjs <scene id>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { sceneFile, spokenAt, spokenEnd, timings } from "./cues.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const script = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));

// Each card names its page and the cues to fire as phrases are spoken.
const SAMPLE_FLAGS = readFileSync(join(here, "..", "sample", "src", "flags.js"), "utf8").trimEnd().split("\n");
const lineOf = (text) => SAMPLE_FLAGS.findIndex((line) => line.includes(text)) + 1;

// The closing card sits over the finished dashboard, taken from the recording after the human decision.
function finishedDashboard() {
  const events = JSON.parse(readFileSync(join(here, "out", "recording", "events.json"), "utf8"));
  const at = events.find((e) => e.name === "decision_merged").t + 2;
  const shot = join(here, "out", "frames", "close-shot.png");
  mkdirSync(dirname(shot), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(at), "-i", join(here, "out", "recording", "run.webm"), "-frames:v", "1", shot]);
  return pathToFileURL(shot).href;
}

const CARDS = {
  close: {
    page: "close.html",
    hold: 2.5,
    cues: (t) => ({
      shot: finishedDashboard(),
      facts: [
        { n: "9", text: "agents on one codebase", color: "#1c2430", at: spokenAt(t, "Nine agents") },
        { n: "3", text: "warned about each other before submitting", color: "#8a5a00", at: spokenAt(t, "Three of them") },
        { n: "1", text: "chose to go next, after the others", color: "#1c2430", at: spokenAt(t, "One chose") },
        { n: "1", text: "handed its task to the agent in those lines", color: "#2f5fb3", at: spokenAt(t, "One handed") },
        { n: "1", text: "conflict resolved by the model", color: "#2f5fb3", at: spokenAt(t, "One conflict") },
        { n: "1", text: "contradiction settled by a person", color: "#c2412d", at: spokenAt(t, "One contradiction") },
        { n: "7", text: "clean changes merged in seconds", color: "#17724b", at: spokenAt(t, "Every clean change") },
      ],
      end: spokenAt(t, "The code is open source"),
      meta: "github.com/kaihirota/spore\nMIT license",
    }),
  },
  code: {
    page: "code.html",
    scene: "open",
    hold: 1,
    cues: (t) => ({
      lines: SAMPLE_FLAGS,
      marks: [
        { line: lineOf("flags[name] = value;"), at: spokenAt(t, "the same line"), color: "rgba(185, 122, 6, 0.18)", tag: "three agents", tagColor: "#8a5a00" },
        { line: lineOf("return Object.keys(flags);"), at: spokenAt(t, "A fourth"), color: "rgba(47, 95, 179, 0.12)", tag: "one agent", tagColor: "#2f5fb3" },
      ],
    }),
  },
  title: {
    page: "title.html",
    hold: 1,
    cues: (t) => ({
      spore: spokenAt(t, "Spore"),
      pr: spokenAt(t, "A pull request"),
      prStrike: spokenAt(t, "wait for a reviewer"),
      lock: spokenAt(t, "A lock"),
      lockStrike: spokenAt(t, "guess which files"),
      ideas: [spokenAt(t, "every task ships"), spokenAt(t, "Git decides"), spokenAt(t, "Agents hear"), spokenAt(t, "And when a conflict")],
    }),
  },
  results: {
    page: "results.html",
    hold: 1.5,
    cues: (t) => ({
      rows: [
        spokenAt(t, "Both ended"),
        spokenAt(t, "Under plain git"),
        spokenAt(t, "redid a hundred"),
        spokenAt(t, "and finished every task"),
        spokenAt(t, "Trunk settled"),
        spokenAt(t, "And when redoing"),
      ],
    }),
  },
  connect: {
    page: "connect.html",
    hold: 1.5,
    cues: (t) => ({ steps: [spokenAt(t, "npm run setup"), spokenAt(t, "Each agent gets"), spokenAt(t, "And Spore speaks MCP")] }),
  },
  architecture: {
    page: "architecture.html",
    hold: 1.5,
    cues: (t) => [
      { at: spokenAt(t, "Artifacts holds"), ids: ["b-forks", "b-trunk"] },
      { at: spokenAt(t, "Event subscriptions"), ids: ["b-forks", "e-event", "b-integrator"] },
      { at: spokenAt(t, "One Durable Object"), ids: ["b-integrator", "b-inflight", "b-queue", "b-resolver"] },
      { at: spokenAt(t, "Its Container"), ids: ["b-container", "e-serial"] },
      { at: spokenAt(t, "Workers AI"), ids: ["b-resolver", "e-model", "b-ai"] },
      { at: spokenAt(t, "a Worker serves"), ids: ["b-gateway", "e-http", "b-dashboard", "e-live"] },
      { at: spokenAt(t, "Agents never hold"), ids: ["b-container", "e-trunk", "b-trunk"] },
      { at: spokenAt(t, "Tests run as"), ids: ["b-container"] },
      { at: spokenEnd(t) + 0.6, ids: [] },
    ],
  },
};

const id = process.argv[2];
const card = CARDS[id];
if (!card) throw new Error(`no card for scene "${id}"; cards: ${Object.keys(CARDS).join(", ")}`);
const sceneId = card.scene ?? id;
const index = script.findIndex((s) => s.id === sceneId);
const t = timings(index, sceneId);
const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sceneFile(index, sceneId, "mp3")], { encoding: "utf8" })) + card.hold;

const frames = join(here, "out", "frames", id);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(join(here, "cards", card.page)).href);
await page.evaluate(() => document.fonts.ready);
await page.evaluate((cues) => (window.CUES = cues), card.cues(t));
const total = Math.ceil(duration * FPS);
for (let f = 0; f < total; f++) {
  await page.evaluate((time) => window.setTime(time), f / FPS);
  await page.screenshot({ path: join(frames, `${String(f).padStart(5, "0")}.png`) });
}
await browser.close();

const out = join(here, "out", "clips", `${String(index + 1).padStart(2, "0")}-${id}.mp4`);
mkdirSync(dirname(out), { recursive: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", out]);
console.log(`wrote ${out} (${total} frames, ${duration.toFixed(1)} s)`);
