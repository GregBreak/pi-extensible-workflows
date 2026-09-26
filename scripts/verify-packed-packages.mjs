import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(resolve(tmpdir(), "piewf-packages-"));
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(work, "tarballs");
const agentRoot = resolve(work, "agent");
const installRoot = resolve(agentRoot, "npm");
const workspaces = ["packages/core", "packages/cli", "packages/extensions/herdr"];

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function packagePath(base, name) { return resolve(base, "node_modules", ...name.split("/")); }
function tarballName({ name, version }) { return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`; }
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const target = resolve(path, entry.name);
    return entry.isDirectory() ? files(target) : [target];
  });
}
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function filePathHasTestDirectory(path) { return path.split(/[\\/]/).includes("test"); }
function relativeImports(source) {
  const imports = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if ((value.type === "ImportDeclaration" || value.type === "ExportNamedDeclaration" || value.type === "ExportAllDeclaration") && typeof value.source?.value === "string") imports.push(value.source.value);
    if (value.type === "ImportExpression" && typeof value.source?.value === "string") imports.push(value.source.value);
    for (const child of Object.values(value)) {
      if (!child || typeof child !== "object") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return imports.filter((specifier) => specifier.startsWith("."));
}

try {
  mkdirSync(output, { recursive: true });
  const packages = workspaces.map((workspace) => ({ workspace, manifest: json(resolve(root, workspace, "package.json")) }));
  for (const { workspace } of packages) execFileSync("npm", ["pack", `--workspace=${workspace}`, "--pack-destination", output], { cwd: root, stdio: "pipe", timeout: 120_000 });

  const errors = [];
  for (const { manifest } of packages) {
    const tarball = resolve(output, tarballName(manifest));
    const extracted = resolve(work, "extracted", manifest.name.replaceAll("/", "-"));
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", extracted, "--strip-components=1"], { stdio: "pipe", timeout: 30_000 });
    const packed = json(resolve(extracted, "package.json"));
    const packedFiles = files(extracted);
    const relativeFiles = packedFiles.map((path) => relative(extracted, path).replaceAll("\\", "/"));
    const entrypoints = [packed.main, ...strings(packed.bin), ...strings(packed.exports), ...strings(packed.pi?.extensions)].filter((path) => typeof path === "string" && path.startsWith("./"));
    for (const entrypoint of entrypoints) if (!existsSync(resolve(extracted, entrypoint))) errors.push(`${manifest.name}: missing entrypoint ${entrypoint}`);
    for (const file of packedFiles.filter((path) => path.startsWith(resolve(extracted, "dist")) && (filePathHasTestDirectory(path.slice(extracted.length + 1)) || path.includes(".test.")))) errors.push(`${manifest.name}: published test artifact ${file.slice(extracted.length + 1)}`);
    for (const file of packedFiles.filter((path) => path.endsWith(".js"))) {
      for (const specifier of relativeImports(readFileSync(file, "utf8"))) if (!existsSync(resolve(dirname(file), specifier))) errors.push(`${manifest.name}: ${file.slice(extracted.length + 1)} imports missing ${specifier}`);
    }
    if (manifest.name === "pi-extensible-workflows") {
      const semanticAssets = relativeFiles.filter((path) => /^.*\/semantic-map\.(html|js|css)$/.test(path)).sort();
      const expectedAssets = ["dist/trajectory/assets/semantic-map.css", "dist/trajectory/assets/semantic-map.html", "dist/trajectory/assets/semantic-map.js"];
      if (JSON.stringify(semanticAssets) !== JSON.stringify(expectedAssets)) errors.push(`${manifest.name}: expected one canonical copy of each Semantic Map browser asset, found ${JSON.stringify(semanticAssets)}`);
      if (!relativeFiles.includes("trajectory/vendor/archify/LICENSE")) errors.push(`${manifest.name}: missing Archify and embedded-font license notices`);
      for (const forbidden of ["trajectory/vendor/archify/template.html", "trajectory/test/fixtures/semantic-map-feasibility/archify-template.html"]) if (relativeFiles.includes(forbidden)) errors.push(`${manifest.name}: packaged pinned vendor input ${forbidden}`);
      if (relativeFiles.some((path) => path.includes("semantic-map-feasibility"))) errors.push(`${manifest.name}: packaged Semantic Map test fixture`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const tarballs = packages.map(({ manifest }) => resolve(output, tarballName(manifest)));
  execFileSync("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", ...tarballs], { stdio: "pipe", timeout: 120_000 });
  const semanticConsumer = resolve(agentRoot, "semantic-map-installed-consumer.mjs");
  writeFileSync(semanticConsumer, [
    'import assert from "node:assert/strict";',
    'import { createServer } from "node:http";',
    'import { mkdtempSync, readFileSync, rmSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join, resolve } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const packageRoot = resolve(process.argv[2]);',
    'const assetsRoot = resolve(packageRoot, "dist/trajectory/assets");',
    'const { createTrajectoryServer } = await import(pathToFileURL(resolve(packageRoot, "dist/trajectory/src/server.js")).href);',
    'const expected = new Map([["/semantic-map.html", ["text/html; charset=utf-8", "semantic-map.html"]], ["/semantic-map.js", ["application/javascript; charset=utf-8", "semantic-map.js"]], ["/semantic-map.css", ["text/css; charset=utf-8", "semantic-map.css"]]]);',
    'const root = mkdtempSync(join(tmpdir(), "piewf-installed-semantic-map-"));',
    'const probe = createServer();',
    'await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });',
    'const address = probe.address(); assert.ok(address && typeof address !== "string");',
    'await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));',
    'const port = address.port;',
    'const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint: "installed-semantic-map-consumer" });',
    'await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });',
    'const base = "http://127.0.0.1:" + String(port);',
    'let rawBytes = 0;',
    'try {',
    '  const parent = await fetch(base + "/");',
    '  assert.equal(parent.status, 200);',
    '  assert.equal(parent.headers.get("cache-control"), "no-store");',
    '  assert.equal(parent.headers.get("x-content-type-options"), "nosniff");',
    '  assert.match(parent.headers.get("content-security-policy") || "", /frame-src \'self\'/);',
    '  for (const [route, [mime, filename]] of expected) {',
    '    const response = await fetch(base + route + (route.endsWith(".html") ? "?installed=1" : ""));',
    '    assert.equal(response.status, 200, route);',
    '    assert.equal(response.headers.get("content-type"), mime, route);',
    '    assert.equal(response.headers.get("cache-control"), "no-store", route);',
    '    assert.equal(response.headers.get("x-content-type-options"), "nosniff", route);',
    '    assert.equal(response.headers.get("referrer-policy"), "no-referrer", route);',
    '    const actual = Buffer.from(await response.arrayBuffer());',
    '    const packaged = readFileSync(resolve(assetsRoot, filename));',
    '    assert.deepEqual(actual, packaged, route + " is served from the installed canonical package asset");',
    '    assert.equal(Number(response.headers.get("content-length")), packaged.byteLength, route);',
    '    rawBytes += actual.byteLength;',
    '    if (route.endsWith(".html")) {',
    '      const html = actual.toString("utf8");',
    '      assert.match(html, /semantic-map\\.js/);',
    '      assert.match(html, /semantic-map\\.css/);',
    '      assert.match(response.headers.get("content-security-policy") || "", /connect-src \'none\'/);',
    '    }',
    '  }',
    '  assert.equal((await fetch(base + "/semantic-map.json")).status, 404);',
    '  assert.equal((await fetch(base + "/semantic-map.js", { method: "POST" })).status, 404);',
    '  assert.equal((await fetch(base + "/semantic-map.js", { headers: { origin: "http://evil.test" } })).status, 403);',
    '  process.stdout.write("Installed Semantic Map consumer passed: routes=3, rawBytes=" + String(rawBytes) + ".\\n");',
    '} finally {',
    '  server.closeAllConnections(); server.closeIdleConnections();',
    '  await new Promise((resolve) => server.close(() => resolve()));',
    '  rmSync(root, { recursive: true, force: true });',
    '}'
  ].join("\n"));
  const semanticConsumerOutput = execFileSync(process.execPath, [semanticConsumer, packagePath(installRoot, "pi-extensible-workflows")], { cwd: work, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
  process.stdout.write(semanticConsumerOutput);
  const cli = spawnSync(resolve(installRoot, "node_modules", ".bin", "piewf"), ["run", "--help"], { cwd: work, encoding: "utf8" });
  const cliOutput = `${cli.stdout ?? ""}${cli.stderr ?? ""}`;
  if (cli.error) throw cli.error;
  if (cli.status !== 0 || !cliOutput.includes("Usage: piewf run")) throw new Error(`Standalone CLI smoke test failed (${String(cli.status)}):\n${cliOutput}`);
  const piRole = spawnSync(resolve(installRoot, "node_modules", ".bin", "pi-role"), ["--help"], { cwd: work, encoding: "utf8", env: { ...process.env, HOME: work, PI_CODING_AGENT_DIR: resolve(work, "agent") } });
  const piRoleOutput = `${piRole.stdout ?? ""}${piRole.stderr ?? ""}`;
  if (piRole.error) throw piRole.error;
  if (piRole.status !== 0 || !piRoleOutput.includes("Usage: pi-role <role>") || !piRoleOutput.includes("developer")) throw new Error(`Standalone pi-role smoke test failed (${String(piRole.status)}):\n${piRoleOutput}`);
  const fakeBin = resolve(work, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(resolve(fakeBin, "pi"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  const launch = spawnSync(resolve(installRoot, "node_modules", ".bin", "pi-role"), ["developer", "-p", "hello"], { cwd: work, encoding: "utf8", env: { ...process.env, HOME: work, PI_CODING_AGENT_DIR: resolve(work, "agent"), PATH: `${fakeBin}:${process.env.PATH ?? ""}` } });
  const launchArgs = (launch.stdout ?? "").split("\n");
  if (launch.error) throw launch.error;
  if (launch.status !== 0 || launchArgs.includes("--model") || !launchArgs.includes("--append-system-prompt") || launchArgs.slice(-3, -1).join(" ") !== "-p hello" || !(launch.stderr ?? "").includes("developer-model")) throw new Error(`Standalone pi-role launch smoke test failed (${String(launch.status)}):\n${launch.stdout ?? ""}${launch.stderr ?? ""}`);
  execFileSync("npm", ["audit", "--prefix", installRoot, "--omit=dev"], { stdio: "pipe", timeout: 60_000 });

  const localPackages = ["pi-extensible-workflows", "@piewf/herdr"].map((name) => packagePath(installRoot, name));
  const extensionCount = localPackages.reduce((count, directory) => count + strings(json(resolve(directory, "package.json")).pi?.extensions).length, 0);
  const pi = resolve(root, "node_modules/.bin/pi");
  const herdrVariables = new Set(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !herdrVariables.has(name))), PI_CODING_AGENT_DIR: agentRoot, PI_OFFLINE: "1" };
  for (const directory of localPackages) {
    const installation = spawnSync(pi, ["install", directory], { cwd: work, encoding: "utf8", env, timeout: 30_000 });
    if (installation.error) throw installation.error;
    if (installation.status !== 0) throw new Error(`Pi local package installation failed (${String(installation.status)}):\n${installation.stdout ?? ""}${installation.stderr ?? ""}`);
  }
  const result = spawnSync(pi, ["--mode", "rpc"], { cwd: work, encoding: "utf8", env, input: "", timeout: 30_000 });
  const outputText = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0 || /Failed to load extension|Cannot find module/.test(outputText)) throw new Error(`Pi package discovery smoke test failed (${String(result.status)}):\n${outputText}`);

  process.stdout.write(`Package verification passed: ${packages.length} tarballs, ${localPackages.length} local Pi packages, and ${extensionCount} discovered extensions.\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
