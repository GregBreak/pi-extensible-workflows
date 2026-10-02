import assert from "node:assert/strict";
import test from "node:test";
import { adaptSemanticSnapshot, type SemanticSnapshot } from "../src/semantic-map/adapter.js";
import { SemanticAgentLayout, SEMANTIC_CARD } from "../src/semantic-map/layout.js";

const snapshot = (): SemanticSnapshot => ({
  scope: { publisherId: "p", targetKind: "run", targetId: "run" },
  run: { id: "run", workflowName: "Grouped workflow", state: "running", agents: [
    { id: "same/name", name: "Repeated label", state: "running", structuralPath: ["shared"], attempts: 2, attemptDetails: [{ attempt: 1, error: { code: "FAILED" } }, { attempt: 2 }], toolCalls: [{ id: "call/1", name: "read", state: "completed" }], output: { status: "pending" } },
    { id: "same", name: "Repeated label", state: "queued", structuralPath: ["shared"], parentId: "same/name", toolCalls: [{ id: "name/call/1", name: "read", state: "completed" }], output: { status: "available" } }
  ] }
});

const phased = (): SemanticSnapshot => ({
  scope: { publisherId: "p", targetKind: "run", targetId: "run" },
  run: { id: "run", workflowName: "wf", state: "running", agents: [
    { id: "docs", name: "scout-docs", state: "completed", structuralPath: ["discover", "docs"], phase: "discover", phaseIndex: 0, launch: 0, output: { status: "available" },
      events: [{ kind: "system" }, { kind: "user" }, { kind: "assistant" }, { kind: "tool", id: "c1", name: "ls", state: "completed" }, { kind: "assistant" }, { kind: "tool", id: "c2", name: "read", state: "failed" }, { kind: "assistant" }] },
    { id: "src", name: "scout-src", state: "completed", structuralPath: ["discover", "source"], phase: "discover", phaseIndex: 0, launch: 1, output: { status: "available" } },
    { id: "synth", name: "synthesizer", state: "running", phase: "synthesize", phaseIndex: 1, launch: 2, attempts: 3, attemptDetails: [{ attempt: 1, error: { code: "X" } }, { attempt: 2, error: { code: "X" } }, { attempt: 3 }], output: { status: "pending" } }
  ] }
});

void test("each agent is one box with exact recorded ownership; workflow and scope nodes are not drawn as cards", () => {
  const graph = adaptSemanticSnapshot(snapshot());
  const layout = new SemanticAgentLayout().arrange(graph);
  assert.deepEqual(layout.groups.map((group) => group.agentId).sort(), ["same", "same/name"]);
  assert.equal(layout.groups.filter((group) => group.label === "Repeated label").length, 2, "same names do not merge agents");
  for (const node of graph.nodes) {
    const slot = layout.slots.get(node.id);
    if (node.agentId === undefined) { assert.equal(slot, undefined, "workflow/scope information is written on the boxes instead"); continue; }
    assert.ok(slot);
    const group = layout.groups.find((item) => item.id === slot.group); assert.ok(group);
    assert.equal(group.agentId, node.agentId);
    assert.ok(slot.x >= group.x && slot.x + SEMANTIC_CARD.width <= group.x + group.width);
    assert.ok(slot.y >= group.y + 40 && slot.y + SEMANTIC_CARD.height <= group.y + group.height);
  }
  assert.equal(new Set(layout.groups.map((group) => group.colorIndex)).size, layout.groups.length, "each agent gets its own background color");
  assert.equal(layout.groups.find((group) => group.agentId === "same/name")?.running, true, "running agents are flagged for emphasis");
  assert.equal(layout.groups.find((group) => group.agentId === "same")?.running, false);
  for (const first of layout.groups) for (const second of layout.groups) {
    if (first.id === second.id) continue;
    assert.ok(first.x + first.width <= second.x || second.x + second.width <= first.x || first.y + first.height <= second.y || second.y + second.height <= first.y, "group frames never overlap");
  }
});

void test("retries are one card with attempt counts and failures, never copies", () => {
  const graph = adaptSemanticSnapshot(phased());
  const synth = graph.nodes.find((node) => node.kind === "agent" && node.agentId === "synth");
  assert.ok(synth);
  assert.deepEqual([synth.attempts, synth.failedAttempts], [3, 2]);
  assert.equal(graph.nodes.filter((node) => node.agentId === "synth" && node.kind === "agent").length, 1);
  assert.equal(graph.nodes.find((node) => node.kind === "agent" && node.agentId === "docs")?.attempts, undefined, "single attempts carry no counter");
});

void test("transcript events form one recorded sequence per agent, laid out as a serpentine inside the box", () => {
  const graph = adaptSemanticSnapshot(phased());
  const docs = graph.nodes.filter((node) => node.agentId === "docs").sort((a, b) => (a.kind === "agent" ? -1 : 0) - (b.kind === "agent" ? -1 : 0) || (a.order ?? 0) - (b.order ?? 0));
  assert.deepEqual(docs.map((node) => node.kind), ["agent", "system", "user", "assistant", "tool-call", "assistant", "tool-call", "assistant", "result"]);
  const kinds = (kind: string) => graph.edges.filter((edge) => edge.kind === kind && graph.nodes.find((node) => node.id === edge.from)?.agentId === "docs").length;
  assert.equal(kinds("invokes"), 2, "assistant → tool");
  assert.equal(kinds("sequence"), 5, "agent → system → user → assistant, and each tool → next assistant");
  assert.equal(kinds("produces"), 1, "last event → result");
  assert.ok(graph.nodes.some((node) => node.kind === "tool-call" && node.sourceRef === "docs/c2" && node.state === "failure"));
  const layout = new SemanticAgentLayout().arrange(graph);
  const positions = docs.map((node) => { const slot = layout.slots.get(node.id); assert.ok(slot); return [slot.row, slot.col]; });
  assert.deepEqual(positions, [[0, 0], [0, 1], [0, 2], [1, 2], [1, 1], [1, 0], [2, 0], [2, 1], [2, 2]]);
});

