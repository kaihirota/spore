import { Rejected, type ConflictRecord, type Integrator, type SubmitResult } from "../integrator/integrator";
import type { Resolution } from "../resolver/resolve";
import { handleMcp } from "./mcp";

type Async<T> = T extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

export type IntegratorApi = {
  startTask: Async<Integrator["startTask"]>;
  submit: (input: { taskId: string; forkSha: string; resolves?: number }) => Promise<SubmitResult>;
  /** Queues a submit and answers at once; the merge settles in the background. */
  accept: (input: { taskId: string; forkSha: string }) => Promise<{ status: "accepted"; ahead: number }>;
  claim: Async<Integrator["claim"]>;
  escalate: Async<Integrator["escalate"]>;
  record: Async<Integrator["record"]>;
  why: Async<Integrator["why"]>;
  reset: Async<Integrator["reset"]>;
  listTasks: Async<Integrator["listTasks"]>;
  listRecords: Async<Integrator["listRecords"]>;
  listMerges: Async<Integrator["listMerges"]>;
  fixFor: Async<Integrator["fixFor"]>;
  progress: Integrator["progress"];
  listInflight: Async<Integrator["listInflight"]>;
  task: Async<Integrator["task"]>;
  touching: Async<Integrator["touching"]>;
  decide: Integrator["decide"];
  answer: Integrator["answer"];
  forkOf: Async<Integrator["forkOf"]>;
};

