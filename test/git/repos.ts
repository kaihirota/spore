import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localShell } from "../../src/git/shell-local";

export const FLAGS = `function audit() {
  return "none";
}

function limit() {
  return 100;
}

module.exports = { audit, limit };
`;

const TEST = `const { limit } = require("./flags.js");
if (limit() < 0) { console.error("limit must not be negative"); process.exit(1); }
`;

export type Repos = Awaited<ReturnType<typeof makeRepos>>;

/** A bare trunk seeded with flags.js and a test, plus helpers that fork it and edit files in the fork. */
export async function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), "spore-"));
  const trunk = join(root, "trunk.git");

  async function sh(cmd: string, cwd = root) {
    const result = await localShell(cmd, { cwd });
    if (result.exitCode !== 0) throw new Error(`${cmd}\n${result.stderr}`);
    return result.stdout.trim();
  }
  const git = (args: string, cwd: string) => sh(`git -c user.name=test -c user.email=test@example.com ${args}`, cwd);

  async function forkWithEdit(name: string, file: string, content: string, message: string) {
    const fork = join(root, `${name}.git`);
    await sh(`git clone -q --bare ${trunk} ${fork}`);
    const work = join(root, name);
    await sh(`git clone -q ${fork} ${work}`);
    writeFileSync(join(work, file), content);
    await git(`commit -qam "${message}"`, work);
    await git("push -q origin main", work);
    return { fork, sha: await sh("git rev-parse HEAD", work) };
  }

  const seed = join(root, "seed");
  await sh(`git init -q -b main ${seed}`);
  writeFileSync(join(seed, "flags.js"), FLAGS);
  writeFileSync(join(seed, "test.js"), TEST);
  await git("add .", seed);
  await git('commit -qm "seed"', seed);
  await sh(`git clone -q --bare ${seed} ${trunk}`);

  return {
    root,
    trunk,
    sh,
    git,
    forkWithEdit,
    trunkHead: () => sh(`git --git-dir=${trunk} rev-parse main`),
    trunkFile: (path: string) => sh(`git --git-dir=${trunk} show main:${path}`),
  };
}
