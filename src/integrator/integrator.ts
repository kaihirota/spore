import type { Change } from "./inflight";
import type { MergeResult } from "../git/merge";
import type { HandoverResult } from "../git/handover";

export type Row = Record<string, unknown>;
export type Sql = (query: string, ...params: unknown[]) => Row[];
export type MergeFn = (req: {
  forkRepo: string;
  forkUrl: string;
  forkSha: string;
  message: string;
  trailers: Record<string, string>;
  prefer?: "theirs";
  dropPaths?: string[];
}) => Promise<MergeResult>;

/** Reads an agent's latest pushed commit and test-merges commits against each other. */
export type Watcher = {
  /** What a pushed commit changes, and when it was committed (ms); the integrator's clock stands in when absent. */
  inspect: (req: { taskId: string; forkRepo: string; forkUrl: string; forkSha: string }) => Promise<{ changes: Change[]; committedAt?: number }>;
  conflicts: (sha: string, others: { id: string; sha: string }[]) => Promise<{ id: string; files: string[] }[]>;
  /** Trunk tasks whose merged changes the commit already conflicts with. */
  trunkClashes: (sha: string) => Promise<string[]>;
};

const noWatcher: Watcher = {
  inspect: async () => {
    throw new Error("in-flight tracking is not configured");
  },
  conflicts: async () => [],
  trunkClashes: async () => [],
};

export type InflightTask = {
  taskId: string;
  agent: string;
  goal: string;
  sha: string;
  changes: Change[];
  at: number;
  committedAt: number;
  conflictsWith: string[];
  conflictsWithTrunk: string[];
};

export type SubmitResult =
  | { status: "merged"; trunkSha: string }
  | { status: "queued"; record: number }
  | { status: "already_in_trunk"; trunkSha: string };

export type TaskSummary = {
  id: string;
  goal: string;
  agent: string;
  state: "active" | "submitted" | "merged" | "queued" | "resolved" | "escalated" | "dismissed" | "failed" | "handed_off";
  record: number | null;
  /** For a resolver's own task, the record it is fixing. */
  resolves: number | null;
  /** When the task was started, in ms. */
  startedAt: number;
  /** The agent that handed this task over to its current one. */
  handedFrom: string | null;
  /** Another task this one clashes with whose goal it contradicts, so a person will settle them. */
  contradiction: { with: string; agent: string; reason: string } | null;
  /** The coordinator's question: is this task's change to `about` required for it? */
  question: { group: string; about: string; askedAt: number; answer: { required: boolean; reason: string } | null } | null;
  /** What the coordinator decided once every agent in the clash answered. */
  verdict: { decision: "continue" | "drop" | "handover"; to: string | null; reason: string; state: "pending" | "done" | "refused" } | null;
};

/**
 * Container work the coordinator's verdicts need. Each runs the tests without the task's own goal test,
 * which is unfinished by definition, and is refused if they fail.
 */
export type Handovers = {
  /** Removes the task's changes in the named functions (or files) from its branch and pushes the result. */
  drop: (req: { taskId: string; forkRepo: string; forkUrl: string; forkSha: string; files: string[]; symbols: string[]; goalTest: string }) => Promise<HandoverResult>;
  /** Squashes the task's work onto trunk as one commit and pushes it to the task's fork, ready to hand over. */
  flatten: (req: { taskId: string; goal: string; forkRepo: string; forkUrl: string; forkSha: string; goalTest: string }) => Promise<HandoverResult>;
};

const noHandovers: Handovers = {
  drop: async () => ({ status: "refused", reason: "handovers are not configured" }),
  flatten: async () => ({ status: "refused", reason: "handovers are not configured" }),
};

/** A request the integrator refuses because of who sent it or what state it targets. */
export class Rejected extends Error {
  override name = "Rejected";
}

export type ConflictRecord = {
  id: number;
  kind: "merge" | "tests";
  state: "open" | "claimed" | "merged" | "escalated" | "dismissed";
  goal: string;
  clashingGoal: string | null;
  clashingTasks: string[];
  forkRepo: string;
  forkUrl: string;
  forkSha: string;
  files: string[];
  detail: string;
  attempts: number;
  reason: string | null;
};

/** Where a task's own goal test lives in the repo; a human ruling against a goal drops its test. */
export const goalTestPath = (taskId: string) => `test/goals/${taskId}.test.js`;

