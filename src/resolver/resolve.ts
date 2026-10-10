export type ChatMessage = { role: "system" | "user"; content: string };
export type Resolution = { content: string } | { escalate: string };

const SYSTEM = `You resolve git merge conflicts. Two changes with different goals edited the same lines of one file.
Return the complete file with every conflict resolved so that both goals are met. Keep everything outside the conflicts unchanged.
Output only the file content: no explanation and no code fences.
If the two goals cannot both be met, output exactly one line: ESCALATE: <short reason>.`;

export function buildResolvePrompt(input: { path: string; content: string; trunkGoal: string; incomingGoal: string }): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        `File: ${input.path}`,
        `Goal of the change already in trunk (the HEAD side): ${input.trunkGoal}`,
        `Goal of the incoming change (the other side): ${input.incomingGoal}`,
        "",
        "File with conflict markers (diff3 style, the ||||||| section is the common ancestor):",
        input.content,
      ].join("\n"),
    },
  ];
}

export function parseResolution(reply: string): Resolution {
  const trimmed = reply.trim();
  const fenced = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  const text = fenced ? fenced[1] : trimmed;
  const escalation = text.trimStart().match(/^ESCALATE:\s*(.+)$/m);
  if (escalation && text.trimStart().startsWith("ESCALATE:")) return { escalate: escalation[1].trim() };

  const content = `${text.trimEnd()}\n`;
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(content)) return { escalate: "model left conflict markers in the file" };
  return { content };
}

/** Asks whether one change could satisfy both goals, before either agent submits. */
export function buildJudgePrompt(goalA: string, goalB: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Two coding agents are changing the same lines of a codebase. Decide whether any single implementation could satisfy both of their goals. " +
        "Goals that add different behaviour to the same code are compatible. Goals that demand different values or opposite behaviour for the same thing contradict. " +
        "Answer with exactly one line: COMPATIBLE, or CONTRADICT: <one short reason>.",
    },
    { role: "user", content: `Goal A: ${goalA}\nGoal B: ${goalB}` },
  ];
}

// Anything but a clear CONTRADICT counts as compatible: the resolver and the goal tests remain the check.
export function parseJudgement(reply: string): { contradicts: boolean; reason: string } {
  const match = reply.trim().match(/^CONTRADICT:\s*(.+)/i);
  return match ? { contradicts: true, reason: match[1].trim().split("\n")[0] } : { contradicts: false, reason: "" };
}
