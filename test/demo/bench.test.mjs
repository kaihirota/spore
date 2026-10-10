import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTask, tasks, writeProject } from "../../demo/bench.mjs";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "spore-bench-test-"));
  writeProject(dir);
  return dir;
}

const passes = (dir) => {
  try {
    execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

describe("bench workload", () => {
  const queue = tasks(48, 1);

  it("gives the same tasks and work times for the same seed", () => {
    expect(tasks(48, 1).map((t) => [t.goal, t.workMs])).toEqual(queue.map((t) => [t.goal, t.workMs]));
  });

  it("starts from a project whose tests pass", () => {
    expect(passes(fresh())).toBe(true);
  });

  it("has every task pass its own goal test on the starting project", () => {
    const failing = queue.filter((task) => {
      const dir = fresh();
      return !applyTask(dir, task, "goal") || !passes(dir);
    });

    expect(failing.map((t) => t.goal)).toEqual([]);
  }, 60_000);

  it("can redo a registry task on a trunk that already has another handler", () => {
    const [a, b] = queue.filter((t) => t.goal.startsWith("register"));
    const dir = fresh();
    applyTask(dir, a, "a");

    expect(applyTask(dir, b, "b") && passes(dir)).toBe(true);
  });

  it("cannot hold both TIMEOUT goals at once", () => {
    const dir = fresh();
    for (const goal of ["set TIMEOUT to exactly 10", "set TIMEOUT to exactly 60"]) applyTask(dir, queue.find((t) => t.goal === goal), goal.slice(-2));

    expect(passes(dir)).toBe(false);
  });

  it("breaks the title goal once label lowercases, though the files differ", () => {
    const dir = fresh();
    applyTask(dir, queue.find((t) => t.goal.startsWith("end every title")), "title");
    applyTask(dir, queue.find((t) => t.goal.startsWith("make label")), "label");

    expect(passes(dir)).toBe(false);
  });
});
