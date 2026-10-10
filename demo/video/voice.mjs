// Generates narration with ElevenLabs from video/script.json: per scene, an mp3 and a JSON file of
// character start times in demo/video/out/voice/, which the composer uses to time cues to words.
// Usage: node demo/video/voice.mjs --voice <voice_id>           every scene
//        node demo/video/voice.mjs --voice <voice_id> --only <id,id,...>   just those scenes
//        node demo/video/voice.mjs --samples <id,id,...>        a short sample per voice in demo/video/out/samples/
// Reads ELEVENLABS_API_KEY from the environment or .dev.vars.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = "eleven_v4";
const key =
  process.env.ELEVENLABS_API_KEY ??
  readFileSync(join(here, "..", "..", ".dev.vars"), "utf8").match(/^ELEVENLABS_API_KEY=(.+)$/m)?.[1].trim();
if (!key) throw new Error("set ELEVENLABS_API_KEY in the environment or .dev.vars");

const script = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];

async function speak(voiceId, text, file, context = {}) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
      // Neighbouring text keeps intonation continuous across scene files.
      previous_text: context.previous,
      next_text: context.next,
    }),
  });
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
  const { audio_base64, alignment } = await response.json();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(audio_base64, "base64"));
  writeFileSync(file.replace(/\.mp3$/, ".json"), JSON.stringify({ text, characters: alignment.characters, starts: alignment.character_start_times_seconds }));
  console.log(`wrote ${file}`);
}

if (process.argv.includes("--samples")) {
  const text = `${script.find((s) => s.id === "open").narration} ${script.find((s) => s.id === "second").narration}`;
  for (const voiceId of arg("--samples").split(",")) await speak(voiceId, text, join(here, "out", "samples", `${voiceId}.mp3`));
} else if (process.argv.includes("--voice")) {
  const only = process.argv.includes("--only") ? arg("--only").split(",") : null;
  for (const [i, scene] of script.entries()) {
    if (only && !only.includes(scene.id)) continue;
    await speak(arg("--voice"), scene.narration, join(here, "out", "voice", `${String(i + 1).padStart(2, "0")}-${scene.id}.mp3`), {
      previous: script[i - 1]?.narration,
      next: script[i + 1]?.narration,
    });
  }
} else {
  throw new Error("pass --voice <voice_id> or --samples <id,id,...>");
}
