import { describe, expect, it } from "vitest";
import { buildJudgePrompt, buildResolvePrompt, parseJudgement, parseResolution } from "../../src/resolver/resolve";

describe("buildResolvePrompt", () => {
  it("puts both goals and the conflicted file in the user message", () => {
    const messages = buildResolvePrompt({
      path: "src/flags.js",
      content: "<<<<<<< HEAD\nreturn 200;\n=======\nreturn 50;\n>>>>>>> abc\n",
      trunkGoal: "raise the rate limit",
      incomingGoal: "add audit logging",
    });

    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("src/flags.js");
    expect(messages[1].content).toContain("raise the rate limit");
    expect(messages[1].content).toContain("add audit logging");
    expect(messages[1].content).toContain("<<<<<<< HEAD");
  });
});

describe("parseResolution", () => {
  it("returns the file content", () => {
    expect(parseResolution("const a = 1;\n")).toEqual({ content: "const a = 1;\n" });
  });

  it("keeps the first line's indentation inside a code fence", () => {
    expect(parseResolution("```\n  indented();\n```")).toEqual({ content: "  indented();\n" });
  });

  it("strips a surrounding code fence", () => {
    expect(parseResolution("```js\nconst a = 1;\n```")).toEqual({ content: "const a = 1;\n" });
  });

  it("reports an escalation with its reason", () => {
    expect(parseResolution("ESCALATE: one goal raises the limit, the other lowers it")).toEqual({
      escalate: "one goal raises the limit, the other lowers it",
    });
  });

  it("treats an escalation followed by an explanation as an escalation", () => {
    expect(parseResolution("ESCALATE: limits contradict\nOne change raises it and the other lowers it.")).toEqual({
      escalate: "limits contradict",
    });
  });

  it("treats an escalation inside a code fence as an escalation", () => {
    expect(parseResolution("```\nESCALATE: limits contradict\n```")).toEqual({ escalate: "limits contradict" });
  });

  it("escalates when conflict markers remain", () => {
    expect(parseResolution("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n")).toEqual({
      escalate: "model left conflict markers in the file",
    });
  });
});

describe("buildJudgePrompt", () => {
  it("asks about both goals", () => {
    const messages = buildJudgePrompt("set the rate limit to exactly 200", "set the rate limit to exactly 50");

    expect(messages[1].content).toContain("set the rate limit to exactly 200");
    expect(messages[1].content).toContain("set the rate limit to exactly 50");
  });
});

describe("parseJudgement", () => {
  it("reads a contradiction and its reason", () => {
    expect(parseJudgement("CONTRADICT: the limit cannot be both 200 and 50")).toEqual({ contradicts: true, reason: "the limit cannot be both 200 and 50" });
  });

  it("reads compatible goals", () => {
    expect(parseJudgement("COMPATIBLE")).toEqual({ contradicts: false, reason: "" });
  });

  it("treats an unclear answer as compatible, so the resolver still gets its chance", () => {
    expect(parseJudgement("It depends on the implementation.")).toEqual({ contradicts: false, reason: "" });
  });
});
