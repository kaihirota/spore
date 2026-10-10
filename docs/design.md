# Spore design

Spore lets a swarm of agents change one codebase without anyone waiting: agents learn who else is changing the same lines while they work, clean changes merge into trunk as soon as their tests pass, and every remaining clash becomes queued work for resolver agents, so a human sees only the conflicts no agent can settle.

## The bet

At swarm scale, conflicts are normal traffic, so Spore treats them as work to route and to see coming, not errors to stop on.

- **GitHub model:** a conflict halts the author until a human rebases. With thousands of agents, most of the swarm would be waiting.
- **Lock model:** agents claim files up front, overlapping claims block, and one winner merges while the others are abandoned. Claims are guesses, two agents editing different functions in one file still collide, and losing work is thrown away.
- **Spore:** coordination comes from what agents actually push, never from claims. Git decides what conflicts, down to the line. Agents are warned while they work, clean changes merge immediately, and every real clash is kept as a record that a resolver agent turns into a fix. No change is discarded and no author waits on a conflict.

## At a glance

![Change flow: an agent pushes to its fork and gets a reply at once; the integrator merges and runs the tests; a clean, passing change advances trunk; otherwise the conflict is queued, a resolver claims it and its fix takes the same path, and contradicting goals or two failed fixes go to a person who picks a goal.](flow.svg)

Every submit gets an answer immediately; a clash loops through resolvers until it merges, and a person sees it only when the goals contradict, a resolver gives up, or two fixes fail.

![Components: agents push to their own Artifacts forks and call the gateway Worker; push events reach the integrator Durable Object through a Queue; the integrator holds in-flight changes, the coordinator, the conflict queue and the resolver; its container fetches forks, merges and tests, and is the only writer of trunk; the resolver calls Workers AI; the dashboard shows live state and a person settles escalated cards.](components.svg)

Agents only push to their own forks and call the gateway; their pushes reach the integrator as events, and the integrator alone, through its container, writes trunk; its resolver settles queued conflicts with Workers AI.

## Who is touching x

Any agent can ask who is changing a file or one function right now, and is warned automatically when another agent's in-flight work would conflict with its own, before either submits.

1. Agents push work in progress to their own fork early and keep working.
2. Each fork has an Artifacts event subscription for its pushes, delivered to the `spore-pushes` Queue. Artifacts offers push events per repo only, so `POST /tasks` subscribes each new fork as it creates it, through the REST API, since the Artifacts binding cannot create subscriptions.
3. The queue consumer hands the push to the integrator, which fetches the commit in its container and lists every change: file, line range, and the enclosing function from git's hunk context.
4. It test-merges that commit against every other in-flight agent touching the same files, using `git merge-tree`, which needs no checkout. A predicted conflict is recorded as a warning on both agents. The commit is also test-merged against trunk, and after every merge the in-flight agents on the merged files are checked again, so an agent learns when trunk already changed its lines and who changed them. Every warning is advice, never a lock.
5. An agent reads its own warnings with `GET /tasks/:id`. It can go next: wait until the agents it clashes with are merged or queued, rebuild its change on the new trunk, and merge cleanly without entering the queue.

`GET /touching?path=src/flags.js&symbol=setFlag` answers the question directly, in three groups: agents in flight changing that file or function, conflicts waiting on it, and its recent merges with their goals.

Because git decides, two agents in different functions of one file are never warned about each other. Push events take 6 to 10 s to arrive, so warnings reach agents while they are still working, not instantly. `POST /tasks/:id/progress` reports a push directly where no event subscription exists.

## Coordinator

Warnings tell two agents they will clash; the coordinator decides when the clash is cheaper to avoid than to resolve. It asks when a task's first push lands on lines another agent committed to at least five seconds earlier, a newcomer meeting established work; agents that start on the same lines together get warnings only.

1. **Ask.** Each agent in the clash is asked whether its change there is required for its task, and answers with a reason (`POST /tasks/:id/answer`).
2. **Decide.** Once every agent has answered, or 20 seconds pass (silence counts as required), the coordinator gives each a verdict:
   - **Optional:** drop that change. Spore removes the task's hunks in that function from its branch.
   - **Required by one:** continue; that agent owns the lines.
   - **Required by several:** the agent that committed first continues; the others hand their whole tasks to it, so one agent makes the changes in sequence.
   - **Goals that contradict:** continue, for a person to settle at merge.
