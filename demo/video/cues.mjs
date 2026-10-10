// Times when phrases are spoken, from the character timings voice.mjs saves with each clip.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function sceneFile(index, id, ext) {
  return join(here, "out", "voice", `${String(index + 1).padStart(2, "0")}-${id}.${ext}`);
}

export function timings(index, id) {
  return JSON.parse(readFileSync(sceneFile(index, id, "json"), "utf8"));
}

/** Seconds into the clip at which `phrase` starts being spoken; the nth occurrence when it repeats. */
export function spokenAt(t, phrase, nth = 1) {
  const text = t.characters.join("");
  let at = -1;
  for (let i = 0; i < nth; i++) {
    at = text.indexOf(phrase, at + 1);
    if (at < 0) throw new Error(`"${phrase}" (occurrence ${nth}) is not in the narration`);
  }
  return t.starts[at];
}

/** Seconds at which the last character of the clip is spoken. */
export function spokenEnd(t) {
  return t.starts[t.starts.length - 1];
}
