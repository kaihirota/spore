// Checks a recorded take against what the narration says happened. Exits non-zero if it does not fit.
// Usage: node demo/video/check-take.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const log = readFileSync(join(here, "out", "recording", "swarm.log"), "utf8").split("\n");
const trio = ["agent-6", "agent-7", "agent-8"];
const problems = [];

// Each setFlag agent hears about the other two before it submits. A report's indented warnings belong
// to the agent named on the "is changing" line above them; later ones read "<agent> now warned".
const heard = new Map(trio.map((a) => [a, new Set()]));
const submitted = new Set();
let current = null;
for (const line of log) {
  const changing = line.match(/^(agent-[\w-]+) is changing/);
  if (changing) current = changing[1];
  const done = line.match(/^(agent-[\w-]+) (merged|queued)/);
  if (done) submitted.add(done[1]);
  const later = line.match(/^(agent-[\w-]+) now warned: (agent-[\w-]+)/);
  const first = line.match(/^\s*warned: (agent-[\w-]+)/);
  const [agent, other] = later ? [later[1], later[2]] : first ? [current, first[1]] : [];
  if (agent && heard.has(agent) && !submitted.has(agent)) heard.get(agent).add(other);
}
for (const agent of trio) {
  const others = trio.filter((a) => a !== agent && heard.get(agent).has(a));
  if (others.length < 2) problems.push(`${agent} heard about ${others.join(", ") || "no one"} before submitting`);
}
if (!log.some((l) => /^agent-8 goes next, after (agent-7 and agent-6|agent-6 and agent-7)$/.test(l))) problems.push("agent-8 did not go next after both other setFlag agents");
if (!log.some((l) => /^7 merged, 2 queued, 0 failed$/.test(l))) problems.push("the swarm did not end with 7 merged and 2 queued");
// The narration names who clashed with whom, so the right changes must be the ones queued.
for (const [agent, outcome] of [["agent-3", "merged"], ["agent-4", "queued"], ["agent-6", "merged"], ["agent-7", "queued"]]) {
  if (!log.some((l) => l.startsWith(`${agent} ${outcome}`))) problems.push(`${agent} was not ${outcome}`);
}
const step = (pattern) => log.findIndex((l) => pattern.test(l));
// The coordinator asks both, both answer required, agent-9's task goes to agent-2, which picks it up and merges it.
const [asked, nineAnswers, twoAnswers, handed, pickedUp] = [/^coordinator asks agent-9 whether/, /^agent-9 answers: required/, /^agent-2 answers: required/, /^agent-9 hands ".*" to agent-2/, /^agent-2 picks up ".*" from agent-9/].map(step);
const handedMerged = log.findIndex((l, i) => i > pickedUp && l.startsWith("agent-2 merged"));
const inOrder = asked >= 0 && nineAnswers > asked && twoAnswers > asked && handed > Math.max(nineAnswers, twoAnswers) && pickedUp > handed && handedMerged > pickedUp;
if (!inOrder) problems.push("the coordinator did not ask both agents, hand agent-9's task to agent-2, and see agent-2 merge it");
if (!log.some((l) => /": escalated/.test(l)) || !log.some((l) => /^#\d+ ".*": merged$/.test(l))) problems.push("expected one escalated and one resolved record");
// The narration says the coordinator flagged the contradiction early, so the record went straight to a person.
if (!log.some((l) => /": escalated \(contradicts agent-3/.test(l))) problems.push("the rate-limit record was not sent to a person as a contradiction");

if (problems.length) {
  console.log(`take does not fit the narration:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("take fits the narration");