// Node's test runner reports each failure as "not ok N - name".
function failingTests(output: string) {
  const names = [...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return names.length > 0 ? `tests failed: ${names.join("; ")}` : "tests failed";
}

export const LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 2;
// The coordinator asks when a first push meets lines another agent committed at least this much earlier.
const HEAD_START_MS = 5_000;
// An agent that has not answered by then counts as needing its change.
export const ANSWER_TIMEOUT_MS = 20_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT NOT NULL, agent TEXT NOT NULL, fork_repo TEXT NOT NULL, fork_url TEXT NOT NULL, resolves INTEGER, ended TEXT, submitted INTEGER NOT NULL DEFAULT 0,
     handed_from TEXT, started_at INTEGER NOT NULL DEFAULT 0,
     verdict TEXT, verdict_to TEXT, verdict_reason TEXT, verdict_state TEXT)`,
  `CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id INTEGER NOT NULL,
     fork_sha TEXT NOT NULL, files TEXT NOT NULL, detail TEXT NOT NULL, clashing_goal TEXT, clashing_tasks TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL,
     claimed_by TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS inflight (task_id INTEGER PRIMARY KEY, sha TEXT NOT NULL, changes TEXT NOT NULL, at INTEGER NOT NULL,
     trunk_clash TEXT NOT NULL DEFAULT '[]', committed_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS warnings (task_id INTEGER NOT NULL, other_task_id INTEGER NOT NULL, files TEXT NOT NULL,
     PRIMARY KEY (task_id, other_task_id))`,
  // The coordinator's questions: one group per clash it asks about, one row per task in it.
  `CREATE TABLE IF NOT EXISTS questions (group_id INTEGER NOT NULL, task_id INTEGER NOT NULL, about TEXT NOT NULL, symbols TEXT NOT NULL,
     files TEXT NOT NULL, asked_at INTEGER NOT NULL, required INTEGER, reason TEXT, PRIMARY KEY (group_id, task_id))`,
  // Whether two clashing tasks' goals contradict, as judged by the model; task_a < task_b.
  `CREATE TABLE IF NOT EXISTS judgements (task_a INTEGER NOT NULL, task_b INTEGER NOT NULL, contradicts INTEGER NOT NULL, reason TEXT NOT NULL,
     PRIMARY KEY (task_a, task_b))`,
  `CREATE TABLE IF NOT EXISTS merges (seq INTEGER PRIMARY KEY AUTOINCREMENT, trunk_sha TEXT NOT NULL, task_id INTEGER NOT NULL,
     record_id INTEGER, files TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0, diff TEXT NOT NULL DEFAULT '')`,
  // The records a batched fix settled besides the one its task was started for.
  `CREATE TABLE IF NOT EXISTS fixes (record_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL)`,
];

// Columns added after the first deployment; ALTER fails harmlessly once a column exists.
const ADDED_COLUMNS = [
  "ALTER TABLE merges ADD COLUMN at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE merges ADD COLUMN diff TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE records ADD COLUMN clashing_tasks TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE inflight ADD COLUMN trunk_clash TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE inflight ADD COLUMN committed_at INTEGER NOT NULL DEFAULT 0",
  // A resolver's task names the record it fixes; `ended` is how its attempt finished without merging.
  "ALTER TABLE tasks ADD COLUMN resolves INTEGER",
  "ALTER TABLE tasks ADD COLUMN ended TEXT",
  "ALTER TABLE tasks ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN handed_from TEXT",
  "ALTER TABLE tasks ADD COLUMN verdict TEXT",
  "ALTER TABLE tasks ADD COLUMN verdict_to TEXT",
  "ALTER TABLE tasks ADD COLUMN verdict_reason TEXT",
  "ALTER TABLE tasks ADD COLUMN verdict_state TEXT",
  "ALTER TABLE tasks ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0",
];

export type MergeSummary = {
  trunkSha: string;
  /** The task whose change this merge brought in. */
  taskId: string;
  goal: string;
  agent: string;
  record: number | null;
  files: string[];
  at: number;
};

/**
 * Trunk's single writer for one repo. Submits run one at a time; a clean merge advances
 * trunk, anything else becomes a conflict record that resolvers claim, fix or escalate.
 */
/** Calls onWrite after every statement that is not a plain read, so watchers learn the state changed. */
export function notifyOnWrite(sql: Sql, onWrite: () => void): Sql {
  return (query, ...params) => {
    const rows = sql(query, ...params);
    if (!/^\s*SELECT\b/i.test(query)) onWrite();
    return rows;
  };
}

export class Integrator {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private sql: Sql,
    private merge: MergeFn,
    private now: () => number = Date.now,
    private watcher: Watcher = noWatcher,
    private handovers: Handovers = noHandovers,
  ) {
    for (const statement of SCHEMA) sql(statement);
    for (const statement of ADDED_COLUMNS) {
      try {
        sql(statement);
      } catch {
        // column already present
      }
    }
  }

  reset(): void {
    for (const table of ["tasks", "records", "merges", "inflight", "warnings", "judgements", "questions", "fixes"]) this.sql(`DROP TABLE IF EXISTS ${table}`);
    for (const statement of SCHEMA) this.sql(statement);
  }

  startTask(input: { goal: string; agent: string; forkRepo: string; forkUrl: string; resolves?: number }): string {
    const [row] = this.sql(
      "INSERT INTO tasks (goal, agent, fork_repo, fork_url, resolves, started_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      input.goal, input.agent, input.forkRepo, input.forkUrl, input.resolves ?? null, this.now(),
    );
    return String(row.id);
  }

  submit(input: { taskId: string; forkSha: string; resolves?: number; alsoResolves?: number[] }): Promise<SubmitResult> {
    // Submitted until the merge settles it: merged, a record, or back to active if trunk already had it.
    this.sql("UPDATE tasks SET submitted = 1 WHERE id = ?", Number(input.taskId));
    return this.serial(() => this.integrate(input));
  }

  /**
   * Takes a submit without making the agent wait for its merge: it joins the same queue as submit(),
   * and `done` settles once it has merged or become a record.
   */
  accept(input: { taskId: string; forkSha: string }): { reply: { status: "accepted"; ahead: number }; done: Promise<SubmitResult> } {
    const [task] = this.sql(
      `SELECT submitted, EXISTS (SELECT 1 FROM merges WHERE task_id = tasks.id) OR EXISTS (SELECT 1 FROM records WHERE task_id = tasks.id) AS settled
         FROM tasks WHERE id = ?`,
      Number(input.taskId),
    );
    if (!task) throw new Rejected(`unknown task ${input.taskId}`);
    if (Number(task.submitted) || Number(task.settled)) throw new Rejected(`task ${input.taskId} is already submitted`);
    const [{ ahead }] = this.sql(
      `SELECT COUNT(*) AS ahead FROM tasks t WHERE t.submitted = 1
         AND NOT EXISTS (SELECT 1 FROM merges m WHERE m.task_id = t.id) AND NOT EXISTS (SELECT 1 FROM records r WHERE r.task_id = t.id)`,
    );
    return { reply: { status: "accepted", ahead: Number(ahead) }, done: this.submit(input) };
  }

  /** A human's call on an escalated record: keep trunk as it is, or merge the incoming change preferring its side. */
  decide(recordId: number, keep: "trunk" | "incoming"): Promise<{ status: "dismissed" | MergeResult["status"]; trunkSha?: string }> {
    return this.serial(async () => {
      const [row] = this.sql(
        `SELECT r.state, r.task_id, r.fork_sha, r.clashing_tasks, t.goal, t.fork_repo, t.fork_url FROM records r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`,
        recordId,
      );
      if (!row || row.state !== "escalated") throw new Rejected(`record #${recordId} is not escalated`);
      if (keep === "trunk") {
        this.sql("UPDATE records SET state = 'dismissed' WHERE id = ?", recordId);
        return { status: "dismissed" as const };
      }
      const result = await this.merge({
        forkRepo: String(row.fork_repo),
        forkUrl: String(row.fork_url),
        forkSha: String(row.fork_sha),
        message: `Task ${row.task_id}: ${row.goal} (incoming side chosen for #${recordId})`,
        trailers: { Task: String(row.task_id), Resolves: `#${recordId}` },
        prefer: "theirs",
        dropPaths: (JSON.parse(String(row.clashing_tasks)) as string[]).map(goalTestPath),
      });
      if (result.status === "merged") {
        this.logMerge(result, Number(row.task_id), recordId);
        this.sql("UPDATE records SET state = 'merged' WHERE id = ?", recordId);
        await this.recheckAgainstTrunk(result.files);
        return { status: "merged" as const, trunkSha: result.trunkSha };
      }
      const reason = result.status === "tests_failed"
        ? "taking the incoming side failed the tests"
        : `taking the incoming side did not merge: ${result.status === "conflict" ? result.hunks.slice(0, 300) : result.status}`;
      this.sql("UPDATE records SET reason = ? WHERE id = ?", reason, recordId);
      return { status: result.status };
    });
  }

  listMerges(limit = 50): MergeSummary[] {
    return this.sql(
      `SELECT m.trunk_sha, m.task_id, m.record_id, m.files, m.at, t.goal, t.agent FROM merges m JOIN tasks t ON t.id = m.task_id ORDER BY m.seq DESC LIMIT ?`,
      limit,
    ).map((row) => this.mergeSummary(row));
  }

  /** The merge that settled a record, with its diff, or null while it is unsettled. */
  fixFor(recordId: number): (MergeSummary & { diff: string }) | null {
    const [row] = this.sql(
      `SELECT m.trunk_sha, m.task_id, m.record_id, m.files, m.at, m.diff, t.goal, t.agent FROM merges m JOIN tasks t ON t.id = m.task_id
         WHERE m.record_id = ? OR m.task_id = (SELECT task_id FROM fixes WHERE record_id = ?) ORDER BY m.seq DESC LIMIT 1`,
      recordId, recordId,
    );
    return row ? { ...this.mergeSummary(row), diff: String(row.diff) } : null;
  }

  private mergeSummary(row: Row): MergeSummary {
    return {
      trunkSha: String(row.trunk_sha),
      taskId: String(row.task_id),
      goal: String(row.goal),
      agent: String(row.agent),
      record: row.record_id == null ? null : Number(row.record_id),
      files: JSON.parse(String(row.files)),
      at: Number(row.at),
    };
  }

  /**
   * Records what an agent's latest pushed commit changes and test-merges it against other agents
   * in flight on the same files. A conflict found here is a warning to both agents, never a lock.
   */
  progress(taskId: string, sha: string): Promise<{
    changes: Change[];
    conflictsWith: { taskId: string; agent: string; goal: string; files: string[] }[];
    conflictsWithTrunk: { taskId: string; agent: string; goal: string }[];
  }> {
    return this.serial(async () => {
      const id = Number(taskId);
      const [task] = this.sql(
        `SELECT goal, agent, fork_repo, fork_url,
           EXISTS (SELECT 1 FROM merges WHERE task_id = tasks.id) OR EXISTS (SELECT 1 FROM records WHERE task_id = tasks.id) AS submitted
         FROM tasks WHERE id = ?`,
        id,
      );
      if (!task) throw new Rejected(`unknown task ${taskId}`);
      if (Number(task.submitted)) throw new Rejected(`task ${taskId} has already been submitted`);

      const firstPush = this.sql("SELECT 1 FROM inflight WHERE task_id = ?", id).length === 0;
      const inspected = await this.watcher.inspect({ taskId, forkRepo: String(task.fork_repo), forkUrl: String(task.fork_url), forkSha: sha });
      const { changes } = inspected;
      const committedAt = inspected.committedAt ?? this.now();
      const trunk = await this.watcher.trunkClashes(sha);
      this.sql(
        "INSERT OR REPLACE INTO inflight (task_id, sha, changes, at, trunk_clash, committed_at) VALUES (?, ?, ?, ?, ?, ?)",
        id, sha, JSON.stringify(changes), this.now(), JSON.stringify(trunk), committedAt,
      );

      const files = new Set(changes.map((c) => c.file));
      const others = this.listInflight().filter((t) => t.taskId !== taskId && t.agent !== task.agent && t.changes.some((c) => files.has(c.file)));
      const found = others.length > 0 ? await this.watcher.conflicts(sha, others.map((t) => ({ id: t.taskId, sha: t.sha }))) : [];

      this.sql("DELETE FROM warnings WHERE task_id = ? OR other_task_id = ?", id, id);
      for (const hit of found) {
        for (const [a, b] of [[id, Number(hit.id)], [Number(hit.id), id]]) {
          this.sql("INSERT INTO warnings (task_id, other_task_id, files) VALUES (?, ?, ?)", a, b, JSON.stringify(hit.files));
        }
      }
      if (firstPush) this.ask(id, String(task.agent), committedAt, changes, found.map((hit) => others.find((t) => t.taskId === hit.id)!));
      return {
        changes,
        conflictsWithTrunk: trunk.map((other) => {
          const [row] = this.sql("SELECT goal, agent FROM tasks WHERE id = ?", Number(other));
          return { taskId: other, agent: String(row?.agent ?? ""), goal: String(row?.goal ?? "") };
        }),
        conflictsWith: found.map((hit) => {
          const other = others.find((t) => t.taskId === hit.id)!;
          return { taskId: hit.id, agent: other.agent, goal: other.goal, files: hit.files };
        }),
      };
    });
  }

  taskForFork(forkRepo: string): string | null {
    const [row] = this.sql("SELECT id FROM tasks WHERE fork_repo = ?", forkRepo);
    return row ? String(row.id) : null;
  }

  task(id: string): (TaskSummary & { inflight: InflightTask | null }) | null {
    const summary = this.listTasks().find((t) => t.id === id);
    if (!summary) return null;
    return { ...summary, inflight: this.listInflight().find((t) => t.taskId === id) ?? null };
  }

  /** Everything the dashboard shows, in one read. */
  snapshot() {
    return { tasks: this.listTasks(), records: this.listRecords(), merges: this.listMerges(), inflight: this.listInflight() };
  }

  listInflight(): InflightTask[] {
    const warnings = this.sql("SELECT task_id, other_task_id FROM warnings ORDER BY other_task_id");
    return this.sql("SELECT i.task_id, i.sha, i.changes, i.at, i.committed_at, i.trunk_clash, t.goal, t.agent FROM inflight i JOIN tasks t ON t.id = i.task_id ORDER BY i.task_id").map((row) => ({
      taskId: String(row.task_id),
      agent: String(row.agent),
      goal: String(row.goal),
      sha: String(row.sha),
      changes: JSON.parse(String(row.changes)),
      at: Number(row.at),
      committedAt: Number(row.committed_at),
      conflictsWith: warnings.filter((w) => w.task_id === row.task_id).map((w) => String(w.other_task_id)),
      conflictsWithTrunk: JSON.parse(String(row.trunk_clash)),
    }));
  }

  /** Who is touching a file (or one function in it): agents in flight, conflicts waiting in the queue, and recent merges. */
  touching(path: string, symbol?: string) {
    const hits = (c: Change) => c.file === path && (!symbol || c.symbol === symbol);
    return {
      inFlight: this.listInflight()
        .filter((t) => t.changes.some(hits))
        .map((t) => ({ ...t, changes: t.changes.filter(hits) })),
      waiting: this.listRecords(["open", "claimed", "escalated"]).filter((r) => r.files.includes(path)),
      merged: this.why(path),
    };
  }

  // A merge can put an in-flight agent's work in conflict with trunk; tell the agents on those files.
  private async recheckAgainstTrunk(files: string[]) {
    for (const t of this.listInflight().filter((t) => t.changes.some((c) => files.includes(c.file)))) {
      const clashes = await this.watcher.trunkClashes(t.sha);
      this.sql("UPDATE inflight SET trunk_clash = ? WHERE task_id = ?", JSON.stringify(clashes), Number(t.taskId));
    }
  }

  /**
   * The coordinator asks when a task's first push lands on lines another agent committed well before:
   * each agent in the clash says whether its change there is required for its task. Agents that start on
   * the same lines together get warnings only.
   */
  private ask(id: number, agent: string, committedAt: number, changes: Change[], clashing: InflightTask[]) {
    const established = clashing.filter(
      (t) => t.agent !== agent && committedAt - t.committedAt >= HEAD_START_MS && this.sql("SELECT resolves FROM tasks WHERE id = ?", Number(t.taskId))[0]?.resolves == null,
    );
    const [own] = this.sql("SELECT resolves FROM tasks WHERE id = ?", id);
    if (established.length === 0 || own?.resolves != null) return;
    const shared = changes.filter((c) => established.some((t) => t.changes.some((o) => o.file === c.file && o.symbol === c.symbol)));
    const where = shared.length ? shared : changes;
    const about = [...new Set(where.map((c) => (c.symbol ? `${c.symbol} in ${c.file}` : c.file)))].join(", ");
    const symbols = JSON.stringify([...new Set(where.map((c) => c.symbol).filter(Boolean))]);
    const files = JSON.stringify([...new Set(where.map((c) => c.file))]);
    for (const member of [id, ...established.map((t) => Number(t.taskId))]) {
      this.sql(
        "INSERT OR IGNORE INTO questions (group_id, task_id, about, symbols, files, asked_at) VALUES (?, ?, ?, ?, ?, ?)",
        id, member, about, symbols, files, this.now(),
      );
    }
  }

  /** An agent's answer to the coordinator's question; verdicts follow once everyone in the clash has answered. */
  answer(taskId: string, agent: string, required: boolean, reason: string): Promise<{ state: "waiting" | "decided" }> {
    return this.serial(async () => {
      const id = Number(taskId);
      const [task] = this.sql("SELECT agent FROM tasks WHERE id = ?", id);
      if (!task) throw new Rejected(`unknown task ${taskId}`);
      if (task.agent !== agent) throw new Rejected(`task ${taskId} is held by ${task.agent}, not ${agent}`);
      const [question] = this.sql("SELECT group_id FROM questions WHERE task_id = ? AND required IS NULL ORDER BY group_id DESC LIMIT 1", id);
      if (!question) throw new Rejected(`task ${taskId} has no open question`);
      this.sql("UPDATE questions SET required = ?, reason = ? WHERE group_id = ? AND task_id = ?", required ? 1 : 0, reason, question.group_id, id);
      return (await this.settle(Number(question.group_id))) ? { state: "decided" } : { state: "waiting" };
    });
  }

  /** Whether any clash still waits on answers. */
  hasOpenQuestions(): boolean {
    return this.sql("SELECT 1 FROM questions q JOIN tasks t ON t.id = q.task_id WHERE t.verdict IS NULL AND t.submitted = 0 LIMIT 1").length > 0;
  }

  /** Gives verdicts in every clash whose answers are in or whose time is up. */
  settleDue(): Promise<void> {
    return this.serial(async () => {
      for (const { group_id } of this.sql("SELECT DISTINCT group_id FROM questions")) await this.settle(Number(group_id));
    });
  }

  /**
   * The coordinator's verdicts for one clash. An optional change is dropped from its agent's branch. Of the
   * agents that need theirs, the one that committed first continues and the later ones hand their whole tasks
   * to it, so one agent makes the changes in sequence. Tasks whose goals contradict always continue, for a
   * person to settle. Returns false while answers are still due.
   */
  private async settle(groupId: number): Promise<boolean> {
    const rows = this.sql(
      `SELECT q.task_id, q.required, q.reason, q.asked_at, q.symbols, q.files, t.agent, t.goal, t.fork_repo, t.fork_url, t.submitted, t.verdict, i.sha, i.committed_at
         FROM questions q JOIN tasks t ON t.id = q.task_id LEFT JOIN inflight i ON i.task_id = q.task_id WHERE q.group_id = ?`,
      groupId,
    );
    const live = rows.filter((r) => !Number(r.submitted) && r.verdict == null && r.sha != null);
    if (live.length === 0) return true;
    if (live.some((r) => r.required == null) && this.now() - Number(live[0].asked_at) < ANSWER_TIMEOUT_MS) return false;
    const needs = live.filter((r) => r.required == null || Number(r.required)).sort((a, b) => Number(a.committed_at) - Number(b.committed_at));
    const keeper = needs[0];
    const contradicts = (a: number, b: number) => this.sql(
      "SELECT 1 FROM judgements WHERE contradicts = 1 AND task_a = ? AND task_b = ?", Math.min(a, b), Math.max(a, b),
    ).length > 0;
    for (const row of live) {
      const id = Number(row.task_id);
      const goalTest = goalTestPath(String(id));
      const fork = { taskId: String(id), forkRepo: String(row.fork_repo), forkUrl: String(row.fork_url), forkSha: String(row.sha), goalTest };
      if (row.required != null && !Number(row.required)) {
        this.setVerdict(id, "drop", null, `its change to ${this.aboutOf(groupId)} is optional: ${row.reason}`, "pending");
        const result = await this.handovers.drop({ ...fork, files: JSON.parse(String(row.files)), symbols: JSON.parse(String(row.symbols)) });
        this.finish(id, result);
      } else if (row === keeper || row.agent === keeper.agent || contradicts(id, Number(keeper.task_id))) {
        this.setVerdict(id, "continue", null, row === keeper ? "it changed these lines first" : "its goal cannot be combined with the other agent's", "done");
      } else {
        this.setVerdict(id, "handover", String(keeper.agent), `both need ${this.aboutOf(groupId)}; ${keeper.agent} started first`, "pending");
        const result = await this.handovers.flatten({ ...fork, goal: String(row.goal) });
        this.finish(id, result);
        if (result.status === "done") this.moveTask(id, String(row.agent), String(keeper.agent));
      }
    }
    return true;
  }

  private aboutOf(groupId: number): string {
    return String(this.sql("SELECT about FROM questions WHERE group_id = ? LIMIT 1", groupId)[0]?.about ?? "these lines");
  }

  private setVerdict(id: number, decision: string, to: string | null, reason: string, state: string) {
    this.sql("UPDATE tasks SET verdict = ?, verdict_to = ?, verdict_reason = ?, verdict_state = ? WHERE id = ?", decision, to, reason, state, id);
  }

  private finish(id: number, result: HandoverResult) {
    if (result.status === "done") this.sql("UPDATE tasks SET verdict_state = 'done' WHERE id = ?", id);
    else this.sql("UPDATE tasks SET verdict_state = 'refused', verdict_reason = ? WHERE id = ?", result.reason, id);
  }

  private moveTask(id: number, from: string, to: string) {
    this.sql("UPDATE tasks SET agent = ?, handed_from = ? WHERE id = ?", to, from, id);
    // One agent does its own tasks one after another, so they cannot clash with each other.
    this.sql(
      `DELETE FROM warnings WHERE (task_id = ? AND other_task_id IN (SELECT id FROM tasks WHERE agent = ?))
         OR (other_task_id = ? AND task_id IN (SELECT id FROM tasks WHERE agent = ?))`,
      id, to, id, to,
    );
  }

  /** The task's fork, for the agent holding it. */
  forkOf(taskId: string, agent: string): { repo: string; url: string } {
    const [task] = this.sql("SELECT agent, fork_repo, fork_url FROM tasks WHERE id = ?", Number(taskId));
    if (!task) throw new Rejected(`unknown task ${taskId}`);
    if (task.agent !== agent) throw new Rejected(`task ${taskId} is held by ${task.agent}, not ${agent}`);
    return { repo: String(task.fork_repo), url: String(task.fork_url) };
  }

  /** Pairs of clashing tasks whose goals have not been judged yet. */
  pairsToJudge(): { a: string; b: string; goalA: string; goalB: string }[] {
    return this.sql(
      `SELECT w.task_id AS a, w.other_task_id AS b, ta.goal AS goal_a, tb.goal AS goal_b FROM warnings w
         JOIN tasks ta ON ta.id = w.task_id JOIN tasks tb ON tb.id = w.other_task_id
         WHERE w.task_id < w.other_task_id AND ta.resolves IS NULL AND tb.resolves IS NULL
           AND NOT EXISTS (SELECT 1 FROM judgements j WHERE j.task_a = w.task_id AND j.task_b = w.other_task_id)
         ORDER BY w.task_id, w.other_task_id`,
    ).map((row) => ({ a: String(row.a), b: String(row.b), goalA: String(row.goal_a), goalB: String(row.goal_b) }));
  }

  recordJudgement(a: string, b: string, contradicts: boolean, reason: string): void {
    const [low, high] = [Number(a), Number(b)].sort((x, y) => x - y);
    this.sql("INSERT OR REPLACE INTO judgements (task_a, task_b, contradicts, reason) VALUES (?, ?, ?, ?)", low, high, contradicts ? 1 : 0, reason);
  }

  private contradictionOf(id: number): TaskSummary["contradiction"] {
    const [row] = this.sql(
      `SELECT CASE WHEN j.task_a = ? THEN j.task_b ELSE j.task_a END AS other, j.reason, t.agent FROM judgements j
         JOIN tasks t ON t.id = CASE WHEN j.task_a = ? THEN j.task_b ELSE j.task_a END
         WHERE j.contradicts = 1 AND (j.task_a = ? OR j.task_b = ?) LIMIT 1`,
      id, id, id, id,
    );
    return row ? { with: String(row.other), agent: String(row.agent), reason: String(row.reason) } : null;
  }

  private questionOf(id: number): TaskSummary["question"] {
    const [row] = this.sql("SELECT group_id, about, asked_at, required, reason FROM questions WHERE task_id = ? ORDER BY group_id DESC LIMIT 1", id);
    if (!row) return null;
    return {
      group: String(row.group_id),
      about: String(row.about),
      askedAt: Number(row.asked_at),
      answer: row.required == null ? null : { required: Boolean(Number(row.required)), reason: String(row.reason) },
    };
  }

  private forget(taskId: number) {
    this.sql("DELETE FROM inflight WHERE task_id = ?", taskId);
    this.sql("DELETE FROM warnings WHERE task_id = ? OR other_task_id = ?", taskId, taskId);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private logMerge(result: Extract<MergeResult, { status: "merged" }>, taskId: number, recordId: number | null) {
    this.sql(
      "INSERT INTO merges (trunk_sha, task_id, record_id, files, at, diff) VALUES (?, ?, ?, ?, ?, ?)",
      result.trunkSha, taskId, recordId, JSON.stringify(result.files), this.now(), result.diff,
    );
  }

  /**
   * Gives out the oldest claimable record. Resolvers work in parallel, so a record whose files another
   * resolver is fixing waits: two fixes to one file would clash with each other at merge.
   */
  claim(resolver: string): ConflictRecord | null {
    const busy = new Set(
      this.sql("SELECT files FROM records WHERE state = 'claimed' AND lease_until >= ?", this.now())
        .flatMap((r) => JSON.parse(String(r.files)) as string[]),
    );
    const row = this.sql(
      `SELECT id, files FROM records WHERE state = 'open' OR (state = 'claimed' AND lease_until < ?) ORDER BY id`,
      this.now(),
    ).find((r) => !(JSON.parse(String(r.files)) as string[]).some((f) => busy.has(f)));
    if (!row) return null;
    this.sql(
      "UPDATE records SET state = 'claimed', claimed_by = ?, lease_until = ? WHERE id = ?",
      resolver, this.now() + LEASE_MS, row.id,
    );
    return this.record(Number(row.id));
  }

  /**
   * Adds to a resolver's claim the other open records on the claimed record's files that have not been tried yet,
   * so one fix settles a burst of clashes on one file. A retry is fixed on its own.
   */
  claimAlso(resolver: string, recordId: number, max = 7): ConflictRecord[] {
    const held = this.record(recordId);
    if (!held || held.state !== "claimed" || held.kind !== "merge") return [];
    const files = new Set(held.files);
    const ids = this.sql("SELECT id, files FROM records WHERE state = 'open' AND kind = 'merge' AND attempts = 0 AND id != ? ORDER BY id", recordId)
      .filter((r) => {
        const own = JSON.parse(String(r.files)) as string[];
        return own.length > 0 && own.every((f) => files.has(f));
      })
      .slice(0, max)
      .map((r) => Number(r.id));
    for (const id of ids) this.sql("UPDATE records SET state = 'claimed', claimed_by = ?, lease_until = ? WHERE id = ?", resolver, this.now() + LEASE_MS, id);
    return ids.map((id) => this.record(id)!);
  }

  /** Gives a claimed record back to the queue untouched. */
  release(recordId: number, resolver: string): void {
    this.sql("UPDATE records SET state = 'open', claimed_by = NULL, lease_until = NULL WHERE id = ? AND state = 'claimed' AND claimed_by = ?", recordId, resolver);
  }

  escalate(recordId: number, resolver: string, reason: string): void {
    const updated = this.sql(
      "UPDATE records SET state = 'escalated', reason = ? WHERE id = ? AND state = 'claimed' AND claimed_by = ? RETURNING id",
      reason, recordId, resolver,
    );
    if (updated.length === 0) throw new Rejected(`record #${recordId} is not claimed by ${resolver}`);
    this.sql(
      `UPDATE tasks SET ended = 'handed_off' WHERE id = (SELECT MAX(id) FROM tasks WHERE resolves = ? AND agent = ? AND ended IS NULL)`,
      recordId, resolver,
    );
  }

  listTasks(): TaskSummary[] {
    const rows = this.sql(
      `SELECT t.id, t.goal, t.agent, t.ended, t.started_at, t.submitted, t.resolves, t.handed_from, t.verdict, t.verdict_to, t.verdict_reason, t.verdict_state,
         EXISTS (SELECT 1 FROM merges m WHERE m.task_id = t.id) AS merged,
         (SELECT r.id FROM records r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS record_id,
         (SELECT r.state FROM records r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS record_state
       FROM tasks t ORDER BY t.id`,
    );
    return rows.map((row) => {
      const recordState = row.record_state as string | null;
      const state: TaskSummary["state"] = Number(row.merged)
        ? "merged"
        : row.ended ? (row.ended as TaskSummary["state"])
        : recordState === "merged" ? "resolved"
        : recordState === "escalated" ? "escalated"
        : recordState === "dismissed" ? "dismissed"
        : recordState ? "queued"
        : Number(row.submitted) ? "submitted"
        : "active";
      return { id: String(row.id), goal: String(row.goal), agent: String(row.agent), state, record: row.record_id == null ? null : Number(row.record_id), resolves: row.resolves == null ? null : Number(row.resolves),
        startedAt: Number(row.started_at),
        handedFrom: row.handed_from == null ? null : String(row.handed_from),
        contradiction: this.contradictionOf(Number(row.id)),
        question: this.questionOf(Number(row.id)),
        verdict: row.verdict == null ? null : {
          decision: row.verdict as "continue" | "drop" | "handover",
          to: row.verdict_to == null ? null : String(row.verdict_to),
          reason: String(row.verdict_reason),
          state: row.verdict_state as "pending" | "done" | "refused",
        },
      };
    });
  }

  listRecords(states?: ConflictRecord["state"][]): Omit<ConflictRecord, "detail">[] {
    return this.sql("SELECT id, state FROM records ORDER BY id")
      .filter((row) => !states || states.includes(row.state as ConflictRecord["state"]))
      .map((row) => {
        const { detail: _detail, ...summary } = this.record(Number(row.id))!;
        return summary;
      });
  }

  record(id: number): ConflictRecord | null {
    const [row] = this.sql(
      `SELECT r.*, t.goal, t.fork_repo, t.fork_url FROM records r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`,
      id,
    );
    if (!row) return null;
    return {
      id: Number(row.id),
      kind: row.kind as ConflictRecord["kind"],
      state: row.state as ConflictRecord["state"],
      goal: String(row.goal),
      clashingGoal: (row.clashing_goal as string | null) ?? null,
      clashingTasks: JSON.parse(String(row.clashing_tasks ?? "[]")),
      forkRepo: String(row.fork_repo),
      forkUrl: String(row.fork_url),
      forkSha: String(row.fork_sha),
      files: JSON.parse(String(row.files)),
      detail: String(row.detail),
      attempts: Number(row.attempts),
      reason: (row.reason as string | null) ?? null,
    };
  }

  why(path: string) {
    const rows = this.sql(
      `SELECT m.trunk_sha, m.files, m.record_id, t.goal, t.agent FROM merges m JOIN tasks t ON t.id = m.task_id ORDER BY m.seq DESC`,
    );
    return rows
      .filter((row) => (JSON.parse(String(row.files)) as string[]).includes(path))
      .map((row) => {
        const record = row.record_id == null ? null : this.record(Number(row.record_id));
        return {
          trunkSha: String(row.trunk_sha),
          goal: String(row.goal),
          agent: String(row.agent),
          record: record && { id: record.id, goal: record.goal, clashingGoal: record.clashingGoal },
        };
      });
  }

  private async integrate(input: { taskId: string; forkSha: string; resolves?: number; alsoResolves?: number[] }): Promise<SubmitResult> {
    const [task] = this.sql("SELECT goal, agent, fork_repo, fork_url FROM tasks WHERE id = ?", Number(input.taskId));
    if (!task) throw new Rejected(`unknown task ${input.taskId}`);
    const settles = input.resolves === undefined ? [] : [input.resolves, ...(input.alsoResolves ?? [])];
    for (const id of settles) {
      const [claim] = this.sql("SELECT state, claimed_by FROM records WHERE id = ?", id);
      if (!claim || claim.state !== "claimed" || claim.claimed_by !== task.agent) {
        throw new Rejected(`record #${id} is not claimed by ${task.agent}`);
      }
    }
    const trailers: Record<string, string> = { Task: input.taskId };
    if (settles.length) trailers.Resolves = settles.map((id) => `#${id}`).join(", ");

    const result = await this.merge({
      forkRepo: String(task.fork_repo),
      forkUrl: String(task.fork_url),
      forkSha: input.forkSha,
      message: `Task ${input.taskId}: ${task.goal}`,
      trailers,
    });

    if (result.status === "already_in_trunk") {
      this.sql("UPDATE tasks SET submitted = 0 WHERE id = ?", Number(input.taskId));
      return result;
    }
    this.forget(Number(input.taskId));

    if (result.status === "merged") {
      this.logMerge(result, Number(input.taskId), input.resolves ?? null);
      for (const id of settles) this.sql("UPDATE records SET state = 'merged' WHERE id = ?", id);
      for (const id of settles.slice(1)) this.sql("INSERT OR REPLACE INTO fixes (record_id, task_id) VALUES (?, ?)", id, Number(input.taskId));
      await this.recheckAgainstTrunk(result.files);
      return { status: "merged", trunkSha: result.trunkSha };
    }

    const reason = result.status === "conflict" ? `conflict in ${result.files.join(", ")}` : failingTests(result.output);
    if (input.resolves !== undefined) {
      for (const id of settles) {
        this.sql(
          `UPDATE records SET attempts = attempts + 1, reason = ?, claimed_by = NULL, lease_until = NULL,
             state = CASE WHEN attempts + 1 >= ? THEN 'escalated' ELSE 'open' END WHERE id = ?`,
          reason, MAX_ATTEMPTS, id,
        );
      }
      this.sql("UPDATE tasks SET ended = 'failed' WHERE id = ?", input.taskId);
      return { status: "queued", record: input.resolves };
    }

    const files = result.status === "conflict" ? result.files : [];
    // Goals already judged contradictory skip the resolver: no merge can satisfy both, so a person decides.
    const contradiction = this.contradictionOf(Number(input.taskId));
    const settledByPerson = result.status === "conflict" && contradiction && result.clashingTasks.includes(contradiction.with) ? contradiction : null;
    const [row] = this.sql(
      `INSERT INTO records (kind, task_id, fork_sha, files, detail, clashing_goal, clashing_tasks, state, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      result.status === "conflict" ? "merge" : "tests",
      Number(input.taskId),
      input.forkSha,
      JSON.stringify(files),
      result.status === "conflict" ? result.hunks : result.output,
      this.clashingGoal(result.status === "conflict" ? result.clashingTasks : [], files),
      JSON.stringify(result.status === "conflict" ? result.clashingTasks : []),
      settledByPerson ? "escalated" : "open",
      settledByPerson ? `contradicts ${settledByPerson.agent}: ${settledByPerson.reason}` : null,
    );
    return { status: "queued", record: Number(row.id) };
  }

  private clashingGoal(taskIds: string[], files: string[]): string | null {
    const goals = taskIds
      .map((id) => this.sql("SELECT goal FROM tasks WHERE id = ?", Number(id))[0]?.goal)
      .filter((goal): goal is string => typeof goal === "string");
    return goals.length > 0 ? goals.join("; ") : this.lastGoalTouching(files);
  }

  private lastGoalTouching(files: string[]): string | null {
    // ponytail: scans every merge; index merges by file if trunk history gets long
    const rows = this.sql(`SELECT m.files, t.goal FROM merges m JOIN tasks t ON t.id = m.task_id ORDER BY m.seq DESC`);
    const hit = rows.find((row) => (JSON.parse(String(row.files)) as string[]).some((f) => files.includes(f)));
    return hit ? String(hit.goal) : null;
  }
}
