import { DurableObject } from "cloudflare:workers";
import dashboard from "./dashboard/dashboard.html";
import { pushToMain, subscriptionRequest } from "./integrator/events";
import { handle } from "./api/gateway";
import { conflictsWith, inspectFork, trunkClashes } from "./integrator/inflight";
import { ANSWER_TIMEOUT_MS, Integrator, Rejected, notifyOnWrite, type Handovers, type MergeFn, type Watcher } from "./integrator/integrator";
import { dropChange, flattenOntoTrunk } from "./git/handover";
import { mergeIntoTrunk } from "./git/merge";
import { resolveNext, type ResolverDeps } from "./resolver/resolver";
import { buildJudgePrompt, buildResolvePrompt, parseJudgement, parseResolution } from "./resolver/resolve";
import { quote, TIMED_OUT, type Shell } from "./git/shell";

const decoder = new TextDecoder();

// The integrator's own container is the warm merge runner for its repo.
function containerShell(container: Container): Shell {
  return async (command, options = {}) => {
    // coreutils timeout signals its whole process group, so nothing the command started survives it.
    const seconds = options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : 0;
    const wrapped = seconds ? `timeout -s KILL ${seconds} bash -c ${quote(command)}` : command;
    for (let attempt = 1; ; attempt++) {
      if (!container.running) {
        container.start({ image: Object.values(container.images)[0], enableInternet: true, entrypoint: ["sleep", "infinity"] });
      }
      try {
        const process = await container.exec(["bash", "-c", wrapped], { cwd: options.cwd ?? "/workspace" });
        const output = await process.output();
        const stdout = decoder.decode(output.stdout);
        const stderr = decoder.decode(output.stderr);
        if (seconds && output.exitCode === 137) return { exitCode: TIMED_OUT, stdout, stderr: `${stderr}\ntimed out after ${seconds} s` };
        return { exitCode: output.exitCode, stdout, stderr };
      } catch (error) {
        // ponytail: fixed retry while the container boots or restarts; watch readiness if starts get slower
        if (attempt >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };
}

async function forkTrunk(env: Env, name: string) {
  using trunk = await env.ARTIFACTS.get(env.TRUNK_REPO);
  const fork = await trunk.fork(name);
  return { remote: fork.remote, token: fork.token };
}

async function resolveWithModel(env: Env, input: Parameters<typeof buildResolvePrompt>[0]) {
  const reply = (await env.AI.run(env.RESOLVER_MODEL as keyof AiModels, {
    messages: buildResolvePrompt(input),
    temperature: 0,
    max_completion_tokens: 16000,
  } as never)) as { choices?: { message?: { content?: string } }[] };
  const text = reply.choices?.[0]?.message?.content;
  if (!text) throw new Error(`model ${env.RESOLVER_MODEL} returned no content`);
  return parseResolution(text);
}

async function judgeWithModel(env: Env, goalA: string, goalB: string) {
  const reply = (await env.AI.run(env.RESOLVER_MODEL as keyof AiModels, {
    messages: buildJudgePrompt(goalA, goalB),
    temperature: 0,
    max_completion_tokens: 400,
  } as never)) as { choices?: { message?: { content?: string } }[] };
  return parseJudgement(reply.choices?.[0]?.message?.content ?? "");
}

// Resolvers work on records with no file in common, so one repo's clashes are fixed in parallel.
const RESOLVERS = 4;

export class IntegratorObject extends DurableObject<Env> {
  private integrator: Integrator;
  private resolvers: ResolverDeps[];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("IntegratorObject needs its container configured in wrangler.jsonc");
    const shell = containerShell(ctx.container);
    const workdir = "/workspace/trunk";
    // Short-lived tokens per operation: trunk write only for merges, read for everything else.
    const access = async (forkRepo: string, trunkScope: "read" | "write") => {
      using trunk = await env.ARTIFACTS.get(env.TRUNK_REPO);
      using fork = await env.ARTIFACTS.get(forkRepo);
      const [info, trunkToken, forkToken] = await Promise.all([trunk.info(), trunk.createToken(trunkScope, 600), fork.createToken("read", 600)]);
      return { trunkUrl: info.remote, trunkToken: trunkToken.plaintext, forkToken: forkToken.plaintext };
    };
    const merge: MergeFn = async (req) => {
      const { trunkUrl, trunkToken, forkToken } = await access(req.forkRepo, "write");
      return mergeIntoTrunk({
        ...req,
        shell,
        workdir,
        trunkUrl,
        // Fork code runs as an unprivileged user that can read the working copy but not change it.
        testCommand: `runuser -u runner -- env HOME=/home/runner bash -c ${quote(env.TEST_COMMAND)}`,
        trunkToken,
        forkToken,
      });
    };
    const watcher: Watcher = {
      inspect: async (req) => inspectFork({ ...req, shell, workdir, ...(await access(req.forkRepo, "read")) }),
      conflicts: (sha, others) => conflictsWith({ shell, workdir, sha, others }),
      trunkClashes: (sha) => trunkClashes({ shell, workdir, sha }),
    };
    // Verdicts work on the task's fork in their own working copy, with a short-lived write token for it.
    const forkAccess = async (forkRepo: string) => {
      const { trunkUrl, trunkToken } = await access(forkRepo, "read");
      using fork = await env.ARTIFACTS.get(forkRepo);
      return { trunkUrl, trunkToken, forkToken: (await fork.createToken("write", 600)).plaintext };
    };
    const handoverRun = {
      shell,
      workdir: "/workspace/handover",
      testCommand: `runuser -u runner -- env HOME=/home/runner bash -c ${quote(env.TEST_COMMAND)}`,
    };
    const handovers: Handovers = {
      drop: async (req) => dropChange({ ...handoverRun, ...req, ...(await forkAccess(req.forkRepo)) }),
      flatten: async (req) => flattenOntoTrunk({
        ...handoverRun, ...req, ...(await forkAccess(req.forkRepo)),
        message: `Task ${req.taskId}: ${req.goal}`, trailers: { Task: req.taskId },
      }),
    };
    this.integrator = new Integrator(
      notifyOnWrite((query, ...params) => ctx.storage.sql.exec(query, ...(params as SqlStorageValue[])).toArray(), () => this.stateChanged()),
      merge,
      Date.now,
      watcher,
      handovers,
    );
    // Each resolver shares the container but has its own working copy and stays outside the merge queue.
    this.resolvers = Array.from({ length: RESOLVERS }, (_, i): ResolverDeps => ({
      name: `resolver-${i + 1}`,
      shell,
      workdir: `/workspace/resolver-${i + 1}`,
      claim: async (name) => this.integrator.claim(name),
      claimAlso: async (name, id) => this.integrator.claimAlso(name, id),
      release: async (id, name) => this.integrator.release(id, name),
      escalate: async (id, name, reason) => this.integrator.escalate(id, name, reason),
      startFork: async (goal, resolves) => {
        const forkRepo = `task-${crypto.randomUUID().slice(0, 8)}`;
        const fork = await forkTrunk(env, forkRepo);
        return { taskId: this.integrator.startTask({ goal, agent: `resolver-${i + 1}`, forkRepo, forkUrl: fork.remote, resolves }), ...fork };
      },
      forkReadToken: async (repo) => (await access(repo, "read")).forkToken,
      resolveFile: (input) => resolveWithModel(env, input),
      submit: (input) => this.submit(input),
    }));
  }

  /** A dashboard socket: hibernates between messages and gets the full state now and on every change. */
  async fetch(request: Request) {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.integrator.snapshot()));
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "spore" } });
  }

  // Writes come in bursts during a merge; one broadcast per burst, and only when the state differs.
  private broadcastPending = false;
  private lastBroadcast = "";
  private stateChanged() {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    setTimeout(() => {
      this.broadcastPending = false;
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return;
      const state = JSON.stringify(this.integrator.snapshot());
      if (state === this.lastBroadcast) return;
      this.lastBroadcast = state;
      for (const socket of sockets) {
        try { socket.send(state); } catch { socket.close(1011, "send failed"); }
      }
    }, 100);
  }

  startTask(input: Parameters<Integrator["startTask"]>[0]) { return this.integrator.startTask(input); }
  async submit(input: Parameters<Integrator["submit"]>[0]) {
    const result = await this.integrator.submit(input);
    if (result.status === "queued") await this.wakeResolver();
    return result;
  }

  accept(input: Parameters<Integrator["accept"]>[0]) {
    const { reply, done } = this.integrator.accept(input);
    this.ctx.waitUntil(done.then((result) => (result.status === "queued" ? this.wakeResolver() : undefined)).catch((error) => console.error(error)));
    return reply;
  }

  private async wakeResolver() {
    if (this.env.RESOLVER !== "on") return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 500);
  }

  /** Works through the conflict queue until every resolver is idle and none can claim a record; a failure is retried by the alarm. */
  async alarm() {
    await this.integrator.settleDue();
    // An idle resolver keeps polling while another works: records keep arriving, and a held-back one frees up when its file's fix lands.
    let busy = 0;
    await Promise.all(this.resolvers.map(async (resolver) => {
      for (;;) {
        busy++;
        const outcome = await resolveNext(resolver).finally(() => busy--);
        if (outcome !== "empty") continue;
        if (busy === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }));
  }
  claim(resolver: string) { return this.integrator.claim(resolver); }
  escalate(recordId: number, resolver: string, reason: string) { return this.integrator.escalate(recordId, resolver, reason); }
  listTasks() { return this.integrator.listTasks(); }
  listRecords(states?: Parameters<Integrator["listRecords"]>[0]) { return this.integrator.listRecords(states); }
  listMerges() { return this.integrator.listMerges(); }
  fixFor(recordId: number) { return this.integrator.fixFor(recordId); }
  async progress(taskId: string, sha: string) {
    const result = await this.integrator.progress(taskId, sha);
    this.judgeClashes();
    await this.wakeForAnswers();
    return result;
  }

  // An agent that never answers counts as needing its change once the time is up; the alarm settles it.
  private async wakeForAnswers() {
    if (!this.integrator.hasOpenQuestions()) return;
    const due = Date.now() + ANSWER_TIMEOUT_MS + 500;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  // Each new pair of clashing tasks is judged once, in the background so merges never wait on the model.
  private judging = false;
  private judgeClashes() {
    if (this.judging) return;
    this.judging = true;
    this.ctx.waitUntil((async () => {
      try {
        for (let pairs = this.integrator.pairsToJudge(); pairs.length > 0; pairs = this.integrator.pairsToJudge()) {
          for (const pair of pairs) {
            const { contradicts, reason } = await judgeWithModel(this.env, pair.goalA, pair.goalB);
            this.integrator.recordJudgement(pair.a, pair.b, contradicts, reason);
          }
        }
      } catch (error) {
        // An unjudged pair is tried again on the next push; until then the resolver handles it as usual.
        console.error(error);
      } finally {
        this.judging = false;
      }
    })());
  }
  listInflight() { return this.integrator.listInflight(); }
  touching(path: string, symbol?: string) { return this.integrator.touching(path, symbol); }
  task(id: string) { return this.integrator.task(id); }

  /** A push to a task's fork, from its event subscription. Pushes to forks without a live task are ignored. */
  async onPush(repo: string, sha: string) {
    const taskId = this.integrator.taskForFork(repo);
    if (!taskId) return "ignored";
    try {
      await this.integrator.progress(taskId, sha);
      this.judgeClashes();
      await this.wakeForAnswers();
      return "recorded";
    } catch (error) {
      if (error instanceof Rejected || (error instanceof Error && error.name === "Rejected")) return "ignored";
      throw error;
    }
  }
  decide(recordId: number, keep: "trunk" | "incoming") { return this.integrator.decide(recordId, keep); }
  record(id: number) { return this.integrator.record(id); }
  why(path: string) { return this.integrator.why(path); }
  answer(taskId: string, agent: string, required: boolean, reason: string) { return this.integrator.answer(taskId, agent, required, reason); }
  forkOf(taskId: string, agent: string) { return this.integrator.forkOf(taskId, agent); }
  // A fresh container on reset also picks up an image deployed while the old one stayed warm.
  async reset() {
    this.integrator.reset();
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}

export default {
  fetch(request, env) {
    const integrator = env.INTEGRATOR.get(env.INTEGRATOR.idFromName(env.TRUNK_REPO));
    return handle(request, {
      apiKey: env.API_KEY,
      dashboard,
      integrator,
      forkTrunk: (name) => forkTrunk(env, name),
      resolveFile: (input) => resolveWithModel(env, input),
      live: (request) => integrator.fetch(request),
      watchFork: async (repo) => {
        // Without these secrets, forks are not watched and agents report pushes with POST /tasks/:id/progress.
        const { CF_API_TOKEN: token, ACCOUNT_ID: account, PUSH_QUEUE_ID: queueId } = env as { CF_API_TOKEN?: string; ACCOUNT_ID?: string; PUSH_QUEUE_ID?: string };
        if (!token || !account || !queueId) return false;
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/event_subscriptions/subscriptions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(subscriptionRequest({ namespace: env.ARTIFACTS_NAMESPACE, repo, queueId })),
        });
        if (!response.ok) throw new Error(`subscribing to pushes on ${repo} failed: ${response.status} ${await response.text()}`);
        return true;
      },
      trunkAccess: async () => {
        using trunk = await env.ARTIFACTS.get(env.TRUNK_REPO);
        const [info, token] = await Promise.all([trunk.info(), trunk.createToken("read", 3600)]);
        return { remote: info.remote, token: token.plaintext };
      },
      readToken: async (repo) => {
        using handle = await env.ARTIFACTS.get(repo);
        return (await handle.createToken("read", 3600)).plaintext;
      },
      writeToken: async (repo) => {
        using handle = await env.ARTIFACTS.get(repo);
        return (await handle.createToken("write", 3600)).plaintext;
      },
    });
  },
  async queue(batch, env) {
    const integrator = env.INTEGRATOR.get(env.INTEGRATOR.idFromName(env.TRUNK_REPO));
    for (const message of batch.messages) {
      const push = pushToMain(message.body);
      if (!push) {
        message.ack();
        continue;
      }
      try {
        await integrator.onPush(push.repo, push.sha);
        message.ack();
      } catch (error) {
        console.error(`push ${push.repo}@${push.sha} failed`, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