3. **Check, then carry out.** Every verdict runs in the integrator's container and runs the tests without the task's own goal test, which is unfinished by definition. A drop is pushed to the task's fork only if the tests pass. A handover squashes the task's work onto current trunk as one commit and pushes it to the fork only if the tests pass; then the task moves. A refused verdict leaves the task where it is.
4. **Receive.** The receiving agent gets each handed task's fork with `POST /tasks/:id/access`, applies the one commit after its own work, and submits it like any task; the integrator's merge and full test run is the after check. Warnings between two tasks one agent holds are dropped, since it does them in sequence.

All of it goes through the coordinator in the repository's integrator, never agent to agent: it orders concurrent verdicts, agents need no way to reach each other, and every question, answer and verdict is recorded.

- **Contradictions:** when two in-flight tasks clash, the integrator's Durable Object asks Workers AI, in the background, whether one change could satisfy both goals. If not, both cards say so, and a record between them goes straight to a person without a resolver run. An unclear answer counts as compatible, so the resolver and the goal tests remain the check.

## Integrator

One integrator per repo, a Durable Object with its own container, takes submits one at a time and either merges them into trunk or files a conflict; trunk only moves forward.

1. An agent calls `submit` with the full SHA of its pushed commit.
2. The integrator takes it in arrival order. In its container it syncs trunk, fetches the fork, and does a three-way merge; git finds the base, since every fork shares trunk's history.
3. **Already in trunk:** a commit with nothing new returns `already_in_trunk` and trunk is untouched.
4. **Clean merge:** the repo's tests run on the merged tree, including the goal test each agent ships with its change. Pass: the merge commit is pushed to trunk with `Task:` and `Resolves:` trailers. Fail: a conflict record of kind `tests`.
5. **Textual clash:** a conflict record of kind `merge` with the hunks, naming the trunk task whose lines collide (blamed along trunk's first parents onto the integrator's merge commits).
6. The agent gets `merged` or `queued #N` and moves on; a queued change never comes back to its author.

Safety: the integrator alone holds a trunk write token, minted for 10 minutes per merge. Agents and resolvers get write tokens for their own forks and read tokens for trunk. Fork code runs its tests as an unprivileged user that can read but not change the working copy, git hooks are disabled, and a test run is killed after 5 minutes.

Throughput: one merge and test run at a time per repo, about 3 to 4 s warm on the sample project. Batching queued submits and bisecting on failure is the upgrade for larger repos.

## Conflict queue

Each conflict is a durable record holding everything a resolver needs, so the author is never asked again.

| Field | Holds |
| --- | --- |
| `id` | Sequence number per repo, e.g. #2 |
| `kind` | `merge` (git clash) or `tests` (clean merge, failing tests) |
| `goal`, `clashingGoal` | The incoming task's goal, and the goals of the trunk changes its lines collide with |
| `clashingTasks` | The ids of those trunk tasks |
| `forkRepo`, `forkUrl`, `forkSha` | Where the incoming change lives |
| `files`, `detail` | Conflicting files and hunks, or the failing test output |
| `state` | `open`, `claimed`, `merged`, `escalated`, `dismissed` |
| `attempts`, `reason` | Failed fixes so far and the latest reason |

Rules:

