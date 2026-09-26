import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = { core: "packages/core", cli: "packages/cli" };
const options = { patterns: [], excludes: [], concurrency: 20, agentDir: false, unsetHerdr: false, timeout: 120_000, reporter: "dot", exposeGc: false, cancelAfterMs: 0, namePattern: "" };

function parseArgs(args) {
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    const [name, inline] = value.split(/=(.*)/s, 2);
    const take = () => inline ?? args[++index];
    if (name === "--workspace") options.workspace = take();
    else if (name === "--pattern") options.patterns.push(take());
    else if (name === "--exclude") options.excludes.push(take());
    else if (name === "--concurrency") options.concurrency = Number(take());
    else if (name === "--timeout") options.timeout = Number(take());
    else if (name === "--reporter") options.reporter = take();
    else if (name === "--agent-dir") options.agentDir = true;
    else if (name === "--unset-herdr") options.unsetHerdr = true;
    else if (name === "--expose-gc") options.exposeGc = true;
    else if (name === "--cancel-after-ms") options.cancelAfterMs = Number(take());
    else if (name === "--name-pattern") options.namePattern = take();
    else throw new Error(`Unknown test-runner option: ${value}`);
    if (typeof take === "function" && inline === undefined && index >= args.length) throw new Error(`Missing value for ${name}`);
  }
}

function selectedPatterns() {
  const supplied = process.env.TEST_FILES?.trim();
  return supplied ? supplied.split(/[\s;]+/).filter(Boolean) : options.patterns;
}

function discoverFiles(workspaceRoot) {
  const patterns = selectedPatterns();
  if (!patterns.length) throw new Error("No test discovery patterns were provided");
  const selected = new Set();
  for (const pattern of patterns) {
    for (const file of globSync(pattern.replaceAll("\\", "/"), { cwd: workspaceRoot })) selected.add(file.replaceAll("\\", "/"));
  }
  const excludes = new Set((process.env.TEST_FILES?.trim() ? [] : options.excludes).map((path) => path.replaceAll("\\", "/")));
  return [...selected].filter((file) => !excludes.has(file)).sort();
}

function childEnvironment(directory) {
  const isolatedKeys = new Set(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR"]);
  if (options.unsetHerdr) for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_BIN_PATH", "HERDR_STARTUP_CWD"]) isolatedKeys.add(key.toUpperCase());
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isolatedKeys.has(key.toUpperCase())));
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.APPDATA = resolve(directory, "AppData/Roaming");
  env.LOCALAPPDATA = resolve(directory, "AppData/Local");
  env.XDG_CONFIG_HOME = resolve(directory, ".config");
  env.XDG_DATA_HOME = resolve(directory, ".local/share");
  env.XDG_CACHE_HOME = resolve(directory, ".cache");
  env.XDG_STATE_HOME = resolve(directory, ".local/state");
  env.TMPDIR = directory;
  env.TMP = directory;
  env.TEMP = directory;
  if (options.agentDir) env.PI_CODING_AGENT_DIR = resolve(directory, "pi-agent");
  return env;
}

const active = new Set();
let abortSignal;

function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.unref();
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    const timer = globalThis.setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process already exited. */ } }, 2_000);
    timer.unref();
  }
}

async function executeFile(file, workspaceRoot) {
  const isolated = await mkdtemp(resolve(tmpdir(), "piewf-test-"));
  await mkdir(resolve(isolated, "AppData/Roaming"), { recursive: true });
  await mkdir(resolve(isolated, "AppData/Local"), { recursive: true });
  await mkdir(resolve(isolated, ".config"), { recursive: true });
  await mkdir(resolve(isolated, ".local/share"), { recursive: true });
  await mkdir(resolve(isolated, ".cache"), { recursive: true });
  await mkdir(resolve(isolated, ".local/state"), { recursive: true });
  return new Promise((resolvePromise, reject) => {
    const args = [
      ...(options.exposeGc ? ["--expose-gc"] : []), "--test", "--test-concurrency=1",
      `--test-timeout=${String(options.timeout)}`, "--test-force-exit", `--test-reporter=${options.reporter}`,
      ...(options.namePattern ? [`--test-name-pattern=${options.namePattern}`] : []), file,
    ];
    if (process.env.PIEWF_RUNNER_DEBUG === "1") process.stderr.write(`Test worker args: ${JSON.stringify(args)}\\n`);
    const child = spawn(process.execPath, args, { cwd: workspaceRoot, env: childEnvironment(isolated), stdio: "inherit", detached: process.platform !== "win32", windowsHide: true });
    active.add(child);
    child.once("error", (error) => { active.delete(child); void rm(isolated, { recursive: true, force: true }).then(() => reject(error), reject); });
    child.once("close", (code, signal) => {
      active.delete(child);
      void rm(isolated, { recursive: true, force: true }).then(() => resolvePromise({ file, code: code ?? 1, signal }), reject);
    });
    if (abortSignal) killTree(child);
  });
}

async function main() {
  parseArgs(process.argv.slice(2));
  const relativeWorkspace = workspaces[options.workspace];
  if (!relativeWorkspace) throw new Error("Usage: run-workspace-tests.mjs --workspace <core|cli> --pattern <glob> [--exclude <path>] [--agent-dir] [--unset-herdr]");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 20) throw new Error("Test concurrency must be between 1 and 20");
  const workspaceRoot = resolve(repositoryRoot, relativeWorkspace);
  const files = discoverFiles(workspaceRoot);
  if (files.length === 0) throw new Error(`No tests matched ${selectedPatterns().join(", ")}`);
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (!abortSignal && next < files.length) {
      const file = files[next++];
      const result = await executeFile(file, workspaceRoot);
      if (result.code !== 0 || result.signal) failures.push({ ...result, path: resolve(workspaceRoot, file) });
    }
  };
  const workers = Array.from({ length: Math.min(options.concurrency, files.length) }, worker);
  const stop = (signal) => {
    abortSignal = signal;
    for (const child of active) killTree(child);
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const cancellationTimer = options.cancelAfterMs > 0 ? globalThis.setTimeout(() => process.emit("SIGTERM"), options.cancelAfterMs) : undefined;
  try { await Promise.all(workers); }
  finally {
    if (cancellationTimer) globalThis.clearTimeout(cancellationTimer);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    for (const child of active) killTree(child);
  }
  if (abortSignal) process.exitCode = abortSignal === "SIGINT" ? 130 : 143;
  else if (failures.length) {
    for (const { path, code, signal } of failures) process.stderr.write(`FAILED ${path} (${signal ?? `exit ${String(code)}`})\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
