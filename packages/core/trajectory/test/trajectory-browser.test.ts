import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportTrajectoryRunHtml } from "../index.js";
import { createTrajectoryServer } from "../src/server.js";
import { RunStore } from "../../src/persistence.js";
import { createLaunchSnapshot } from "../../src/utils.js";
import type { PersistedRun } from "../../src/persistence.js";

type CdpRecord = Record<string, unknown>;
type CdpMessage = CdpRecord & { id?: number; method?: string };
type RouteBody = string | Buffer;

function textValue(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(page: Devtools, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate(expression)) return;
    await delay(25);
  }
  throw new Error(`Chrome condition did not become true: ${expression}`);
}
function findBrowser(): string | undefined {
  const candidates = [process.env.PI_TRAJECTORY_CHROME, "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  try {
    for (const version of readdirSync(join(homedir(), ".cache", "ms-playwright"))) candidates.push(join(homedir(), ".cache", "ms-playwright", version, "chrome-linux64", "chrome"));
  } catch { /* The browser cache is optional. */ }
  for (const name of ["chromium", "google-chrome", "chromium-browser"]) {
    try { candidates.push(execFileSync("which", [name], { encoding: "utf8" }).trim()); } catch { /* Try the next browser location. */ }
  }
  const found = candidates.find((candidate) => typeof candidate === "string" && Boolean(candidate) && existsSync(candidate));
  return typeof found === "string" ? found : undefined;
}

class Devtools {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Map<string, Set<(params: CdpRecord) => void>>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let message: CdpMessage;
      try { message = JSON.parse(String(event.data)) as CdpMessage; } catch { return; }
      if (typeof message.method === "string") {
        const params = message.params && typeof message.params === "object" ? message.params as CdpRecord : {};
        for (const listener of this.eventListeners.get(message.method) || []) listener(params);
      }
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      request.resolve(message);
    });
  }
  on(method: string, listener: (params: CdpRecord) => void): void {
    const listeners = this.eventListeners.get(method) || new Set<(params: CdpRecord) => void>();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
  }
  command(method: string, params: CdpRecord = {}): Promise<CdpMessage> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
  }
  async evaluate(expression: string): Promise<unknown> {
    const message = await this.command("Runtime.evaluate", { expression, returnByValue: true });
    if (message.error) throw new Error(textValue((message.error as CdpRecord).message, "Chrome evaluation failed"));
    const result = message.result as CdpRecord | undefined;
    const exception = result?.exceptionDetails as CdpRecord | undefined;
    if (exception) throw new Error(textValue(exception.description, textValue(exception.text, "Chrome evaluation failed")));
    return (result?.result as CdpRecord | undefined)?.value;
  }
  close(): void {
    for (const request of this.pending.values()) request.reject(new Error("Chrome DevTools connection closed"));
    this.pending.clear();
    this.socket.close();
  }
}

async function connectDevtools(url: string): Promise<Devtools> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => { resolve(); });
    socket.addEventListener("error", () => { reject(new Error("Chrome DevTools connection failed")); });
  });
  return new Devtools(socket);
}

async function waitForDevtools(port: number, child: ReturnType<typeof spawn>, stderr: () => string): Promise<string> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chrome exited before DevTools started (code ${String(child.exitCode)}, signal ${String(child.signalCode)}${stderr() ? `): ${stderr().trim()}` : ")"}`);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json`);
      const pages = await response.json() as Array<{ type?: unknown; webSocketDebuggerUrl?: unknown }>;
      const page = pages.find((candidate) => candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string");
      const websocketUrl = page?.webSocketDebuggerUrl;
      if (typeof websocketUrl === "string") return websocketUrl;
    } catch { /* Chrome is still starting. */ }
    await delay(50);
  }
  throw new Error(`Chrome DevTools did not start${stderr() ? `: ${stderr().trim()}` : ""}`);
}

