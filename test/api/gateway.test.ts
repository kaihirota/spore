import { beforeEach, describe, expect, it } from "vitest";
import { agentKey, handle, type GatewayDeps } from "../../src/api/gateway";
import { Rejected } from "../../src/integrator/integrator";

let deps: GatewayDeps;
let started: unknown[];
const SHA = "a".repeat(40);

beforeEach(() => {
  started = [];
  deps = {
    apiKey: "secret",
    dashboard: "<!doctype html><title>Spore</title>",
    forkTrunk: async (name) => ({ remote: `https://git/${name}.git`, token: `write-${name}` }),
    readToken: async (repo) => `read-${repo}`,
    watchFork: async (repo) => {
      started.push(["watch", repo]);
      return true;
    },
    trunkAccess: async () => ({ remote: "https://git/trunk.git", token: "read-trunk" }),
    live: async () => new Response("live socket"),
    writeToken: async (repo) => `write-${repo}`,
    resolveFile: async (input) => ({ content: `resolved ${input.path} for ${input.trunkGoal} + ${input.incomingGoal}` }),
    integrator: {
      startTask: async (input) => {
        started.push(input);
        return "7";
      },
      submit: async (input) => {
        started.push(input);
        return { status: "queued", record: 3 };
      },
      accept: async (input) => {
        started.push(["accept", input]);
        return { status: "accepted", ahead: 2 };
      },
      claim: async () => ({
        id: 3, kind: "merge", state: "claimed", goal: "g", clashingGoal: "c", forkRepo: "task-ab",
        forkUrl: "https://git/task-ab.git", forkSha: "f", files: ["a.ts"], detail: "<<<", attempts: 0, reason: null, clashingTasks: [],
      }),
      escalate: async (...args) => {
        started.push(args);
      },
      listTasks: async () => [{ id: "1", goal: "g", agent: "a", state: "active", record: null, resolves: null, startedAt: 1, handedFrom: null, contradiction: null, question: null, verdict: null }],
      progress: async (taskId, sha) => {
        started.push([taskId, sha]);
        return { changes: [], conflictsWith: [], conflictsWithTrunk: [] };
      },
      listInflight: async () => [],
      answer: async (taskId, agent, required, reason) => {
        started.push(["answer", taskId, agent, required, reason]);
        return { state: "decided" };
      },
      forkOf: async (taskId, agent) => {
        if (agent !== "agent-2") throw new Rejected(`task ${taskId} is held by agent-9, not ${agent}`);
        return { repo: "task-ab", url: "https://git/task-ab.git" };
      },
      task: async (id) => (id === "7" ? { id: "7", goal: "g", agent: "a", state: "active", record: null, resolves: null, startedAt: 1, handedFrom: null, contradiction: null, question: null, verdict: null, inflight: null } : null),
      touching: async (path, symbol) => ({ inFlight: [], waiting: [], merged: [{ trunkSha: "t1", goal: `${path}:${symbol}`, agent: "a", record: null }] }),
      listMerges: async () => [{ trunkSha: "t1", taskId: "1", goal: "g", agent: "a", record: null, files: [], at: 1 }],
      fixFor: async (id) => (id === 3 ? { trunkSha: "t2", taskId: "2", goal: "fix", agent: "r1", record: 3, files: [], at: 2, diff: "+fixed" } : null),
      decide: async (id, keep) => {
        started.push([id, keep]);
        return { status: "dismissed" };
      },
      listRecords: async (states) => [{ id: 1, state: states?.[0] ?? "open" } as never],
      record: async (id) => (id === 3 ? ({ id: 3, goal: "g" } as never) : null),
      reset: async () => {
        started.push("reset");
      },
      why: async (path) => [{ trunkSha: "t1", goal: `why ${path}`, agent: "a", record: null }],
    },
  };
});

const call = (method: string, path: string, body?: unknown, key: string | null = "secret") =>
  handle(
    new Request(`https://cq${path}`, {
      method,
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
      body: body ? JSON.stringify(body) : undefined,
    }),
    deps,
  );

