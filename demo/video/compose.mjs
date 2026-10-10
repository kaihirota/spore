// Assembles the demo video: each scene is cut from the recording or a rendered card, fitted to its
// narration, captioned, and joined. Writes demo/video/out/spore-demo.mp4.
// Usage: node demo/video/compose.mjs   (after voice.mjs, render-card.mjs for each card, and record.mjs)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sceneFile, spokenAt, timings } from "./cues.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const work = join(out, "compose");
const FPS = 30;
// The recording is drawn at twice the 1920x1080 stage, so a zoom into a region stays sharp.
const SOURCE_SCALE = 2;
const ZOOM_EASE = 0.5;
const LEAD = 0.4;
const TAIL = 0.9;
const script = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));
const events = JSON.parse(readFileSync(join(out, "recording", "events.json"), "utf8"));
const RUN = join(out, "recording", "run.webm");
/** Seconds to add to the recorder's clock to get the video's: when the sync marker first shows, minus when it was set. */
function videoOffset() {
  const sync = events.find((e) => e.name === "sync");
  if (!sync) throw new Error("the recording has no sync marker; record it again");
  const fps = 50;
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-t", "8", "-i", RUN, "-vf", `fps=${fps},crop=20:20:20:20,scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  for (let i = 0; i + 2 < raw.length; i += 3) {
    if (raw[i] > 200 && raw[i + 1] < 80 && raw[i + 2] > 200) return i / 3 / fps - sync.t;
  }
  throw new Error("the sync marker is not in the first 8 s of the recording");
}
const OFFSET = videoOffset();
const BOXES = JSON.parse(readFileSync(join(out, "recording", "boxes.json"), "utf8")).map((b) => ({ ...b, t: b.t + OFFSET }));
const at = (name, offset = 0) => {
  const event = events.find((e) => e.name === name);
  if (!event) throw new Error(`the recording has no "${name}" event`);
  return event.t + OFFSET + offset;
};
const duration = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));
const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
const clip = (name) => join(out, "clips", name);
// A card's clip is numbered by the scene it belongs to.
const card = (sceneId, name = sceneId) => clip(`${String(script.findIndex((s) => s.id === sceneId) + 1).padStart(2, "0")}-${name}.mp4`);

// Footage for each scene: recording ranges fitted to a share of the scene, or card clips whose
// frames already follow the narration's clock. `until` ends a part at a phrase; the last part runs to the end.
const EDL = {
  open: (t) => [
    { run: [at("stage_ready"), at("first_push_seen", 4)], until: spokenAt(t, "Three of them") },
    { card: card("open", "code") },
  ],
  // The setFlag agents' clash must be on screen as the narration says the three learn of each other.
  touching: (t) => {
    const until = spokenAt(t, "each of the three learns") - 0.3;
    const warned = BOXES.find((b) => b.regions["cluster:setFlag"])?.t ?? at("first_warning");
    const start = Math.max(at("first_push_seen"), warned - 3 * (LEAD + until));
    return [
      { run: [start, warned], until },
      { run: [warned, at("touching_query", 7)] },
    ];
  },
  title: () => [{ card: card("title") }],
  "agent-view": () => [{ run: [at("agent_view_start", -0.5), at("agent_view_end", 2)] }],
  // The board holds still, on a frame with no card mid-glide, while the narration points at the agents.
  second: (t) => [
    { run: [stillBefore(at("goes_second", -2)) - 0.2, stillBefore(at("goes_second", -2))], until: spokenAt(t, "Agent eight decides") },
    { run: [at("goes_second", -2), at("rebuilt", 6)] },
  ],
  // The proposal stays on screen while the narration describes it; the cards merge as "agent two accepts" is said.
  handover: (t) => [
    // Both answers are on the cards by "So agent two"; the verdict follows.
    { run: [at("handover_suggested", -4), at("handed_over", 0.5)], until: spokenAt(t, "So agent two") },
    { run: [at("handed_over", 0.5), at("handed_over", 2)], until: spokenAt(t, "Agent two finishes") },
    // Fast through the wait, then hold on trunk with agent-9's task in it while the scene ends.
    // Start late enough that 3x reaches agent-2's merge of the handed task by the end of the narration.
    { run: [Math.max(at("handed_over", 2), at("handover_merged", 1.5) - 3 * (t.starts.at(-1) - spokenAt(t, "Agent two finishes"))), at("handover_merged", 1.5)], until: t.starts.at(-1) },
    { run: [at("handover_merged", 1.5), at("handover_merged", 1.7)] },
  ],
  merging: () => [{ run: [at("first_merge", -3), at("submits_done", 3)] }],
  resolver: (t) => [
    { run: [at("submits_done", -2), at("record_view_open", 1)], until: spokenAt(t, "Here is the record") - 0.6 },
    { run: [at("record_view_open", 1), at("record_view_closed", -0.5)] },
  ],
  escalation: (t) => [
    { run: [at("record_view_closed", 1), at("decision_click", -1.2)], until: spokenAt(t, "clicks once") - 1 },
    { run: [at("decision_click", -1.2), at("decision_merged", 5)] },
  ],
  why: () => [{ run: [at("why_query", -0.5), at("why_query", 19)] }],
  results: () => [{ card: card("results") }],
  connect: () => [{ card: card("connect") }],
  architecture: () => [{ card: card("architecture") }],
  close: () => [{ card: card("close") }],
};