async function serve(routes: ReadonlyMap<string, RouteBody>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const body = routes.get(path);
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }) };
}

async function withChrome(url: string, callback: (page: Devtools) => Promise<void>): Promise<void> {
  const browser = findBrowser();
  assert.ok(browser, "Chromium is required for Trajectory browser verification");
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
  const address = portServer.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => { portServer.close((error) => { if (error) reject(error); else resolve(); }); });
  const profile = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-chrome-"));
  const child = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${String(port)}`, `--user-data-dir=${profile}`, url], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr.push(chunk); });
  const childExited = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  let page: Devtools | undefined;
  try {
    page = await connectDevtools(await waitForDevtools(port, child, () => stderr.join("")));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await page.evaluate("document.readyState === 'complete'")) break;
      await delay(25);
    }
    await callback(page);
  } finally {
    page?.close();
    child.kill("SIGTERM");
    await Promise.race([childExited, delay(2000)]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await delay(50); }
    }
  }
}

function makeState(output: Record<string, unknown>, state: "running" | "completed"): Record<string, unknown> {
  const agent = { id: "agent", name: "fixture-agent", label: "fixture-agent", state, attempts: 1, startedAt: 1, durationMs: state === "completed" ? 10 : undefined, model: { provider: "fixture", model: "model" }, requestedModel: "fixture/request", role: "reviewer", tools: ["read"], skills: ["review"], extensions: ["fixture"], prompt: "Inspect the fixture", systemPrompt: "System prompt", output, attemptDetails: [{ attempt: 1, transport: "local", setup: { cwd: "/project", model: { provider: "fixture", model: "model" }, tools: ["read"] } }] };
  const run = { id: "run", workflowName: "fixture", cwd: "/project", sessionId: "session", state, agents: [agent], transcripts: { agent: [{ type: "message", timestamp: "2025-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "transcript" }] } }] }, snapshot: { script: "return true;" } };
  return { type: "state", publishers: [{ id: "publisher", title: "fixture", cwd: "/project", sessionId: "session", connected: true, runs: [{ run }], subagents: [] }], updatedAt: 1 };
}

function clickExpression(selector: string): string { return `document.querySelector(${JSON.stringify(selector)}).click()`; }
function outputTabClickExpression(): string { return "Array.from(document.querySelectorAll('#sys-tabs span')).find((tab) => tab.dataset.pane === 'output').click()"; }

const browserPath = findBrowser();
void test("Trajectory static export opens Agent details and its Output tab in Chromium", { skip: !browserPath, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-browser-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "transcript" }] } })}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "model" };
  const run = { id: "run", workflowName: "fixture", cwd, sessionId: "session", state: "completed", agentSessions: [], agents: [{ id: "agent", name: "fixture-agent", path: "agent", state: "completed", resultPath: "agent/call:1", attempts: 1, model, requestedModel: "fixture/request", role: "reviewer", tools: ["read"], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: ["read"] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }] } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "fixture" }, settings: { concurrency: 1 }, models: ["fixture/model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    await store.complete("agent/call:1", { answer: false });
    const html = await exportTrajectoryRunHtml({ cwd, sessionId: "session", runId: "run", home });
    const server = await serve(new Map([["/report.html", html]]));
    try {
      await withChrome(`${server.url}/report.html`, async (page) => {
        await waitFor(page, "Boolean(document.querySelector('.agent-grid-row'))");
        await page.evaluate(clickExpression(".agent-grid-row"));
        assert.equal(await page.evaluate("Boolean(document.querySelector('[data-agent-details]'))"), true);
        await page.evaluate(clickExpression("[data-agent-details]"));
        assert.match(String(await page.evaluate("document.getElementById('sys-tabs').textContent")), /PromptToolsSkillsExtensionsEnvironmentOutput/);
        await page.evaluate(outputTabClickExpression());
        assert.match(String(await page.evaluate("document.getElementById('sys-pane').textContent")), /answer.*false/);
      });
    } finally { await server.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("Trajectory Chromium view preserves the selected Output tab across live publisher updates", { skip: !browserPath, timeout: 120_000 }, async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const marked = readFileSync(new URL("../src/assets/marked.min.js", import.meta.url));
  const morphdom = readFileSync(new URL("../src/assets/morphdom.min.js", import.meta.url));
  const bootstrap = `<script>(function(){class FakeSocket{constructor(){this.readyState=1;this.listeners={};window.__trajectorySocket=this;}addEventListener(type,listener){(this.listeners[type] ||= []).push(listener);}send(){}close(){}emit(type,data){for(const listener of this.listeners[type] || []) listener({data});}}window.WebSocket=FakeSocket;})();</script>`;
  const html = source.replace("  <script>\n    const defaultRunLayout", `  ${bootstrap}\n  <script>\n    const defaultRunLayout`);
  assert.notEqual(html, source);
  const server = await serve(new Map<string, RouteBody>([["/index.html", html], ["/marked.min.js", marked], ["/morphdom.min.js", morphdom]]));
  try {
    await withChrome(`${server.url}/index.html`, async (page) => {
      await waitFor(page, "Boolean(window.__trajectorySocket)");
      const pending = JSON.stringify(makeState({ status: "pending" }, "running"));
      await page.evaluate(`window.__trajectorySocket.emit('message', ${JSON.stringify(pending)})`);
      await waitFor(page, "Boolean(document.querySelector('.agent-grid-row'))");
      await page.evaluate(clickExpression(".agent-grid-row"));
      await page.evaluate(clickExpression("[data-agent-details]"));
      await page.evaluate(outputTabClickExpression());
      assert.match(String(await page.evaluate("document.getElementById('sys-pane').textContent")), /not yet available/);
      const available = JSON.stringify(makeState({ status: "available", value: { answer: "done" }, bytes: 18 }, "completed"));
      await page.evaluate(`window.__trajectorySocket.emit('message', ${JSON.stringify(available)})`);
      await waitFor(page, "document.getElementById('sys-pane').textContent.includes('done')");
      assert.equal(await page.evaluate("document.querySelector('#sys-tabs [data-pane=output]').classList.contains('on')"), true);
      assert.match(String(await page.evaluate("document.getElementById('sys-pane').textContent")), /answer.*done/);
    });
  } finally { await server.close(); }
});

function toolTiming(id: string, startedAt: number, durationMs: number, isError = false): Record<string, unknown> {
  return { type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: id, toolName: "read", startedAt, completedAt: startedAt + durationMs, durationMs, isError } };
}

void test("Trajectory live gantt keeps cached timing, merges dense calls, and pauses while hidden", { skip: !browserPath, timeout: 120_000 }, async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-live-"));
  const server = createTrajectoryServer(port, join(root, "lock.json"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const start = Date.now() - 600_000;
  // Sparse calls stay separate bars; the dense burst collapses into one; the failure must survive merging.
  const baseline = [...Array.from({ length: 20 }, (_, index) => toolTiming(`sparse-${String(index)}`, start + index * 20_000, 3_000, index === 7)), ...Array.from({ length: 50 }, (_, index) => toolTiming(`burst-${String(index)}`, start + 500_000 + index * 20, 15))];
  let tick = 0;
  const agent = (id: string, running: boolean) => ({ id, name: id, label: id, path: id, state: running ? "running" : "completed", attempts: 1, startedAt: start, durationMs: running ? undefined : 550_000, lastEventAt: Date.now(), model: { provider: "fixture", model: "model" }, tools: ["read"] });
  const publisherId = "livepublisher1";
  const publisher = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  await new Promise((resolve) => { publisher.addEventListener("open", resolve, { once: true }); });
  publisher.send(JSON.stringify({ type: "publisher:attach", publisherId }));
  const publish = () => {
    // Only the running agent gains calls, so the done agent's timing is omitted after its first delivery.
    const live = Array.from({ length: tick }, (_, index) => toolTiming(`live-${String(index)}`, start + 560_000 + index * 15_000, 4_000));
    const run = { id: "live", workflowName: "live-workflow", cwd: "/project", sessionId: "session", state: "running", agents: [agent("done", false), agent("busy", true)], agentSessions: [], events: [] };
    publisher.send(JSON.stringify({ type: "publisher:state", publisher: { id: publisherId, title: "live", cwd: "/project", sessionId: "session", connected: true }, runs: [{ run, snapshot: { script: "return true;" }, transcripts: { done: { revision: 1, status: "available", timing: baseline }, busy: { revision: 100 + tick, status: "available", timing: [...baseline, ...live] } } }], subagents: [] }));
    tick += 1;
  };
  publish();
  const timer = setInterval(publish, 250);
  const bars = (lane: string, selector = ".bar.tool") => `document.querySelectorAll('#swim-content .lane[data-agent="${lane}"] ${selector}').length`;
  try {
    await withChrome(`http://127.0.0.1:${String(port)}/?view=run&run=${publisherId}:live`, async (page) => {
      await waitFor(page, `${bars("done")} > 0 && ${bars("busy")} > 0`);
      const done = Number(await page.evaluate(bars("done")));
      assert.ok(done > 1 && done < baseline.length, `dense calls merge into fewer bars, got ${String(done)}`);
      assert.ok(Number(await page.evaluate(bars("done", ".bar.tool.fail"))) > 0, "failed call keeps its styling after merging");
      assert.equal(Number(await page.evaluate("document.querySelectorAll('#swim-content .bar.tool[title*=\"tool calls\"]').length")) > 0, true);
      const busy = Number(await page.evaluate(bars("busy")));
      await delay(1_500);
      assert.equal(Number(await page.evaluate(bars("done"))), done, "timing omitted by the server is carried forward from cache");
      assert.ok(Number(await page.evaluate(bars("busy"))) > busy, "new live timing reaches the gantt");
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))");
      const hidden = Number(await page.evaluate(bars("busy")));
      await delay(1_000);
      assert.equal(Number(await page.evaluate(bars("busy"))), hidden, "hidden tab does not render");
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'))");
      await waitFor(page, `${bars("busy")} > ${String(hidden)}`);
      assert.equal(Number(await page.evaluate(bars("done"))), done, "timing is restored after the tab returns");
    });
  } finally {
    clearInterval(timer);
    publisher.close();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    rmSync(root, { recursive: true, force: true });
  }
});

