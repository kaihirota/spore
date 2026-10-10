/**
 * Spore's API as MCP tools over streamable HTTP, answered as plain JSON. Each tool call is replayed
 * as the matching HTTP request, so it gets the same validation and the same agent-key permissions.
 */

type Send = (method: string, path: string, body?: Record<string, unknown>) => Promise<Response>;
type Args = Record<string, unknown>;

const PROTOCOL = "2025-06-18";
const str = { type: "string" };
const taskId = { taskId: { ...str, description: "The task id start_task returned" } };
const sha = { sha: { ...str, description: "Full 40-character commit SHA you pushed to the task's fork" } };

const TOOLS: { name: string; description: string; properties: Args; required: string[]; request: (a: Args) => [string, string, Args?] }[] = [
  {
    name: "start_task",
    description: "Start a task: forks trunk and returns the fork's git remote and write token, and trunk's remote with a read token.",
    properties: { goal: { ...str, description: "One sentence saying what the change achieves" } },
    required: ["goal"],
    request: (a) => ["POST", "/tasks", { goal: a.goal }],
  },
  {
    name: "report_push",
    description: "Report a commit pushed to the task's fork; returns what it changes and which agents in flight or trunk tasks it would clash with.",
    properties: { ...taskId, ...sha },
    required: ["taskId", "sha"],
    request: (a) => ["POST", `/tasks/${a.taskId}/progress`, { sha: a.sha }],
  },
  {
    name: "task_status",
    description: "One task: its state, its latest push, who it clashes with, and any question or verdict from the coordinator.",
    properties: taskId,
    required: ["taskId"],
    request: (a) => ["GET", `/tasks/${a.taskId}`],
  },
  {
    name: "list_tasks",
    description: "Every task with its agent, goal and state.",
    properties: {},
    required: [],
    request: () => ["GET", "/tasks"],
  },
  {
    name: "touching",
    description: "Who is changing a file or one function in it: agents in flight, queued conflicts, and recent merges.",
    properties: { path: str, symbol: { ...str, description: "Optional function name" } },
    required: ["path"],
    request: (a) => ["GET", `/touching?path=${encodeURIComponent(String(a.path))}${a.symbol ? `&symbol=${encodeURIComponent(String(a.symbol))}` : ""}`],
  },
  {
    name: "why",
    description: "Each trunk change to a file, with its goal, agent and the conflict record it came through.",
    properties: { path: str },
    required: ["path"],
    request: (a) => ["GET", `/why?path=${encodeURIComponent(String(a.path))}`],
  },
  {
    name: "answer",
    description: "Answer the coordinator's question on a task: is your change to the named lines required for your goal?",
    properties: { ...taskId, required: { type: "boolean" }, reason: str },
    required: ["taskId", "required", "reason"],
    request: (a) => ["POST", `/tasks/${a.taskId}/answer`, { required: a.required, reason: a.reason }],
  },
  {
    name: "task_access",
    description: "For a task handed to you: its fork's remote and a write token, and trunk read access.",
    properties: taskId,
    required: ["taskId"],
    request: (a) => ["POST", `/tasks/${a.taskId}/access`, {}],
  },
  {
    name: "submit",
    description: "Submit the pushed commit and move on: it is queued for merging, and a clash goes to a resolver. task_status shows how it ended.",
    properties: { ...taskId, ...sha },
    required: ["taskId", "sha"],
    request: (a) => ["POST", `/tasks/${a.taskId}/submit`, { sha: a.sha, wait: false }],
  },
];

const INSTRUCTIONS = "Spore workflow: start_task, clone the fork, commit your change with a goal test at "
  + "test/goals/<taskId>.test.js, push early and report_push, answer any coordinator question, then submit and move on.";

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Args };

const reply = (id: Message["id"], result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const failure = (id: Message["id"], code: number, message: string) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleMcp(message: Message, send: Send): Promise<Response> {
  const { id, method, params = {} } = message;
  // Notifications carry no id and get no reply.
  if (id === undefined) return new Response(null, { status: 202 });
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL;
    return reply(id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: "spore", version: "1.0.0" }, instructions: INSTRUCTIONS });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.properties, required: t.required } })),
    });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) return failure(id, -32602, `unknown tool ${String(params.name)}`);
    const args = (params.arguments ?? {}) as Args;
    const missing = tool.required.filter((key) => args[key] === undefined);
    if (missing.length) return failure(id, -32602, `${tool.name} needs ${missing.join(", ")}`);
    const response = await send(...tool.request(args));
    const text = response.status === 204 ? "{}" : await response.text();
    return reply(id, { content: [{ type: "text", text }], isError: !response.ok });
  }
  return failure(id, -32601, `method ${String(method)} is not supported`);
}