void test("recorded phases become stage rows joined by phase hand-over arrows", () => {
  const graph = adaptSemanticSnapshot(phased());
  const layout = new SemanticAgentLayout().arrange(graph);
  const group = (agentId: string) => { const value = layout.groups.find((item) => item.agentId === agentId); assert.ok(value); return value; };
  assert.equal(group("docs").y, group("src").y, "agents of one phase share a row");
  assert.ok(group("docs").x < group("src").x, "launch order inside the row");
  assert.ok(group("synth").y > group("docs").stageBottom, "the next phase starts below the previous row");
  assert.deepEqual(layout.stages.map((stage) => stage.label), ["discover", "synthesize"]);
  const phase = graph.edges.filter((edge) => edge.kind === "phase");
  assert.equal(phase.length, 2, "each discover result hands over to the synthesizer");
  const synthAgent = graph.nodes.find((node) => node.kind === "agent" && node.agentId === "synth");
  assert.ok(phase.every((edge) => edge.to === synthAgent?.id && graph.nodes.find((node) => node.id === edge.from)?.kind === "result"));
});

void test("status-only updates preserve all positions; adding an agent preserves existing slots", () => {
  const input = snapshot();
  const engine = new SemanticAgentLayout();
  const first = engine.arrange(adaptSemanticSnapshot(input));
  const run = input.run; assert.ok(run?.agents);
  const completedAgents = run.agents.map((agent) => ({ ...agent, state: "completed" }));
  const changed: SemanticSnapshot = { ...input, run: { ...run, agents: completedAgents } };
  const updated = engine.arrange(adaptSemanticSnapshot(changed));
  assert.deepEqual([...updated.slots], [...first.slots]);
  assert.equal(updated.height, first.height);
  const inserted = engine.arrange(adaptSemanticSnapshot({ ...changed, run: { ...run, agents: [...completedAgents, { id: "z-new", name: "new", state: "running" }] } }));
  for (const [id, slot] of first.slots) assert.deepEqual(inserted.slots.get(id), slot);
  const reduced = engine.arrange(adaptSemanticSnapshot({ ...input, run: { ...run, agents: [] } }));
  assert.equal(reduced.groups.length, 0);
  assert.equal(reduced.slots.size, 0);
});

void test("standalone subagent is one group and label markup remains inert data", () => {
  const graph = adaptSemanticSnapshot({ scope: { publisherId: "p", targetKind: "subagent", targetId: "solo" }, subagent: { id: "solo", label: '<img onerror="bad()">', state: "running", attempts: 1, attemptDetails: [{ attempt: 1 }], progress: { toolCalls: [{ id: "call", name: "read", state: "running" }] } } });
  const layout = new SemanticAgentLayout().arrange(graph);
  assert.equal(layout.groups.length, 1);
  const group = layout.groups[0]; assert.ok(group);
  assert.equal(group.agentId, "solo");
  assert.equal(group.count, 3, "agent, tool and result");
  assert.equal(group.label, '<img onerror="bad()">');
  assert.ok(graph.nodes.filter((node) => node.kind !== "workflow").every((node) => node.agentId === "solo"));
});

void test("scopes derive a recorded status instead of showing unknown", () => {
  const graph = adaptSemanticSnapshot(snapshot());
  assert.equal(graph.nodes.find((node) => node.kind === "task" && node.label === "shared")?.rawStatus, "running", "a scope with a running agent is running");
  const done = adaptSemanticSnapshot({ scope: { publisherId: "p", targetKind: "run", targetId: "run" }, run: { id: "run", state: "completed", agents: [
    { id: "a", state: "completed", structuralPath: ["discover"], attempts: 2, attemptDetails: [{ attempt: 1 }, { attempt: 2 }], output: { status: "available" } },
    { id: "b", state: "failed", structuralPath: ["audit"], output: { status: "failed" } }
  ] } });
  assert.equal(done.nodes.find((node) => node.label === "discover")?.state, "success");
  assert.equal(done.nodes.find((node) => node.label === "audit")?.state, "failure");
  assert.ok(!done.nodes.some((node) => node.state === "unknown"), "no unknown states for recorded agents, scopes or results");
});

void test("token usage is projected per agent and as a run total, without inventing context", () => {
  const graph = adaptSemanticSnapshot({ scope: { publisherId: "p", targetKind: "run", targetId: "run" }, run: { id: "run", state: "running", agents: [
    { id: "a", state: "completed", usage: { input: 1200, output: 300, cacheRead: 50, cacheWrite: 7, context: 1557 } },
    { id: "b", state: "running", usage: { input: 10, output: Number.NaN, cacheRead: -4, cacheWrite: 1 } },
    { id: "c", state: "queued" }
  ] } });
  const usage = graph.usage; assert.ok(usage);
  assert.deepEqual(usage.total, { input: 1210, output: 300, cacheRead: 50, cacheWrite: 8 });
  assert.deepEqual(usage.agents.map((item) => [item.agentId, item.usage.context]), [["a", 1557], ["b", undefined]]);
  assert.equal(adaptSemanticSnapshot({ scope: { publisherId: "p", targetKind: "run", targetId: "run" }, run: { id: "run", state: "running", agents: [{ id: "a", state: "queued" }] } }).usage, undefined);
});
