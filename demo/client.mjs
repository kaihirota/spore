import { execFileSync } from "node:child_process";

const { SPORE_URL, SPORE_KEY } = process.env;
if (!SPORE_URL || !SPORE_KEY) throw new Error("set SPORE_URL and SPORE_KEY");

export async function api(method, path, body) {
  const response = await fetch(SPORE_URL + path, {
    method,
    headers: { authorization: `Bearer ${SPORE_KEY}` },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export function git(cwd, token, ...args) {
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "-c", "user.name=agent", "-c", "user.email=agent@spore", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function timed(label, run) {
  const start = Date.now();
  const result = await run();
  console.log(`${label} (${((Date.now() - start) / 1000).toFixed(1)}s):`, JSON.stringify(result));
  return result;
}
