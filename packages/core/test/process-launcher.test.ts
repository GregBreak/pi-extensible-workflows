import assert from "node:assert/strict";
import { spawnExecutable, spawnSyncExecutable, resolveExecutable } from "../src/process-launcher.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnExecutable(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

void test("Node entrypoints preserve literal argv and paths containing spaces and Unicode", async () => {
  const root = mkdtempSync(join(tmpdir(), "piewf process argv café with spaces-"));
  const workingDirectory = join(root, "project directory");
  const binDirectory = join(root, "npm bin");
  const entry = join(binDirectory, "fake pi entry.mjs");
  const capture = join(root, "captured invocation.json");
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(entry, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.LAUNCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exitCode = process.argv.includes('--exit-seven') ? 7 : 0;\n");
  try {
    const values = ["space value", "café", "& | < > ^ % ! $ ' \\\"", "", "--exit-seven"];
    const result = await run(entry, values, workingDirectory, { ...process.env, LAUNCH_CAPTURE: capture });
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { args: values, cwd: workingDirectory });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("npm launches its Node entrypoint and preserves the installed npm version", () => {
  const result = spawnSyncExecutable("npm", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(result.stdout.toString().trim(), /^\d+\.\d+\.\d+/);
});

void test("Windows npm command shims resolve to their Node entrypoint without cmd.exe argument parsing", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "piewf shim with spaces-"));
  const nested = join(root, "node_modules", "fake package");
  const shim = join(root, "pi role.cmd");
  const entry = join(nested, "cli entry.mjs");
  mkdirSync(nested, { recursive: true });
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(shim, `@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%" "%dp0%\\node_modules\\fake package\\cli entry.mjs" %*\r\n`);
  try {
    const values = ["a b", "éclair", "& ^ % ! | < >", "quote\"inside"];
    const result = await run(shim, values, root, process.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), values);
    const pathEnv = { pAtH: root, pAtHeXt: ".CMD" } as NodeJS.ProcessEnv;
    const resolved = resolveExecutable("pi role", values, pathEnv);
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.args, [entry, ...values]);
    assert.equal(delimiter, ";");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