void test("Trajectory keeps a subagent transcript when a refresh races a newer revision", { skip: !browserPath, timeout: 120_000 }, async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-stale-"));
  const server = createTrajectoryServer(port, join(root, "lock.json"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const publisherId = "stalepublisher1";
  const subagentId = "11111111-1111-4111-8111-111111111111";
  const call = (index: number) => [
    { type: "message", timestamp: new Date(1_000 + index).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: `call-${String(index)}`, name: "read", arguments: { path: `f${String(index)}` } }] } },
    { type: "message", timestamp: new Date(1_001 + index).toISOString(), message: { role: "toolResult", toolCallId: `call-${String(index)}`, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false } },
  ];
  let revision = 1;
  const publisher = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  await new Promise((resolve) => { publisher.addEventListener("open", resolve, { once: true }); });
  publisher.send(JSON.stringify({ type: "publisher:attach", publisherId }));
  const publish = () => { publisher.send(JSON.stringify({ type: "publisher:state", publisher: { id: publisherId, title: "stale", cwd: "/project", sessionId: "session", connected: true }, runs: [], subagents: [{ id: subagentId, label: "live-sub", state: "running", role: "scout", startedAt: 1_000, model: { provider: "fixture", model: "model" }, request: { prompt: "go", model: "fixture/model" }, attempts: 1, transcript: { revision, status: "available", timing: [] } }] })); };
  // Revision 2 is answered as stale, as a publisher does when the session file grew between its state poll and the read.
  publisher.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; requestId?: string; revision?: number };
    if (message.type !== "publisher:transcript") return;
    const base = { type: "publisher:transcript-result", requestId: message.requestId, publisherId, subagentId, requestedRevision: message.revision };
    if (message.revision === 2) { publisher.send(JSON.stringify({ ...base, ok: false, status: "available", revision: 3, error: "Transcript revision is stale" })); return; }
    const calls = message.revision === 3 ? 3 : 2;
    publisher.send(JSON.stringify({ ...base, ok: true, status: "available", revision: message.revision, entries: [{ type: "message", timestamp: new Date(1_000).toISOString(), message: { role: "user", content: "go" } }, ...Array.from({ length: calls }, (_, index) => call(index)).flat()] }));
  });
  publish();
  const toolRows = "[...document.querySelectorAll('#events .evt .pill')].filter((pill) => pill.textContent === 'TOOL').length";
  try {
    await withChrome(`http://127.0.0.1:${String(port)}/?view=subagent&subagent=${publisherId}:${subagentId}`, async (page) => {
      await waitFor(page, `${toolRows} === 2`);
      revision = 2; publish();
      await delay(500);
      assert.equal(Number(await page.evaluate(toolRows)), 2, "a stale refresh keeps the cached tool calls");
      revision = 3; publish();
      await waitFor(page, `${toolRows} === 3`);
    });
  } finally {
    publisher.close();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    rmSync(root, { recursive: true, force: true });
  }
});