describe("gateway", () => {
  it("rejects a request with a wrong API key", async () => {
    expect((await call("POST", "/tasks", { goal: "g", agent: "a" }, "wrong")).status).toBe(401);
    expect(started).toEqual([]);
  });

  it("hands a live dashboard socket to the integrator when the key arrives as its protocol", async () => {
    const response = await handle(
      new Request("https://cq/live", { headers: { upgrade: "websocket", "sec-websocket-protocol": "spore, secret" } }),
      deps,
    );

    expect(await response.text()).toBe("live socket");
  });

  it("refuses a live dashboard socket with a wrong key", async () => {
    const response = await handle(
      new Request("https://cq/live", { headers: { upgrade: "websocket", "sec-websocket-protocol": "spore, wrong" } }),
      deps,
    );

    expect(response.status).toBe(401);
  });

  it("rejects a request with no API key", async () => {
    expect((await call("POST", "/tasks", { goal: "g", agent: "a" }, null)).status).toBe(401);
    expect(started).toEqual([]);
  });

  it("start_task forks trunk and returns the fork remote and write token", async () => {
    const response = await call("POST", "/tasks", { goal: "rate limit", agent: "agent-1" });
    const body = (await response.json()) as { taskId: string; remote: string; token: string; trunkRemote: string; trunkToken: string };

    expect(body.taskId).toBe("7");
    expect(body.remote).toMatch(/^https:\/\/git\/task-[0-9a-f]{8}\.git$/);
    expect(body.token).toMatch(/^write-task-/);
    expect(body).toMatchObject({ trunkRemote: "https://git/trunk.git", trunkToken: "read-trunk" });
    expect(started).toEqual([
      ["watch", expect.stringMatching(/^task-/)],
      { goal: "rate limit", agent: "agent-1", forkRepo: expect.stringMatching(/^task-/), forkUrl: body.remote },
    ]);
  });

  it("start_task still creates the task when its fork cannot be watched, and says so", async () => {
    deps.watchFork = async () => {
      throw new Error("subscribing to pushes on task-ab failed: 403");
    };

    const response = await call("POST", "/tasks", { goal: "g", agent: "a" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ taskId: "7", watched: false });
  });

  it("takes an agent's answer to the coordinator's question", async () => {
    const response = await call("POST", "/tasks/7/answer", { agent: "agent-9", required: true, reason: "uptime goes in the health response" });

    expect(await response.json()).toEqual({ state: "decided" });
    expect(started).toEqual([["answer", "7", "agent-9", true, "uptime goes in the health response"]]);
  });

  it("rejects an answer that does not say whether the change is required", async () => {
    expect((await call("POST", "/tasks/7/answer", { agent: "agent-9", reason: "x" })).status).toBe(400);
  });

  it("gives the agent holding a task a write token for its fork", async () => {
    const response = await call("POST", "/tasks/7/access", { agent: "agent-2" });

    expect(await response.json()).toEqual({
      remote: "https://git/task-ab.git",
      token: "write-task-ab",
      trunkRemote: "https://git/trunk.git",
      trunkToken: "read-trunk",
    });
  });

  it("refuses fork access to an agent that does not hold the task", async () => {
    expect((await call("POST", "/tasks/7/access", { agent: "agent-3" })).status).toBe(409);
  });

  it("start_task rejects a request without a goal", async () => {
    expect((await call("POST", "/tasks", { agent: "agent-1" })).status).toBe(400);
  });

  it("submit passes the task, commit and record through and returns the integrator's answer", async () => {
    const response = await call("POST", "/tasks/7/submit", { sha: SHA, resolves: 3 });

    expect(await response.json()).toEqual({ status: "queued", record: 3 });
    expect(started).toEqual([{ taskId: "7", forkSha: SHA, resolves: 3 }]);
  });

  it("submit with wait false answers before the merge, with the queue ahead of it", async () => {
    const response = await call("POST", "/tasks/7/submit", { sha: SHA, wait: false });

    expect(await response.json()).toEqual({ status: "accepted", ahead: 2 });
    expect(started).toEqual([["accept", { taskId: "7", forkSha: SHA }]]);
  });

  it("submit rejects anything but a full commit SHA", async () => {
    expect((await call("POST", "/tasks/7/submit", { sha: "origin/main" })).status).toBe(400);
    expect(started).toEqual([]);
  });

  it("returns 409 when the integrator rejects the request", async () => {
    deps.integrator.submit = async () => {
      throw new Rejected("record #3 is not claimed by r2");
    };

    const response = await call("POST", "/tasks/7/submit", { sha: SHA, resolves: 3 });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "record #3 is not claimed by r2" });
  });

  it("escalate passes the resolver and reason through", async () => {
    await call("POST", "/records/3/escalate", { resolver: "r1", reason: "contradiction" });

    expect(started).toEqual([[3, "r1", "contradiction"]]);
  });

  it("lists tasks so agents can see what others are working on", async () => {
    expect(await (await call("GET", "/tasks")).json()).toEqual([{ id: "1", goal: "g", agent: "a", state: "active", record: null, resolves: null, startedAt: 1, handedFrom: null, contradiction: null, question: null, verdict: null }]);
  });

  it("lists records filtered by state", async () => {
    expect(await (await call("GET", "/records?state=escalated")).json()).toEqual([{ id: 1, state: "escalated" }]);
  });

  it("claim_record adds a read token for the incoming change's fork", async () => {
    const body = (await (await call("POST", "/records/claim", { resolver: "r1" })).json()) as { id: number; forkToken: string };

    expect(body).toMatchObject({ id: 3, forkToken: "read-task-ab" });
  });

  it("why returns the history for a path", async () => {
    const body = await (await call("GET", "/why?path=src/flags.ts")).json();

    expect(body).toEqual([{ trunkSha: "t1", goal: "why src/flags.ts", agent: "a", record: null }]);
  });

  it("resolve_file returns the model's resolution", async () => {
    const response = await call("POST", "/resolve-file", { path: "a.js", content: "<<<", trunkGoal: "x", incomingGoal: "y" });

    expect(await response.json()).toEqual({ content: "resolved a.js for x + y" });
  });

  it("resolve_file rejects a request missing a goal", async () => {
    expect((await call("POST", "/resolve-file", { path: "a.js", content: "<<<", trunkGoal: "x" })).status).toBe(400);
  });

  it("reset clears the integrator", async () => {
    expect((await call("POST", "/reset")).status).toBe(200);
    expect(started).toEqual(["reset"]);
  });

  it("returns a dependency failure as JSON with its message", async () => {
    deps.forkTrunk = async () => {
      throw new Error("FORK_IN_PROGRESS");
    };

    const response = await call("POST", "/tasks", { goal: "g", agent: "a" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "FORK_IN_PROGRESS" });
  });

  it("serves the dashboard page without the API key", async () => {
    const response = await call("GET", "/", undefined, null);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>Spore</title>");
  });

  it("state returns tasks, records and trunk history in one call", async () => {
    const body = (await (await call("GET", "/state")).json()) as Record<string, unknown[]>;

    expect(Object.keys(body).sort()).toEqual(["inflight", "merges", "records", "tasks"]);
    expect(body.merges).toHaveLength(1);
  });

  it("decide passes the human's choice through", async () => {
    const response = await call("POST", "/records/4/decide", { keep: "incoming" });

    expect(await response.json()).toEqual({ status: "dismissed" });
    expect(started).toEqual([[4, "incoming"]]);
  });

  it("decide rejects a choice other than trunk or incoming", async () => {
    expect((await call("POST", "/records/4/decide", { keep: "both" })).status).toBe(400);
  });

  it("returns a record with the resolver's fix diff when one merged", async () => {
    expect(await (await call("GET", "/records/3")).json()).toMatchObject({ id: 3, fix: { diff: "+fixed" } });
  });

  it("progress passes the task and pushed commit through", async () => {
    await call("POST", "/tasks/7/progress", { sha: SHA });

    expect(started).toEqual([["7", SHA]]);
  });

  it("progress rejects anything but a full commit SHA", async () => {
    expect((await call("POST", "/tasks/7/progress", { sha: "HEAD" })).status).toBe(400);
  });

  it("touching answers for a path and an optional function", async () => {
    const body = (await (await call("GET", "/touching?path=src/flags.js&symbol=setFlag")).json()) as { merged: { goal: string }[] };

    expect(body.merged[0].goal).toBe("src/flags.js:setFlag");
  });

  it("returns one task with its in-flight entry", async () => {
    expect(await (await call("GET", "/tasks/7")).json()).toMatchObject({ id: "7", inflight: null });
  });

  it("returns 404 for an unknown task", async () => {
    expect((await call("GET", "/tasks/99")).status).toBe(404);
  });

  it("returns 404 for an unknown record", async () => {
    expect((await call("GET", "/records/99")).status).toBe(404);
  });
});

