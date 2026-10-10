# Spore demo

Everything here exists to show Spore working; none of it is needed to run Spore itself.

| Path | What it is |
| --- | --- |
| `sample/` | A small feature flag service with tests: the project the demo agents change |
| `reset.mjs` | Recreates the trunk repo from `sample/`, clears the integrator, and deletes the forks and push subscriptions earlier runs left behind |
| `swarm.mjs` | Nine scripted agents with pre-written edits and goal tests |
| `smoke.mjs` | A quick end-to-end check: two agents change the same line of trunk |
| `client.mjs` | The small HTTP and git helpers the scripts share |
| `video/` | The pipeline that records a run and builds the demo video |

## Run the swarm

Against a deployment set up as in the [main README](../README.md), with wrangler logged in to the same account:

```sh
export SPORE_URL=https://spore.<your-subdomain>.workers.dev SPORE_KEY=<the API key>
node demo/reset.mjs               # fresh trunk from demo/sample, empty integrator
node demo/swarm.mjs --resolve     # 9 agents push and submit, then watch the resolver drain the queue
```

Open the dashboard beside it to watch. A run takes about a minute and a half:

1. The agents fork trunk, push their work early and keep working for 25 seconds.
2. The integrator learns of each push from its event subscription. The three agents changing the same lines of `setFlag` are warned about each other, and so are the two setting the rate limit; the agent changing `listFlags` in the same file is not.
3. One `setFlag` agent goes next: it waits until the other two are merged or queued, rebuilds on the new trunk and merges cleanly.
4. agent-9 starts late on the health check agent-2 is already changing. The coordinator asks both whether their change there is required; both are, so agent-9's task goes to agent-2, which does it after its own change, on the new trunk.
5. Seven changes merge; two clashes become records in the queue.
6. The resolver fixes one with the model (both goals' tests pass) and escalates the other, two rate limits that cannot both hold, to a person, as a red card in the board's Conflict lane.

The agents are scripted so runs repeat: their edits are fixed, and their reports and submits leave 300 ms apart in a fixed order. The integrator, push events, merges, tests and the resolver's model call are all real.

## The video

`video/` records one real run against a deployment and builds the narrated video from it.

Needs ffmpeg, Playwright's Chromium (`npx playwright install chromium`), and an ElevenLabs API key in `ELEVENLABS_API_KEY` (or in `.dev.vars` at the repo root) for the narration.

| Step | Command | Writes |
| --- | --- | --- |
| Narration | `node demo/video/voice.mjs --voice <voice id>` | `video/out/voice/`: one clip per scene of `script.json`, with word timings |
| Cards | `node demo/video/render-card.mjs <code\|title\|architecture>` | `video/out/clips/`: the animated cards, timed to their narration |
| Recording | `node demo/video/record.mjs` (with `SPORE_URL` and `SPORE_KEY`) | `video/out/recording/`: the run at twice 1080p, its events, and where each part of the screen was |
| Check | `node demo/video/check-take.mjs` | Fails if the run did not do what the narration says; record again |
| Closing card | `node demo/video/render-card.mjs close` | Uses the finished dashboard from the recording |
| Video | `node demo/video/compose.mjs` | `video/out/spore-demo.mp4` |

The composer cuts each scene's footage to its narration, zooms into what the narration names, and adds captions and speed badges where footage plays faster than real time.
