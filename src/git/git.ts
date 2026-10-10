import { quote, type Shell } from "./shell";

// Hooks are off because fork code runs in this working copy and could plant one to steal the trunk token.
const GIT = "git -c core.hooksPath=/dev/null -c user.name=integrator -c user.email=integrator@spore";

export type Git = {
  run: (args: string, token?: string) => ReturnType<Shell>;
  must: (args: string, token?: string) => Promise<string>;
};

/** Git commands in the integrator's working copy, authenticated with trunkToken unless another token is given. */
export function gitIn(shell: Shell, workdir: string, trunkToken?: string): Git {
  const auth = (token?: string) => (token ? `-c http.extraHeader=${quote(`Authorization: Bearer ${token}`)} ` : "");
  const run = (args: string, token = trunkToken) => shell(`${GIT} ${auth(token)}${args}`, { cwd: workdir });
  const must = async (args: string, token?: string) => {
    const result = await run(args, token);
    if (result.exitCode !== 0) throw new Error(`git ${args.split(" ")[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  return { run, must };
}

/** Clones trunk on first use, then resets the working copy to trunk's tip and returns that commit. */
export async function syncTrunk(shell: Shell, git: Git, workdir: string, trunkUrl: string, trunkToken?: string) {
  if ((await shell(`test -d ${quote(`${workdir}/.git`)}`)).exitCode !== 0) {
    const auth = trunkToken ? `-c http.extraHeader=${quote(`Authorization: Bearer ${trunkToken}`)} ` : "";
    const clone = await shell(`${GIT} ${auth}clone -q ${quote(trunkUrl)} ${quote(workdir)}`);
    if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.trim()}`);
  }
  await git.must("fetch -q origin main");
  await git.must("reset -q --hard origin/main");
  await git.must("clean -qfdx");
  return git.must("rev-parse HEAD");
}

/** Fetches a fork's main branch and checks that sha, a full commit id, is now available locally. */
export async function fetchFork(git: Git, forkUrl: string, forkSha: string, forkToken?: string) {
  if (!/^[0-9a-f]{40}$/.test(forkSha)) throw new Error(`fork commit must be a full SHA, got ${forkSha}`);
  await git.must(`fetch -q ${quote(forkUrl)} main`, forkToken);
  await git.must(`cat-file -e ${forkSha}^{commit}`);
}