// Silence inserted into a scene's narration before a phrase, so a dense screen can be read before the voice moves on.
// The narration's own [pause] tags let the voice breathe; entries here add exact silence on top where needed.
const PAUSES = {};

/**
 * The narration with its pauses: a new audio file, and word timings shifted to match. A pause goes only
 * between sentences, and is cut into the middle of the silence there, found in the audio itself.
 */
function withPauses(id, voice, t) {
  const text = t.characters.join("");
  const wanted = PAUSES[id] ?? [];
  if (wanted.length === 0) return { voice, t };
  // ffmpeg reports silences on stderr.
  const report = spawnSync("ffmpeg", ["-hide_banner", "-i", voice, "-af", "silencedetect=noise=-38dB:d=0.12", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const quiet = [...report.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  const pauses = wanted.map((p) => {
    const index = text.indexOf(p.before);
    if (index < 0 || !/[.?!]\s*$/.test(text.slice(0, index))) throw new Error(`${id}: a pause before "${p.before}" must follow the end of a sentence`);
    const word = t.starts[index];
    const gap = quiet.filter(([a, b]) => b > word - 0.8 && a < word + 0.2).sort((x, y) => Math.abs(x[1] - word) - Math.abs(y[1] - word))[0];
    if (!gap) throw new Error(`${id}: no silence found before "${p.before}"`);
    return { ...p, at: (gap[0] + gap[1]) / 2 };
  }).sort((a, b) => a.at - b.at);
  const cuts = [0, ...pauses.map((p) => p.at)];
  const filters = [];
  const parts = [];
  cuts.forEach((from, i) => {
    const to = cuts[i + 1];
    filters.push(`[0:a]atrim=start=${from.toFixed(3)}${to === undefined ? "" : `:end=${to.toFixed(3)}`},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[s${i}]`);
    parts.push(`[s${i}]`);
    if (to !== undefined) {
      filters.push(`aevalsrc=0:d=${pauses[i].seconds}:s=44100:c=stereo[z${i}]`);
      parts.push(`[z${i}]`);
    }
  });
  const padded = join(work, `${id}-paused.wav`);
  ff("-i", voice, "-filter_complex", `${filters.join(";")};${parts.join("")}concat=n=${parts.length}:v=0:a=1[out]`, "-map", "[out]", "-ar", "44100", "-ac", "2", padded);
  const shift = (time) => time + pauses.filter((p) => time >= p.at - 0.001).reduce((sum, p) => sum + p.seconds, 0);
  return { voice: padded, t: { ...t, starts: t.starts.map(shift) } };
}

// What the narration points at: from a phrase until the next cue (or `until`), spotlight a region of the screen.
const SPOTS = {
  touching: [
    { at: "each of the three learns", region: "cluster:setFlag", until: "Now look" },
    { at: "Now look at agent five", region: "agent:agent-5", until: "Spore watches" },
    { at: "Any agent can ask", region: "term:touching" },
  ],
  "agent-view": [
    { at: "Start a task", region: "term:agent", until: "Each agent also commits" },
    { at: "Each agent also commits", region: "term:goaltest" },
  ],
  second: [
    { at: "Back to agents", region: ["agent:agent-6", "agent:agent-7", "agent:agent-8"], until: "A warning is advice" },
    { at: "Two of them keep going", region: ["agent:agent-6", "agent:agent-7"], until: "Agent eight decides" },
    { at: "Agent eight decides", region: "term:second" },
  ],
  handover: [
    { at: "Agent nine starts late", region: "agent:agent-9", until: "The coordinator asks them both" },
    { at: "The coordinator asks them both", region: ["agent:agent-9", "agent:agent-2"], until: "So agent two" },
    { at: "So agent two", region: "agent:agent-2", until: "Agent two finishes" },
    { at: "Agent two finishes", region: "trunk" },
  ],
  merging: [
    { at: "A clean change reaches trunk", region: "trunk", until: "A change that clashes" },
    { at: "It becomes a record in the queue", region: "queue", until: "Trunk is never" },
  ],
  resolver: [
    { at: "Who clears the queue", region: "queue", until: "Here is the record" },
    { at: "Here is the record", region: "dialog", until: "Left, what trunk" },
    { at: "Left, what trunk", region: "pane:trunk", until: "Middle" },
    { at: "Middle, the incoming", region: "pane:incoming", until: "Right, the fix" },
    { at: "Right, the fix", region: "pane:fix", until: "The fix goes through" },
  ],
  escalation: [
    { at: "Then two goals", region: "decision", until: "clicks once" },
    { at: "clicks once", region: "take", until: "The losing" },
  ],
  why: [{ at: "It asks", region: "term:why" }],
};

// A list of regions is spotlit together: the zoom frames the box around all of them, and each gets its own ring.
function regionBoxes(regions, names) {
  const parts = [names].flat().map((name) => regions[name]).filter(Boolean);
  if (parts.length === 0) return null;
  const left = Math.min(...parts.map((r) => r[0]));
  const top = Math.min(...parts.map((r) => r[1]));
  return { box: [left, top, Math.max(...parts.map((r) => r[0] + r[2])) - left, Math.max(...parts.map((r) => r[1] + r[3])) - top], parts };
}

/** Each position the region holds over source times [from, to], as [{ t, box }], starting from where it is at `from`. */
function boxesOver(region, from, to) {
  const nearest = BOXES.reduce((a, b) => (Math.abs(b.t - from) < Math.abs(a.t - from) ? b : a));
  const steps = [];
  for (const b of [nearest, ...BOXES.filter((b) => b.t > from && b.t <= to)]) {
    const found = regionBoxes(b.regions, region);
    if (!found) continue;
    const last = steps.at(-1);
    if (last && found.box.every((v, k) => Math.abs(v - last.box[k]) < 4)) continue;
    steps.push({ t: Math.max(b.t, from), ...found });
  }
  // A position held for under half a second is a card or log line passing through; follow where it settles.
  return steps.filter((step, k) => k === steps.length - 1 || steps[k + 1].t - step.t >= 0.5);
}

/** The 16:9 view, in stage pixels, that frames a box with room around it; never closer than 2x. */
// The bottom 13% of the frame belongs to captions, so a framed region sits in the space above them. Below the
// stage the recording is extended in the colour of the dimmed board, so a region at its bottom edge can still clear them.
const CAPTION_BAND = 0.13;
const BELOW = 160;
// The canvas grows in both directions so it stays 16:9: the full view still shows exactly the stage, undistorted.
const CANVAS = (1080 + BELOW) / 1080;
const [CANVAS_W, CANVAS_H] = [1920, 1080].map((v) => Math.round((v * SOURCE_SCALE * CANVAS) / 2) * 2);

function viewFor([x, y, w, h]) {
  const pad = 40;
  let vw = Math.max(w + 2 * pad, ((h + 2 * pad) / (1 - CAPTION_BAND)) * 16 / 9, 960);
  if (vw * 9 / 16 > 1080) vw = 1920;
  vw = Math.min(vw, 1920);
  const vh = vw * 9 / 16;
  const above = vh * (1 - CAPTION_BAND);
  const vx = Math.min(Math.max(0, x + w / 2 - vw / 2), 1920 - vw);
  // Centred on the region within the stage; moved down only when the region would sit under the captions,
  // and never for a frame that shows the whole stage.
  let vy = Math.min(Math.max(0, y + h / 2 - vh / 2), 1080 - vh);
  if (vw < 1920 && y + h + pad > vy + above) vy = Math.min(y + h + pad - above, 1080 + BELOW - vh);
  return [vx, vy, vw];
}

const FULL = [0, 0, 1920];

/** zoompan expressions that ease between views: [{ t, view }] keyframes, held between them. */
function zoomExpressions(keys) {
  const piece = (k) => {
    let expr = String(keys.at(-1).view[k]);
    for (let i = keys.length - 2; i >= 0; i--) {
      const [a, b] = [keys[i], keys[i + 1]];
      const u = `clip((it-${a.t.toFixed(3)})/${Math.max(0.001, b.t - a.t).toFixed(3)},0,1)`;
      const smooth = `(${u}*${u}*(3-2*${u}))`;
      expr = `if(lt(it,${b.t.toFixed(3)}),${a.view[k].toFixed(2)}+(${(b.view[k] - a.view[k]).toFixed(2)})*${smooth},${expr})`;
    }
    return expr;
  };
  const [vx, vy, vw] = [piece(0), piece(1), piece(2)];
  return `zoompan=z='${(1920 * CANVAS).toFixed(4)}/(${vw})':x='(${vx})*${SOURCE_SCALE}':y='(${vy})*${SOURCE_SCALE}':d=1:s=1920x1080:fps=${FPS}`;
}

/** Keyframes for a scene's spotlights: ease into each view as it starts, back out when nothing follows soon. */
function zoomKeys(spots) {
  const keys = [{ t: 0, view: FULL }];
  spots.forEach((spot, i) => {
    const last = keys.at(-1);
    if (spot.from > last.t) keys.push({ t: spot.from, view: last.view });
    // Within one cue the view follows the region in step with the card, so the ring and the view stay together.
    const ease = spot.first ? ZOOM_EASE : 0.35;
    keys.push({ t: Math.min(spot.from + ease, spot.to), view: spot.view });
    keys.push({ t: spot.to, view: spot.view });
    const next = spots[i + 1];
    if (!next || next.from > spot.to + ZOOM_EASE) keys.push({ t: spot.to + ZOOM_EASE, view: FULL });
  });
  return keys.filter((k, i) => i === 0 || k.t > keys[i - 1].t);
}

/**
 * The latest moment at or before t when no card has moved for 0.6 s before it or 0.6 s after. A change in a
 * card's position starts a 0.45 s glide on the board, and a frame taken during it shows text outside its card;
 * the margin after covers the recording lagging behind the logged positions.
 */
function stillBefore(t) {
  const cards = (b) => JSON.stringify(Object.entries(b.regions).filter(([name]) => name.startsWith("agent:")));
  for (let at = t; at > t - 10; at -= 0.1) {
    const window = BOXES.filter((b) => b.t > at - 0.6 && b.t <= at + 0.6);
    if (window.length > 1 && window.every((b) => cards(b) === cards(window[0]))) return at;
  }
  return t;
}

/** Cuts [from, to] of the recording to exactly `length` seconds: speeds up to 3x, slows to 0.6x, then holds the last frame. */
function fitRun(file, [from, to], length) {
  const source = to - from;
  const speed = Math.min(3, Math.max(0.6, source / length));
  const used = Math.min(source, length * speed);
  const played = used / speed;
  const hold = Math.max(0, length - played);
  ff("-ss", from.toFixed(3), "-t", used.toFixed(3), "-i", RUN, "-an",
    "-vf", `setpts=PTS/${speed.toFixed(4)},fps=${FPS},tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},trim=duration=${length.toFixed(3)}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-crf", "16", file);
  return { speed, played };
}

/** Takes the card clip from narration time `from` for `length` seconds, holding its first frame for the lead-in. */
function fitCard(file, card, from, length, lead) {
  ff("-ss", Math.max(0, from).toFixed(3), "-i", card, "-an",
    "-vf", `fps=${FPS},scale=${1920 * SOURCE_SCALE}:${1080 * SOURCE_SCALE}:flags=lanczos,tpad=start_mode=clone:start_duration=${lead.toFixed(3)}:stop_mode=clone:stop_duration=30,trim=duration=${length.toFixed(3)}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-crf", "16", file);
}

// Captions write names the way the screen shows them: setFlag, agent-6, and "agents 6, 7 and 8".
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const WORD = Object.keys(NUMBERS).join("|");
function onScreenNames(text) {
  return text
    .replace(/\[[^\]]*\]\s*/g, "")
    .replaceAll("set flag", "setFlag")
    .replace(new RegExp(`\\bagents ((?:${WORD})(?:, (?:${WORD}))* and (?:${WORD}))\\b`, "gi"), (_, list) => `agents ${list.replace(new RegExp(WORD, "gi"), (w) => NUMBERS[w.toLowerCase()])}`)
    .replace(new RegExp(`\\b([Aa])gent (${WORD})\\b`, "g"), (_, a, w) => `${a}gent-${NUMBERS[w.toLowerCase()]}`);
}

// Caption phrases: split at sentence ends and at commas, then halve any phrase still too long to read
// at a glance at the space nearest its middle.
function phrases(t) {
  const chars = t.characters;
  const spans = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    const atBreak = (chars[i + 1] ?? " ") === " ";
    const words = chars.slice(start, i + 1).join("").trim().split(/\s+/).length;
    if ((atBreak && (/[.?!]/.test(chars[i]) || (/[,:]/.test(chars[i]) && words >= 5))) || i === chars.length - 1) {
      spans.push([start, i + 1]);
      start = i + 1;
    }
  }
  // "set flag" is shown as setFlag, so it is never broken across two captions.
  const text = chars.join("");
  const unbreakable = new Set([...text.matchAll(/set flag/g)].map((m) => m.index + 3));
  // Nor is an agent's name, or a list of them, split from its number.
  for (const m of text.matchAll(new RegExp(`\\bagents? (?:${WORD})(?:(?:, | and )(?:${WORD}))*`, "gi"))) {
    for (let i = m.index; i < m.index + m[0].length; i++) if (text[i] === " ") unbreakable.add(i);
  }
  const halve = ([a, b]) => {
    if (chars.slice(a, b).join("").trim().split(/\s+/).length <= 12) return [[a, b]];
    const middle = (a + b) / 2;
    let cut = -1;
    for (let i = a + 1; i < b - 1; i++) if (chars[i] === " " && !unbreakable.has(i) && (cut < 0 || Math.abs(i - middle) < Math.abs(cut - middle))) cut = i;
    return cut < 0 ? [[a, b]] : [...halve([a, cut]), ...halve([cut + 1, b])];
  };
  const list = spans
    .flatMap(halve)
    // A caption starts at its first letter, not the space before it, which can sit before an inserted pause.
    .map(([a, b]) => {
      // Skip leading spaces and audio tags such as [pause], which are directions to the voice, not words.
      let first = a;
      for (;;) {
        while (first < b && chars[first] === " ") first++;
        if (chars[first] !== "[") break;
        while (first < b && chars[first] !== "]") first++;
        first++;
      }
      return { text: onScreenNames(chars.slice(a, b).join("").trim()), from: t.starts[first] };
    })
    .filter((p) => p.text);
  return list.map((p, i) => ({ ...p, to: list[i + 1]?.from ?? t.starts[chars.length - 1] + 0.6 }));
}

// Footage played noticeably faster than real time carries a badge with its actual speed.
const SHOW_BADGE = 1.25;
const badgeLabel = (speed) => `${speed.toFixed(1)}×`;
const badgeFile = (speed) => join(work, `badge-${speed.toFixed(1)}x.png`);

// Spotlights are drawn on the full-size recording, before the zoom, so a ring stays on its card while the view glides.
async function renderSpotlights(spots) {
  const browser = await chromium.launch();
  const [W, H] = [1920 * SOURCE_SCALE, 1080 * SOURCE_SCALE];
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  for (const spot of spots) {
    // Rings on several cards hug them, so neighbouring cards' rings do not overlap.
    const pad = (spot.parts?.length > 1 ? 2 : 10) * SOURCE_SCALE;
    const rings = (spot.parts ?? [spot.box]).map((stage) => {
      const [x, y, w, h] = stage.map((v) => v * SOURCE_SCALE);
      return { x: Math.max(8, x - pad), y: Math.max(8, y - pad), w: Math.min(W - 16, w + 2 * pad), h: h + 2 * pad };
    });
    const shape = (r, extra) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${10 * SOURCE_SCALE}" ${extra}/>`;
    await page.setContent(`<html><body style="margin:0;background:transparent"><svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><mask id="m"><rect width="${W}" height="${H}" fill="white"/>${rings.map((r) => shape(r, 'fill="black"')).join("")}</mask></defs>
      <rect width="${W}" height="${H}" fill="rgba(18,24,33,0.42)" mask="url(#m)"/>
      ${rings.map((r) => shape(r, `fill="none" stroke="#2f5fb3" stroke-width="${3 * SOURCE_SCALE}"`)).join("")}</svg></body></html>`);
    await page.screenshot({ path: spot.png, omitBackground: true });
  }
  await browser.close();
}

async function renderCaptions(scenes, badges) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 140 } });
  await page.setContent(`<html><head><link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600&display=swap" rel="stylesheet">
    <style>html,body{margin:0;background:transparent}div{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);max-width:1500px;
    padding:12px 26px;border-radius:10px;background:rgba(28,36,48,.86);color:#fff;font:500 34px/1.3 Archivo,sans-serif;text-align:center}</style></head>
    <body><div id="c"></div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  for (const scene of scenes) {
    for (const [i, p] of scene.phrases.entries()) {
      await page.evaluate((text) => (document.getElementById("c").textContent = text), p.text);
      p.png = join(work, `${scene.n}-caption-${String(i).padStart(2, "0")}.png`);
      await page.screenshot({ path: p.png, omitBackground: true });
    }
  }
  await page.evaluate(() => (document.getElementById("c").textContent = ""));
  await page.setContent(`<html><head><link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700&display=swap" rel="stylesheet">
    <style>html,body{margin:0;background:transparent}div{position:absolute;right:24px;top:24px;padding:8px 18px;border-radius:8px;background:rgba(28,36,48,.8);color:#fff;font:700 30px Archivo,sans-serif}</style></head>
    <body><div id="b"></div></body></html>`);
  await page.setViewportSize({ width: 200, height: 100 });
  await page.evaluate(() => document.fonts.ready);
  for (const speed of badges) {
    await page.evaluate((text) => (document.getElementById("b").textContent = text), badgeLabel(speed));
    await page.screenshot({ path: badgeFile(speed), omitBackground: true });
  }
  await browser.close();
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const scenes = script.map((scene, index) => {
  const { voice, t } = withPauses(scene.id, sceneFile(index, scene.id, "mp3"), timings(index, scene.id));
  return { ...scene, n: String(index + 1).padStart(2, "0"), t, voice, length: LEAD + duration(voice) + TAIL, phrases: phrases(t) };
});
console.log(`video runs ${OFFSET.toFixed(2)} s from the recorder's clock`);
const fitted = [];
for (const scene of scenes) {
  const edl = EDL[scene.id](scene.t);
  let cursor = 0;
  const pieces = [];
  edl.forEach((part, i) => {
    const end = i === edl.length - 1 ? scene.length : LEAD + part.until;
    const length = end - cursor;
    const file = join(work, `${scene.n}-part${i}.mp4`);
    if (part.card) fitCard(file, part.card, cursor - LEAD, length, Math.max(0, LEAD - cursor));
    else pieces.push({ file, ...fitRun(file, part.run, length), run: part.run, from: cursor, to: end });
    if (part.card) pieces.push({ file, speed: 1, from: cursor, to: end });
    cursor = end;
  });
  const list = join(work, `${scene.n}-parts.txt`);
  writeFileSync(list, pieces.map((p) => `file '${p.file}'`).join("\n") + "\n");
  const silent = join(work, `${scene.n}-video.mp4`);
  ff("-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent);
  fitted.push({ scene, pieces, silent });
}

// Each spotlight runs from its phrase to the next cue, placed where its region was at that moment in the footage.
for (const f of fitted) {
  const cues = SPOTS[f.scene.id] ?? [];
  f.spots = [];
  cues.forEach((cue, i) => {
    const from = LEAD + spokenAt(f.scene.t, cue.at);
    const next = cue.until ? LEAD + spokenAt(f.scene.t, cue.until) : cues[i + 1] ? LEAD + spokenAt(f.scene.t, cues[i + 1].at) : f.scene.length - 0.4;
    const to = Math.min(next, f.scene.length - 0.2);
    const piece = f.pieces.find((p) => p.run && from >= p.from && from < p.to);
    if (!piece) return console.warn(`${f.scene.id}: no footage under "${cue.at}"`);
    const sourceAt = (x) => piece.run[0] + Math.min(Math.max(0, x - piece.from), piece.played) * piece.speed;
    const source = sourceAt(from);
    const steps = boxesOver(cue.region, source, sourceAt(to))
      .map((step) => ({ ...step, at: Math.max(from, piece.from + (step.t - piece.run[0]) / piece.speed) }))
      .filter((step, k, all) => k === all.length - 1 || all[k + 1].at - step.at >= 0.3);
    if (!steps.length) return console.warn(`${f.scene.id}: "${cue.region}" not on screen at ${source.toFixed(1)} s`);
    // One camera frame for the whole cue, covering every place the region goes, so the camera holds still
    // while a moving card's ring follows it inside the frame.
    const left = Math.min(...steps.map((st) => st.box[0]));
    const top = Math.min(...steps.map((st) => st.box[1]));
    const view = viewFor([left, top, Math.max(...steps.map((st) => st.box[0] + st.box[2])) - left, Math.max(...steps.map((st) => st.box[1] + st.box[3])) - top]);
    steps.forEach((step, k) => f.spots.push({
      from: k ? step.at : from, to: k < steps.length - 1 ? steps[k + 1].at : to, box: step.box, parts: step.parts, view,
      first: k === 0, last: k === steps.length - 1, png: join(work, `${f.scene.n}-spot-${i}-${k}.png`),
    }));
  });
}
await renderSpotlights(fitted.flatMap((f) => f.spots));

const fast = fitted.flatMap((f) => f.pieces).filter((p) => p.speed >= SHOW_BADGE);
await renderCaptions(scenes, [...new Set(fast.map((p) => Number(p.speed.toFixed(1))))]);

const parts = [];
for (const { scene, pieces, silent, spots } of fitted) {
  // Spotlights, then captions and speed badges over the footage, then the narration under it.
  const inputs = ["-i", silent, "-i", scene.voice];
  const overlays = [];
  let label = "[0:v]";
  let n = 2;
  // A cue's spotlight fades in and out once; between its positions the ring moves with its card.
  for (const spot of spots) {
    inputs.push("-loop", "1", "-t", scene.length.toFixed(3), "-i", spot.png);
    const faded = `[f${n}]`;
    const next = `[v${n}]`;
    const fades = [
      spot.first && `fade=t=in:st=${spot.from.toFixed(3)}:d=0.3:alpha=1`,
      spot.last && `fade=t=out:st=${Math.max(spot.from, spot.to - 0.3).toFixed(3)}:d=0.3:alpha=1`,
    ].filter(Boolean);
    overlays.push(`[${n}:v]${["format=rgba", ...fades].join(",")}${faded}`);
    overlays.push(`${label}${faded}overlay=0:0:shortest=1:enable='between(t,${spot.from.toFixed(3)},${spot.to.toFixed(3)})'${next}`);
    label = next;
    n++;
  }
  overlays.push(`${label}pad=${CANVAS_W}:${CANVAS_H}:0:0:color=#92959a,${zoomExpressions(zoomKeys(spots))},format=yuv420p[zoomed]`);
  label = "[zoomed]";
  for (const p of scene.phrases) {
    inputs.push("-i", p.png);
    const next = `[v${n}]`;
    overlays.push(`${label}[${n}:v]overlay=0:H-h:enable='between(t,${(LEAD + p.from).toFixed(3)},${(LEAD + p.to).toFixed(3)})'${next}`);
    label = next;
    n++;
  }
  for (const piece of pieces.filter((p) => p.speed >= SHOW_BADGE)) {
    inputs.push("-i", badgeFile(piece.speed));
    const next = `[v${n}]`;
    overlays.push(`${label}[${n}:v]overlay=W-w:0:enable='between(t,${piece.from.toFixed(3)},${piece.to.toFixed(3)})'${next}`);
    label = next;
    n++;
  }
  const audio = `[1:a]adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad,atrim=duration=${scene.length.toFixed(3)}[a]`;
  const scenePath = join(work, `${scene.n}-${scene.id}.mp4`);
  ff(...inputs, "-filter_complex", [...overlays, audio].join(";"), "-map", label, "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-ar", "44100", scenePath);
  parts.push(scenePath);
  console.log(`${scene.n} ${scene.id.padEnd(13)} ${scene.length.toFixed(1)} s, footage at ${pieces.map((p) => `${p.speed.toFixed(2)}x`).join(" + ")}`);
}

const list = join(work, "scenes.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n") + "\n");
const joined = join(work, "joined.mp4");
ff("-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined);
const final = join(out, "spore-demo.mp4");
ff("-i", joined, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", final);
console.log(`wrote ${final} (${duration(final).toFixed(1)} s)`);