function applyFeasibilityFinderPatch(template: string): string {
  const patches: unknown = JSON.parse(readFileSync(new URL("../../../trajectory/test/fixtures/semantic-map-feasibility/finder-live.patch.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(patches));
  let output = template;
  for (const patch of patches as { find: string; replacement: string }[]) {
    assert.equal(typeof patch.find, "string");
    assert.equal(typeof patch.replacement, "string");
    assert.equal(output.split(patch.find).length, 2, "pinned Finder patch anchor must match exactly once");
    output = output.replace(patch.find, () => patch.replacement);
  }
  return output;
}

async function serveSemanticMapFeasibilityFixture(template: string, refreshFinder = false): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const childProbe = `<script>
    (function () {
      const nonce = "semantic-map-e0-fixture";
      let accepted = false;
      window.addEventListener("message", function (event) {
        if (accepted || event.source !== parent || event.data?.channel !== "semantic-map-e0-bootstrap" || event.data?.nonce !== nonce || event.ports.length !== 1) return;
        accepted = true;
        const port = event.ports[0];
        port.onmessage = function (message) {
          if (message.data?.type === "mutate") {
            const finder = Archify.finder;
            const svg = document.querySelector(".diagram-container svg");
            const initialCount = finder.count;
            const cameraBefore = Archify.view.state();
            const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
            node.setAttribute("data-node-id", "e0-live-node");
            node.setAttribute("data-node-label", "E0 Live Node");
            node.setAttribute("data-animate", "node");
            node.setAttribute("tabindex", "0");
            const shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            shape.setAttribute("x", "100");
            shape.setAttribute("y", "100");
            shape.setAttribute("width", "160");
            shape.setAttribute("height", "60");
            node.appendChild(shape);
            const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
            label.textContent = "E0 Live Node";
            node.appendChild(label);
            svg.appendChild(node);
            const inserted = Boolean(svg.querySelector('[data-node-id="e0-live-node"]'));
            node.setAttribute("data-node-status", "running");
            const statusUpdated = node.getAttribute("data-node-status") === "running";
            const cameraAfterStatus = Archify.view.state();
            const probeFinder = function () {
              if (${JSON.stringify(refreshFinder)}) finder.refresh();
              finder.open();
              const input = document.getElementById("node-finder-input");
              input.value = "e0-live-node";
              input.dispatchEvent(new Event("input", { bubbles: true }));
              return {
                nodePresent: Boolean(svg.querySelector('[data-node-id="e0-live-node"]')),
                count: finder.count,
                searchResults: document.querySelectorAll("#node-finder-results .node-finder-result").length,
                selected: finder.select("e0-live-node"),
                activeFocus: Archify.focus.active()
              };
            };
            // Probe while attached: failure after removal alone cannot demonstrate a stale index.
            const whileInserted = probeFinder();
            node.remove();
            const afterRemoval = probeFinder();
            port.postMessage({ type: "mutation-result", origin: self.origin, sandboxOrigin: location.origin, initialCount, inserted, statusUpdated, whileInserted, afterRemoval, cameraBefore, cameraAfterStatus, cameraAfter: Archify.view.state(), frameWidth: document.querySelector(".diagram-container").clientWidth });
          } else if (message.data?.type === "measure") {
            port.postMessage({ type: "measure-result", camera: Archify.view.state(), frameWidth: document.querySelector(".diagram-container").clientWidth });
          }
        };
        port.start();
        port.postMessage({ type: "ready", origin: self.origin, sandboxOrigin: location.origin, finderCount: Archify.finder.count, initialNodeCount: document.querySelectorAll(".diagram-container svg [data-node-id]").length });
      }, { once: true });
    })();
  </script>`;
  const childHtml = template.replace("</body>", `${childProbe}</body>`);
  assert.notEqual(childHtml, template, "fixture shim must be appended without changing the pinned input");
  const parentHtml = `<!doctype html><meta charset="utf-8"><div id="map-host"></div><script>
    window.__mapMessages = [];
    window.mountSemanticMap = function () {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.src = "/archify.html";
      frame.addEventListener("load", function () {
        const channel = new MessageChannel();
        window.__semanticMapPort = channel.port1;
        channel.port1.onmessage = function (event) { window.__mapMessages.push(event.data); };
        channel.port1.start();
        frame.contentWindow.postMessage({ channel: "semantic-map-e0-bootstrap", nonce: "semantic-map-e0-fixture" }, "*", [channel.port2]);
      }, { once: true });
      window.__semanticMapFrame = frame;
      document.getElementById("map-host").appendChild(frame);
    };
    window.unmountSemanticMap = function () {
      window.__semanticMapPort?.close();
      window.__semanticMapPort = null;
      window.__semanticMapFrame?.remove();
      window.__semanticMapFrame = null;
    };
    window.mountSemanticMap();
  </script>`;
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    requests.push(path);
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
      response.end(parentHtml);
      return;
    }
    if (path === "/archify.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" });
      response.end(childHtml);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${String(address.port)}`, requests, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }) };
}

for (const refreshFinder of [false, true]) {
void test(`Pinned Archify E0 sandbox spike ${refreshFinder ? "refreshes Finder with a localized patch" : "demonstrates the unpatched static Finder index"}`, { skip: !browserPath, timeout: 120_000 }, async () => {
  const fixture = readFileSync(new URL("../../../trajectory/test/fixtures/semantic-map-feasibility/archify-template.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(Buffer.byteLength(fixture), 774_866);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(fixture).digest("hex"), "505f1c6baa9c2454475c048aa75df8abd867e680e7b3b794b9218a95a56fc370");
  const server = await serveSemanticMapFeasibilityFixture(refreshFinder ? applyFeasibilityFinderPatch(fixture) : fixture, refreshFinder);
  try {
    await withChrome(`${server.url}/`, async (page) => {
      await waitFor(page, `location.origin === ${JSON.stringify(server.url)}`);
      await page.command("Network.enable");
      const browserRequests: string[] = [];
      page.on("Network.requestWillBeSent", (params) => { if (typeof params.request === "object" && params.request !== null && typeof (params.request as CdpRecord).url === "string") browserRequests.push(String((params.request as CdpRecord).url)); });
      const parentDiagnostics = await page.evaluate("JSON.stringify({href: location.href, state: document.readyState, mapMessages: typeof window.__mapMessages, body: document.body.textContent})");
      assert.equal(await page.evaluate("Array.isArray(window.__mapMessages)"), true, `test page setup failed: ${String(parentDiagnostics)}`);
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'ready')");
      const ready = await page.evaluate("window.__mapMessages.find((message) => message.type === 'ready')");
      assert.equal((ready as CdpRecord).origin, "null", "the viewer must run in an opaque-origin allow-scripts sandbox");
      assert.equal(await page.evaluate("document.querySelector('iframe').getAttribute('sandbox')"), "allow-scripts");
      await page.evaluate("window.__semanticMapPort.postMessage({ type: 'mutate' })");
      await waitFor(page, "window.__mapMessages?.some((message) => message.type === 'mutation-result')");
      const result = await page.evaluate("window.__mapMessages.find((message) => message.type === 'mutation-result')") as CdpRecord;
      assert.equal(Number((ready as CdpRecord).finderCount), 0, "the pinned template ships an empty static SVG shell, not live graph data");
      assert.equal(Number((ready as CdpRecord).initialNodeCount), 0);
      assert.equal(result.inserted, true);
      assert.equal(result.statusUpdated, true);
      const whileInserted = result.whileInserted as CdpRecord;
      assert.equal(whileInserted.nodePresent, true, "search and selection must be probed BEFORE the inserted node is removed");
      assert.equal(whileInserted.count, refreshFinder ? 1 : result.initialCount, "the localized refresh must index the attached node");
      assert.equal(whileInserted.searchResults, refreshFinder ? 1 : 0, "search must see the attached node only after explicit refresh");
      assert.equal(whileInserted.selected, refreshFinder, "the patched public selection API must accept the attached live node");
      if (refreshFinder) assert.equal(whileInserted.activeFocus, "e0-live-node", "successful selection must actually focus the inserted graph node");
      const afterRemoval = result.afterRemoval as CdpRecord;
      assert.equal(afterRemoval.nodePresent, false, "removal is a separate observation after the live-node probe");
      assert.equal(afterRemoval.count, result.initialCount);
      assert.equal(afterRemoval.searchResults, 0);
      assert.equal(afterRemoval.selected, false);
      assert.deepEqual(result.cameraAfterStatus, result.cameraBefore, "insertion/status mutation does not move the camera before explicit selection");
      await page.command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.evaluate("window.__semanticMapPort.postMessage({ type: 'measure' })");
      await waitFor(page, "window.__mapMessages?.some((message) => message.type === 'measure-result')");
      const measured = await page.evaluate("window.__mapMessages.find((message) => message.type === 'measure-result')") as CdpRecord;
      assert.ok(Number(measured.frameWidth) > 0, "opaque sandbox renders its local SVG after resize");
      assert.ok(Number.isFinite(Number((measured.camera as CdpRecord).scale)), "camera remains usable after graph mutation and resize");
      assert.deepEqual(server.requests.filter((path) => path.startsWith("/")), ["/", "/archify.html"], "the self-contained viewer makes no additional local requests or socket connections");
      assert.equal(browserRequests.some((url) => /^wss?:/i.test(url)), false, "the isolated viewer opens no WebSocket");
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await page.evaluate("window.__mapMessages = []; window.unmountSemanticMap(); window.mountSemanticMap()");
        await waitFor(page, "window.__mapMessages?.some((message) => message.type === 'ready')");
        assert.equal(await page.evaluate("document.querySelectorAll('#map-host iframe').length"), 1, "dispose removes the previous browsing context before reopen");
      }
    });
  } finally { await server.close(); }
});
}