- A resolver claims the oldest open record for a 10 minute lease; an expired lease reopens it.
- Only the resolver holding the claim may submit a fix or escalate. A fix is an ordinary submit, so it goes through the same merge and tests.
- A failed fix reopens the record with the failing tests as its reason; a second failure escalates it.
- A human settles an escalated record: keep trunk (the record is dismissed) or take incoming (the change is merged preferring its side, the losing goal's test is dropped since that goal lost, and every other test still runs).

The record is the context log too: `GET /why?path=` returns each trunk change to a file with its goal, its agent and the record it came through.

## Resolver agents

The resolver turns conflict records into fixes that pass every goal's test. It is the part a lock-based design cannot have, and it runs on Cloudflare.

- **When it runs:** a queued conflict sets an alarm on the integrator's Durable Object, and the alarm runs four resolvers until the queue is empty and all four are idle. A reopened record, after a failed fix, sets it again.
- **Who takes what:** a resolver claims the oldest record whose files no other resolver is fixing, plus the untried records on the same files, and settles them in one fix: it merges each incoming change in turn, so a burst of clashes on one hot file costs one fork, one push and one test run. A record the model cannot settle is escalated alone; if it is the first of the batch, the rest go back to the queue.
- **Where it works:** in the integrator's container, in its own working copy and outside the merge queue, so merges never wait on a model call. It forks current trunk, fetches each incoming change, and merges with conflict context from the common ancestor.
- **Model:** Workers AI (`@cf/moonshotai/kimi-k2.7-code`) rewrites each conflicted file so both goals hold, given both goals and the file with its conflict markers, or answers `ESCALATE: <reason>` when the goals contradict.
- **Goal tests decide:** the fix is an ordinary submit, so it merges only if every agent's goal test passes. A model that silently picks one side of a contradiction fails the other goal's test, the record reopens, and a second failure escalates it.
- **Shown in full:** the dashboard opens a record as three panes: the trunk side with its goal, the incoming side with its goal, and the resolver's fix.
- **Limits:** a hot file's records are still fixed one after another; records from failing tests are escalated rather than sent to the model; one model decision takes about 3 to 25 s.

## Agent interface

Agents use plain git plus a small HTTP API behind one key; only `submit` waits, and only for one merge and test run.

| Call | Used by | Returns |
| --- | --- | --- |
| `POST /tasks` | Agent | Fork remote and its write token, trunk remote and a read token |
| `GET /tasks/:id` | Agent | Its state and in-flight entry: what its latest push changes and who it would clash with |
| `GET /touching?path=&symbol=` | Any agent | Agents in flight on that file or function, conflicts waiting on it, recent merges |
| `POST /tasks/:id/answer` | Agent holding the task | Its answer to the coordinator's question: `waiting`, or `decided` once all have answered |
| `POST /tasks/:id/access` | Agent holding the task | Its fork and a write token, after a handover |
| `POST /tasks/:id/submit` | Agent | `merged`, `queued #N` or `already_in_trunk` |
| `POST /records/claim` | Resolver | Oldest open record with both goals, the hunks and a read token for the incoming fork |
| `POST /records/:id/escalate` | Resolver holding the claim | `escalated` |
| `POST /records/:id/decide` | Human | `dismissed` (keep trunk) or the result of merging the incoming side |
| `GET /why?path=` | Any agent | Each trunk change to the file: goal, agent and the record it came through |

The dashboard gets its state over the `GET /live` WebSocket, which carries the same tasks, in-flight agents, records and recent merges as `GET /state`, now and whenever they change. The built-in resolver calls the integrator directly; the claim and escalate routes let other resolvers run elsewhere.

## Dashboard

One live page, served by the Worker at `/`, shows the work as a board; each card is one agent's work in a column, and the person acts only on escalated cards.

- **In Progress:** one card per agent, its tasks as lines with the functions they change and the agents they would clash with; agents whose tasks clash sit next to each other, and the coordinator's question and verdict show on each card.
- **Review, Merging:** each agent's submitted tasks while the integrator merges and tests them.
- **Review, Conflict:** each record, assigned to the resolver, with both goals and its state; an escalated record shows the reason and Keep trunk, Take incoming and View.
- **Done (Trunk):** each merge is a stop on the trunk line, newest first; a resolved conflict curves back onto the line.
- **Record view:** trunk side, incoming side and the resolver's fix, next to each other.

The integrator's Durable Object pushes the state to open pages over a hibernating WebSocket once per burst of writes; a page polls `GET /state` only while its socket is down, and re-renders only when something changed, so keyboard focus holds. The API key travels in the URL fragment, which the browser never sends to the server.

## Built on Cloudflare

Git storage, events, state, execution and the model are Cloudflare products; Spore's own code is the integrator, the in-flight tracking, the resolver and the page.

| Component | Product | Use |
| --- | --- | --- |
| Trunk and forks | [Artifacts](https://developers.cloudflare.com/artifacts/) | Trunk repo, one fork per task, repo-scoped read and write tokens |
| Push detection | Artifacts event subscriptions + Queues | One subscription per fork delivers its pushes to `spore-pushes` |
| Integrator | Durable Objects (SQLite) | One per repo: serializes merges and inspections, stores tasks, in-flight changes, warnings, records and merge history; its alarm runs the resolver |
| Merge and inspection runner | Containers | The integrator's own container runs git, the tests and the resolver's merges; Artifacts has no server-side merge |
| Resolver model | Workers AI | Rewrites a conflicted file to meet both goals, or escalates; judges whether two clashing goals contradict |
| Gateway and dashboard | Workers | HTTP API behind one key, the dashboard page |

Artifacts, Containers and Workers AI need the Workers Paid plan; Artifacts billing starts 2026-10-14 ([pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).
