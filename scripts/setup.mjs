// Takes a logged-in wrangler from nothing to a deployed Spore: creates the trunk repo and push queue
// if missing, deploys, sets the secrets and prints the dashboard link. Safe to run again.
// Usage: npm run setup
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

/** The names Spore deploys with, from wrangler.jsonc, so the script and the Worker never disagree. */
export function readConfig(text) {
  const config = JSON.parse(text);
  return { namespace: config.artifacts[0].namespace, trunk: config.vars.TRUNK_REPO, queue: config.queues.consumers[0].queue };
}

export function parseQueueId(infoText) {
  const id = /Queue ID:\s*(\S+)/.exec(infoText)?.[1];
  if (!id) throw new Error(`no queue id in: ${infoText.trim().slice(0, 200)}`);
  return id;
}

/** The account to use: CLOUDFLARE_ACCOUNT_ID if set, else the only account the login can see. */
export function pickAccount(whoami, accountId = undefined) {
  if (accountId) return accountId;
  if (whoami.accounts?.length === 1) return whoami.accounts[0].id;
  const names = (whoami.accounts ?? []).map((a) => `${a.name} (${a.id})`).join(", ");
  throw new Error(`this login sees several accounts; set CLOUDFLARE_ACCOUNT_ID to one of: ${names}`);
}

export function workerUrl(deployOutput) {
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deployOutput)?.[0];
  if (!url) throw new Error("could not find the workers.dev URL in the deploy output");
  return url;
}

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const json = (output) => JSON.parse(output.slice(output.search(/^[[{]/m)));

// Shows the deploy as it runs and keeps its output to find the Worker's URL.
function deploy() {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "deploy"], { stdio: ["inherit", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`npm run deploy exited with ${code}`))));
  });
}

async function ask(question) {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const { namespace, trunk, queue } = readConfig(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const account = pickAccount(json(wrangler("whoami", "--json")), process.env.CLOUDFLARE_ACCOUNT_ID);
  console.log(`account ${account}`);

  if (!json(wrangler("artifacts", "repos", "list", "--namespace", namespace, "--json")).some((r) => r.name === trunk)) {
    wrangler("artifacts", "repos", "create", trunk, "--namespace", namespace, "--json");
    console.log(`created the ${trunk} repo in ${namespace}`);
  }
  let info;
  try {
    info = wrangler("queues", "info", queue);
  } catch {
    wrangler("queues", "create", queue);
    console.log(`created the ${queue} queue`);
    info = wrangler("queues", "info", queue);
  }
  const queueId = parseQueueId(info);

  const url = workerUrl(await deploy());
  const existing = new Set(json(wrangler("secret", "list", "--format", "json")).map((s) => s.name));
  const secrets = { ACCOUNT_ID: account, PUSH_QUEUE_ID: queueId };
  const apiKey = existing.has("API_KEY") ? null : randomBytes(24).toString("hex");
  if (apiKey) secrets.API_KEY = apiKey;
  if (!existing.has("CF_API_TOKEN")) {
    const token = await ask("API token with Account > Queues > Edit, so pushes reach Spore on their own (Enter to skip): ");
    if (token) secrets.CF_API_TOKEN = token;
  }
  execFileSync("npx", ["wrangler", "secret", "bulk"], { input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"] });

  console.log(`\nSpore is running at ${url}`);
  if (apiKey) console.log(`API key (shown once, keep it): ${apiKey}\nDashboard: ${url}/#key=${apiKey}`);
  else console.log(`Dashboard: ${url}/#key=<your API key>`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stderr?.toString() || error.message);
    process.exit(1);
  });
}
