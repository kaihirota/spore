export type ShellResult = { exitCode: number; stdout: string; stderr: string };

export type Shell = (command: string, options?: { cwd?: string; timeoutMs?: number }) => Promise<ShellResult>;

export const TIMED_OUT = 124;

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