export type GatewayDeps = {
  apiKey: string;
  dashboard: string;
  forkTrunk: (name: string) => Promise<{ remote: string; token: string }>;
  readToken: (repo: string) => Promise<string>;
  trunkAccess: () => Promise<{ remote: string; token: string }>;
  /** Routes the fork's push events to the integrator, so agents need not report their pushes; false when not set up. */
  watchFork: (repo: string) => Promise<boolean>;
  resolveFile: (input: { path: string; content: string; trunkGoal: string; incomingGoal: string }) => Promise<Resolution>;
  /** Opens a dashboard socket that receives the integrator's state whenever it changes. */
  live: (request: Request) => Promise<Response>;
  /** A write token for a task's fork, for the agent a task was handed to. */
  writeToken: (repo: string) => Promise<string>;
  integrator: IntegratorApi;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const bad = (message: string) => json({ error: message }, 400);

// Hashing both sides first keeps the comparison time independent of where the strings differ.
async function sameSecret(given: string, expected: string) {
  const digest = async (value: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).join(",");
  return (await digest(given)) === (await digest(expected));
}

const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An agent's own key: its name signed with the operator's API key, so nothing is stored and
 * rotating API_KEY revokes every agent key at once.
 */
export async function agentKey(apiKey: string, agent: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`agent:${agent}`)));
  return `spa_${agent}.${Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The operator (dashboard, scripts, people) or one named agent. */
export type Caller = { role: "operator" } | { role: "agent"; agent: string };

async function identify(given: string, apiKey: string): Promise<Caller | null> {
  if (!apiKey) return null;
  if (await sameSecret(given, apiKey)) return { role: "operator" };
  const agent = /^spa_([A-Za-z0-9_-]{1,64})\.[0-9a-f]{64}$/.exec(given)?.[1];
  if (agent && (await sameSecret(given, await agentKey(apiKey, agent)))) return { role: "agent", agent };
  return null;
}

// Settling records, resetting and minting keys are for the operator and Spore's own resolver.
function operatorOnly(method: string, parts: string[]) {
  if (method !== "POST") return false;
  const path = parts.join("/");
  return ["reset", "agents", "records/claim", "resolve-file"].includes(path)
    || (parts[0] === "records" && parts.length === 3 && (parts[2] === "escalate" || parts[2] === "decide"));
}

export async function handle(request: Request, deps: GatewayDeps): Promise<Response> {
  // The page holds no data; it reads the key from its URL fragment and calls the API with it.
  if (request.method === "GET" && new URL(request.url).pathname === "/") {
    return new Response(deps.dashboard, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  // Browsers cannot set headers on a WebSocket, so the dashboard sends the key as its second protocol.
  if (new URL(request.url).pathname === "/live" && request.headers.get("upgrade") === "websocket") {
    const key = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim())[1] ?? "";
    if ((await identify(key, deps.apiKey))?.role !== "operator") return json({ error: "unauthorized" }, 401);
    return deps.live(request);
  }
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const caller = await identify(given, deps.apiKey);
  if (!caller) return json({ error: "unauthorized" }, 401);
  return dispatch(request, deps, caller);
}

async function dispatch(request: Request, deps: GatewayDeps, caller: Caller): Promise<Response> {
  try {
    return await route(request, deps, caller);
  } catch (error) {
    // Durable Object RPC may rebuild errors as plain Error, so match the name too.
    if (error instanceof Rejected || (error instanceof Error && error.name === "Rejected")) return json({ error: error.message }, 409);
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

const forbidden = (message: string) => json({ error: message }, 403);

async function route(request: Request, deps: GatewayDeps, caller: Caller): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const text = (key: string) => (typeof body[key] === "string" && body[key] ? (body[key] as string) : null);

  if (caller.role === "agent" && operatorOnly(request.method, parts)) return forbidden("this route needs the operator key");
  // An agent key acts only as its own agent: a body naming another agent is refused, a body naming none means itself.
  const actingAs = (): { agent: string | null } | Response => {
    const named = text("agent");
    if (caller.role === "operator") return { agent: named };
    if (named && named !== caller.agent) return forbidden(`this key acts for ${caller.agent}, not ${named}`);
    return { agent: caller.agent };
  };
  // Submits and push reports need no agent in the body, so an agent key is checked against the task's holder.
  const holderCheck = async (taskId: string): Promise<Response | null> => {
    if (caller.role === "operator") return null;
    const task = await deps.integrator.task(taskId);
    if (!task) return json({ error: "no such task" }, 404);
    return task.agent === caller.agent ? null : forbidden(`task ${taskId} is held by ${task.agent}, not ${caller.agent}`);
  };

  // Tool results come back in the POST response, so there is no server-initiated stream to open.
  if (request.method === "GET" && url.pathname === "/mcp") return json({ error: "no server stream; POST JSON-RPC messages" }, 405);

  if (request.method === "POST" && url.pathname === "/mcp") {
    return handleMcp(body, (method, path, toolBody) =>
      dispatch(new Request(new URL(path, url), { method, body: toolBody && JSON.stringify(toolBody) }), deps, caller));
  }

  if (request.method === "POST" && url.pathname === "/agents") {
    const agent = text("agent");
    if (!agent || !AGENT_NAME.test(agent)) return bad("agent must be 1 to 64 letters, digits, - or _");
    return json({ agent, key: await agentKey(deps.apiKey, agent) });
  }

  if (request.method === "POST" && url.pathname === "/tasks") {
    const goal = text("goal");
    const as = actingAs();
    if (as instanceof Response) return as;
    const { agent } = as;
    if (!goal || !agent) return bad("goal and agent are required");
    const forkRepo = `task-${crypto.randomUUID().slice(0, 8)}`;
    const fork = await deps.forkTrunk(forkRepo);
    // Without a subscription the agent reports its pushes with POST /tasks/:id/progress instead.
    const watched = await deps.watchFork(forkRepo).catch((error) => {
      console.error(error);
      return false;
    });
    const [taskId, trunk] = await Promise.all([
      deps.integrator.startTask({ goal, agent, forkRepo, forkUrl: fork.remote }),
      deps.trunkAccess(),
    ]);
    return json({ taskId, remote: fork.remote, token: fork.token, trunkRemote: trunk.remote, trunkToken: trunk.token, watched });
  }

  if (request.method === "POST" && parts[0] === "tasks" && parts[2] === "submit" && parts.length === 3) {
    const refused = await holderCheck(parts[1]);
    if (refused) return refused;
    const sha = text("sha");
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return bad("sha must be a full 40-character commit SHA");
    const resolves = typeof body.resolves === "number" ? body.resolves : undefined;
    if (body.wait === false && resolves === undefined) return json(await deps.integrator.accept({ taskId: parts[1], forkSha: sha }));
    return json(await deps.integrator.submit({ taskId: parts[1], forkSha: sha, resolves }));
  }

  if (request.method === "POST" && url.pathname === "/records/claim") {
    const resolver = text("resolver");
    if (!resolver) return bad("resolver is required");
    const record: ConflictRecord | null = await deps.integrator.claim(resolver);
    if (!record) return new Response(null, { status: 204 });
    return json({ ...record, forkToken: await deps.readToken(record.forkRepo) });
  }

  if (request.method === "POST" && parts[0] === "records" && parts[2] === "escalate" && parts.length === 3) {
    const resolver = text("resolver");
    const reason = text("reason");
    if (!resolver || !reason) return bad("resolver and reason are required");
    await deps.integrator.escalate(Number(parts[1]), resolver, reason);
    return json({ status: "escalated" });
  }

  if (request.method === "GET" && url.pathname === "/tasks") return json(await deps.integrator.listTasks());

  if (request.method === "GET" && parts[0] === "tasks" && parts.length === 2) {
    const task = await deps.integrator.task(parts[1]);
    return task ? json(task) : json({ error: "no such task" }, 404);
  }

  if (request.method === "GET" && url.pathname === "/state") {
    const [tasks, records, merges, inflight] = await Promise.all([
      deps.integrator.listTasks(),
      deps.integrator.listRecords(),
      deps.integrator.listMerges(),
      deps.integrator.listInflight(),
    ]);
    return json({ tasks, records, merges, inflight });
  }

  if (request.method === "POST" && parts[0] === "tasks" && parts[2] === "answer" && parts.length === 3) {
    const as = actingAs();
    if (as instanceof Response) return as;
    const { agent } = as;
    if (!agent || typeof body.required !== "boolean") return bad("agent and required (true or false) are required");
    return json(await deps.integrator.answer(parts[1], agent, body.required, text("reason") ?? ""));
  }

  if (request.method === "POST" && parts[0] === "tasks" && parts[2] === "access" && parts.length === 3) {
    const as = actingAs();
    if (as instanceof Response) return as;
    const { agent } = as;
    if (!agent) return bad("agent is required");
    const fork = await deps.integrator.forkOf(parts[1], agent);
    const [token, trunk] = await Promise.all([deps.writeToken(fork.repo), deps.trunkAccess()]);
    return json({ remote: fork.url, token, trunkRemote: trunk.remote, trunkToken: trunk.token });
  }

  if (request.method === "POST" && parts[0] === "tasks" && parts[2] === "progress" && parts.length === 3) {
    const refused = await holderCheck(parts[1]);
    if (refused) return refused;
    const sha = text("sha");
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return bad("sha must be a full 40-character commit SHA");
    return json(await deps.integrator.progress(parts[1], sha));
  }

  if (request.method === "GET" && url.pathname === "/touching") {
    const path = url.searchParams.get("path");
    if (!path) return bad("path is required");
    return json(await deps.integrator.touching(path, url.searchParams.get("symbol") ?? undefined));
  }

  if (request.method === "POST" && parts[0] === "records" && parts[2] === "decide" && parts.length === 3) {
    const keep = text("keep");
    if (keep !== "trunk" && keep !== "incoming") return bad("keep must be trunk or incoming");
    return json(await deps.integrator.decide(Number(parts[1]), keep));
  }

  if (request.method === "GET" && url.pathname === "/records") {
    const states = url.searchParams.get("state")?.split(",") as ConflictRecord["state"][] | undefined;
    return json(await deps.integrator.listRecords(states));
  }

  if (request.method === "GET" && parts[0] === "records" && parts.length === 2) {
    const id = Number(parts[1]);
    const record = await deps.integrator.record(id);
    return record ? json({ ...record, fix: await deps.integrator.fixFor(id) }) : json({ error: "no such record" }, 404);
  }

  if (request.method === "POST" && url.pathname === "/resolve-file") {
    const [path, content, trunkGoal, incomingGoal] = ["path", "content", "trunkGoal", "incomingGoal"].map(text);
    if (!path || !content || !trunkGoal || !incomingGoal) return bad("path, content, trunkGoal and incomingGoal are required");
    return json(await deps.resolveFile({ path, content, trunkGoal, incomingGoal }));
  }

  if (request.method === "POST" && url.pathname === "/reset") {
    await deps.integrator.reset();
    return json({ status: "reset" });
  }

  if (request.method === "GET" && url.pathname === "/why") {
    const path = url.searchParams.get("path");
    if (!path) return bad("path is required");
    return json(await deps.integrator.why(path));
  }

  return json({ error: "not found" }, 404);
}
