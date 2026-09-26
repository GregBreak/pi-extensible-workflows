import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";

export interface ExecutableInvocation { command: string; args: string[] }

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function nodeScriptShim(path: string): string | undefined {
  try {
    const contents = readFileSync(path, "utf8");
    const npmCli = /SET\s+"NPM_CLI_JS=%~dp0[\\/]([^"\r\n]+\.js)"/i.exec(contents);
    if (npmCli?.[1]) {
      const script = resolve(path, "..", npmCli[1].replace(/[\\/]/g, sep));
      if (isFile(script)) return script;
    }
    if (/SET\s+"script=%~dp0%~n0"/i.test(contents) && /"%script%"/i.test(contents)) {
      const script = path.slice(0, -extname(path).length);
      return isFile(script) ? script : undefined;
    }
    const match = /["']%dp0%[\\/]([^"']+\.(?:m?js|cjs))["']/i.exec(contents);
    if (!match?.[1]) return undefined;
    const script = resolve(path, "..", match[1].replace(/[\\/]/g, sep));
    return isFile(script) ? script : undefined;
  } catch { return undefined; }
}

function asNodeScript(path: string, args: readonly string[]): ExecutableInvocation | undefined {
  if (!/\.(?:m?js|cjs)$/i.test(path) || !isFile(path)) return undefined;
  return { command: process.execPath, args: [path, ...args] };
}

function windowsCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const hasPath = command.includes("\\") || command.includes("/") || isAbsolute(command);
  const directories = hasPath ? [""] : (envValue(env, "PATH") ?? "").split(delimiter).filter(Boolean);
  const configuredExtensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const extensions = extname(command) ? [""] : [...configuredExtensions, ""];
  const candidates: string[] = [];
  for (const directory of directories) for (const extension of extensions) candidates.push(resolve(directory || ".", `${command}${extension}`));
  return candidates;
}

/** Resolve Windows npm-style Node shims without passing arguments through cmd.exe. */
export function resolveExecutable(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ExecutableInvocation {
  if (command.toLowerCase() === "npm") {
    const npmExecPath = envValue(env, "npm_execpath");
    if (npmExecPath && isFile(npmExecPath)) return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  if (process.platform === "win32") {
    for (const candidate of windowsCandidates(command, env)) {
      if (!isFile(candidate)) continue;
      const script = extname(candidate).toLowerCase() === ".cmd" || extname(candidate).toLowerCase() === ".bat" ? nodeScriptShim(candidate) : undefined;
      if (script) return { command: process.execPath, args: [script, ...args] };
      const nodeScript = asNodeScript(candidate, args);
      if (nodeScript) return nodeScript;
      return { command: candidate, args: [...args] };
    }
    return { command, args: [...args] };
  }
  const nodeScript = asNodeScript(command, args);
  return nodeScript ?? { command, args: [...args] };
}

export function spawnExecutable(command: string, args: readonly string[], options: SpawnOptions = {}) {
  const invocation = resolveExecutable(command, args, options.env ?? process.env);
  return spawn(invocation.command, invocation.args, options);
}

export function spawnSyncExecutable(command: string, args: readonly string[], options: SpawnSyncOptions = {}) {
  const invocation = resolveExecutable(command, args, options.env ?? process.env);
  return spawnSync(invocation.command, invocation.args, options);
}

export async function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return false;
  if (process.platform === "win32") {
    // Windows has no POSIX signal delivery; forcefully terminate only this owned PID tree.
    void signal;
    const args = ["/pid", String(pid), "/t", "/f"];
    return new Promise((resolvePromise) => {
      let killer: ReturnType<typeof spawnExecutable>;
      try { killer = spawnExecutable("taskkill", args, { stdio: "ignore", windowsHide: true }); }
      catch { resolvePromise(false); return; }
      killer.once("error", () => { resolvePromise(false); });
      killer.once("close", (code) => { resolvePromise(code === 0); });
    });
  }
  try { process.kill(-pid, signal); return true; }
  catch {
    try { child.kill(signal); return true; }
    catch { return false; }
  }
}

export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform === "win32") {
    for (const candidate of windowsCandidates(command, env)) if (isFile(candidate)) return candidate;
    return undefined;
  }
  if (command.includes("/") || isAbsolute(command)) return existsSync(command) ? command : undefined;
  const pathValue = envValue(env, "PATH") ?? "";
  return pathValue.split(delimiter).filter(Boolean).map((directory) => join(directory, command)).find(isFile);
}