describe("agent keys", () => {
  const keyFor = (agent: string) => agentKey("secret", agent);

  it("gives the operator a key for a named agent", async () => {
    const body = (await (await call("POST", "/agents", { agent: "agent-1" })).json()) as { agent: string; key: string };

    expect(body).toEqual({ agent: "agent-1", key: await keyFor("agent-1") });
  });

  it("refuses an agent name with characters a key cannot carry", async () => {
    expect((await call("POST", "/agents", { agent: "agent 1" })).status).toBe(400);
  });

  it("starts a task under the key's agent when the body names none", async () => {
    await call("POST", "/tasks", { goal: "g" }, await keyFor("agent-1"));

    expect(started).toContainEqual(expect.objectContaining({ goal: "g", agent: "agent-1" }));
  });

  it("refuses to start a task under another agent's name", async () => {
    expect((await call("POST", "/tasks", { goal: "g", agent: "agent-2" }, await keyFor("agent-1"))).status).toBe(403);
  });

  it("lets an agent submit a task it holds", async () => {
    expect((await call("POST", "/tasks/7/submit", { sha: SHA }, await keyFor("a"))).status).toBe(200);
  });

  it("refuses a submit for a task another agent holds", async () => {
    expect((await call("POST", "/tasks/7/submit", { sha: SHA }, await keyFor("b"))).status).toBe(403);
  });

  it("refuses a push report for a task another agent holds", async () => {
    expect((await call("POST", "/tasks/7/progress", { sha: SHA }, await keyFor("b"))).status).toBe(403);
  });

  it("refuses an answer given in another agent's name", async () => {
    expect((await call("POST", "/tasks/7/answer", { agent: "a", required: true }, await keyFor("b"))).status).toBe(403);
  });

  it("answers in the key's agent's name when the body names none", async () => {
    await call("POST", "/tasks/7/answer", { required: false, reason: "optional" }, await keyFor("agent-9"));

    expect(started).toEqual([["answer", "7", "agent-9", false, "optional"]]);
  });

  it.each([
    ["POST", "/reset"],
    ["POST", "/agents"],
    ["POST", "/records/claim"],
    ["POST", "/records/3/escalate"],
    ["POST", "/records/3/decide"],
    ["POST", "/resolve-file"],
  ])("keeps %s %s for the operator", async (method, path) => {
    expect((await call(method, path, {}, await keyFor("a"))).status).toBe(403);
  });

  it("lets an agent read the shared state", async () => {
    expect((await call("GET", "/state", undefined, await keyFor("a"))).status).toBe(200);
  });

  it("rejects a key whose signature does not match its agent", async () => {
    const forged = (await keyFor("a")).replace(/^spa_a\./, "spa_b.");

    expect((await call("GET", "/state", undefined, forged)).status).toBe(401);
  });

  it("refuses the live dashboard socket to an agent key", async () => {
    const response = await handle(
      new Request("https://cq/live", { headers: { upgrade: "websocket", "sec-websocket-protocol": `spore, ${await keyFor("a")}` } }),
      deps,
    );

    expect(response.status).toBe(401);
  });
});

