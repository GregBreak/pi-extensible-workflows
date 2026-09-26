import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(repositoryRoot, "scripts/run-workspace-tests.mjs");
const fixtureRoot = "test/fixtures/workspace-test-runner";

function executeRunner(pattern, marker, extra = [], env = {}) {
  const childEnv = { ...process.env, RUNNER_TEST_MARKER: marker, ...env };
  const cleanEnv = Object.fromEntries(Object.entries(childEnv).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  return spawnSync(process.execPath, [runner, "--workspace=core", `--pattern=${pattern}`, "--agent-dir", "--unset-herdr", "--concurrency=1", ...extra], {
    cwd: repositoryRoot,
    env: cleanEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (predicate()) resolvePromise();
      else if (Date.now() - started >= timeoutMs) reject(new Error("Timed out waiting for the isolated test worker"));
      else globalThis.setTimeout(poll, 20);
    };
    poll();
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "EPERM") return true; return false; }
}

void test("workspace test runner honors file selection, env isolation and exit status", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "piewf-workspace-tools-"));
  const marker = resolve(directory, "selected.json");
  try {
    const selected = executeRunner(`${fixtureRoot}/failing.test.mjs`, marker, [], {
      HERDR_ENV: "1", HERDR_PANE_ID: "personal-pane", HERDR_SOCKET_PATH: "personal-socket", HERDR_TAB_ID: "personal-tab", HERDR_WORKSPACE_ID: "personal-workspace",
      TEST_FILES: `${fixtureRoot}/selected.test.mjs`,
    });
    assert.equal(selected.status, 0, selected.stderr || selected.stdout);
    const isolated = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(isolated.home, dirname(isolated.agent));
    assert.equal(isolated.temp, isolated.home);

    const failed = executeRunner(`${fixtureRoot}/failing.test.mjs`, marker);
    assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("workspace test runner cancellation terminates its owned process tree and removes isolation", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "piewf-workspace-cancel-"));
  const marker = resolve(directory, "worker.json");
  const childEnv = { ...process.env, RUNNER_TEST_MARKER: marker };
  const cleanEnv = Object.fromEntries(Object.entries(childEnv).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const child = spawn(process.execPath, [runner, "--workspace=core", `--pattern=${fixtureRoot}/long.test.mjs`, "--agent-dir", "--concurrency=1", "--cancel-after-ms=800"], {
    cwd: repositoryRoot,
    env: cleanEnv,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => existsSync(marker), 8_000);
    const { workerHome, childPid } = JSON.parse(readFileSync(marker, "utf8"));
    const exit = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    assert.deepEqual(exit, { code: 143, signal: null }, stderr);
    assert.equal(existsSync(workerHome), false, "per-test HOME and temp directory were not cleaned");
    await waitFor(() => !processAlive(childPid), 5_000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
});