describe("mcp", () => {
  const rpc = async (method: string, params?: unknown, key = "secret") => {
    const response = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params }, key);
    return { status: response.status, body: (await response.json()) as { result?: any; error?: { code: number } } };
  };

  it("answers initialize with its tools capability", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });

    expect(body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "spore" } });
  });

  it("accepts the initialized notification without a body", async () => {
    const response = await call("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });

    expect(response.status).toBe(202);
  });

  it("lists the agent tools with input schemas", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name);

    expect(names).toEqual(expect.arrayContaining(["start_task", "report_push", "task_status", "touching", "why", "answer", "submit"]));
  });

  it("runs a tool through the same route as the HTTP API", async () => {
    const { body } = await rpc("tools/call", { name: "task_status", arguments: { taskId: "7" } });

    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ id: "7", agent: "a" });
  });

  it("submits without waiting for the merge", async () => {
    const { body } = await rpc("tools/call", { name: "submit", arguments: { taskId: "7", sha: SHA } });

    expect(JSON.parse(body.result.content[0].text)).toEqual({ status: "accepted", ahead: 2 });
  });

  it("returns a refused call as a tool error, with the route's message", async () => {
    const { body } = await rpc("tools/call", { name: "submit", arguments: { taskId: "7", sha: SHA } }, await agentKey("secret", "b"));

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("held by a");
  });

  it("starts a task as the key's agent", async () => {
    await rpc("tools/call", { name: "start_task", arguments: { goal: "g" } }, await agentKey("secret", "agent-1"));

    expect(started).toContainEqual(expect.objectContaining({ goal: "g", agent: "agent-1" }));
  });

  it("reports an unknown tool as a JSON-RPC error", async () => {
    const { body } = await rpc("tools/call", { name: "nope", arguments: {} });

    expect(body.error?.code).toBe(-32602);
  });

  it("reports an unknown method as a JSON-RPC error", async () => {
    const { body } = await rpc("resources/list");

    expect(body.error?.code).toBe(-32601);
  });

  it("tells a client that opens a server stream that there is none", async () => {
    expect((await call("GET", "/mcp")).status).toBe(405);
  });

  it("needs a key like every other route", async () => {
    expect((await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, null)).status).toBe(401);
  });
});
