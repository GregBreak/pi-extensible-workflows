import assert from "node:assert/strict";
import test from "node:test";
import { adaptSemanticSnapshot, type SemanticSnapshot } from "../src/semantic-map/adapter.js";

function source(overrides: Partial<SemanticSnapshot> = {}): SemanticSnapshot {
  return {
    scope: { publisherId: "publisher", targetKind: "run", targetId: "run" },
    run: { id: "run", workflowName: "review", state: "running", agents: [
      { id: "a/b", name: "Root", state: "completed", attempts: 2, attemptDetails: [{ attempt: 1, error: { code: "failed" } }, { attempt: 2 }], toolCalls: [{ id: "tool-1", name: "read", state: "completed" }], output: { status: "available" } },
      { id: "child", name: "Child", state: "stopped", parentId: "a/b", structuralPath: ["phase", "review"], output: { status: "cancelled" } }
    ] },
    ...overrides
  };
}

void test("semantic adapter uses collision-safe stable tuple identities and ignores presentation order", () => {
  const base = source();
  const baseRun = base.run;
  if (!baseRun) throw new Error("Test run is missing");
  const first = adaptSemanticSnapshot(base);
  const reordered = adaptSemanticSnapshot(source({ run: { ...baseRun, agents: [...(baseRun.agents ?? [])].reverse() } }));
  assert.deepEqual(first, reordered);
  const otherScope = adaptSemanticSnapshot(source({ scope: { publisherId: "publisher", targetKind: "run", targetId: "other" } }));
  assert.notEqual(first.nodes[0]?.id, otherScope.nodes[0]?.id);
  const components = adaptSemanticSnapshot(source({ run: { id: "r", state: "running", agents: [{ id: "a/b", state: "running" }, { id: "a", state: "running" }, { id: "b", state: "running" }] } }));
  const ids = components.nodes.filter((node) => node.kind === "agent").map((node) => node.id);
  assert.equal(new Set(ids).size, 3, "separator-like ID components remain distinct tuples");
  const duplicates = { scope: { publisherId: "p", targetKind: "run" as const, targetId: "r" }, run: { id: "r", state: "running", agents: [{ id: "same", name: "z", state: "running" }, { id: "same", name: "a", state: "failed" }] } };
  const duplicateGraph = adaptSemanticSnapshot(duplicates);
  const duplicateGraphReordered = adaptSemanticSnapshot({ ...duplicates, run: { ...duplicates.run, agents: [...duplicates.run.agents].reverse() } });
  assert.deepEqual(duplicateGraph, duplicateGraphReordered);
  assert.ok(duplicateGraph.completeness.omittedNodes >= 1);
});

void test("semantic adapter preserves cancellation, missing output, recorded retry and explicit relations only", () => {
  const baseRun = source().run;
  if (!baseRun) throw new Error("Test run is missing");
  const graph = adaptSemanticSnapshot(source({
    run: { ...baseRun, retry: { sourceRunId: "prior" }, agents: [
      { id: "cancel", state: "stopped", output: { status: "cancelled" } },
      { id: "unknown", state: "completed" },
      { id: "budget", state: "budget_exhausted" },
      { id: "retry", state: "failed", attempts: 2, attemptDetails: [{ attempt: 1, error: { code: "AGENT_FAILED" } }, { attempt: 2 }] }
    ] },
    relations: [{ kind: "fork", fromAgentId: "cancel", toAgentId: "unknown", evidence: "recorded" }, { kind: "merge", fromAgentId: "unknown", toAgentId: "retry", evidence: "recorded" }]
  }));
  assert.equal(graph.nodes.find((node) => node.sourceRef === "cancel" && node.kind === "agent")?.state, "cancelled");
  assert.equal(graph.nodes.find((node) => node.sourceRef === "unknown" && node.kind === "result")?.state, "unknown");
  assert.equal(graph.nodes.find((node) => node.sourceRef === "budget" && node.kind === "agent")?.rawStatus, "budget_exhausted");
  assert.equal(graph.edges.filter((edge) => edge.kind === "retry").length, 2, "only explicit attempt history and retry provenance create retry edges");
  assert.ok(graph.edges.some((edge) => edge.kind === "fork"));
  assert.ok(graph.edges.some((edge) => edge.kind === "merge"));
  const parentRun = source().run;
  if (!parentRun) throw new Error("Test run is missing");
  const parentOnly = adaptSemanticSnapshot(source({ run: { ...parentRun, agents: [{ id: "one", state: "completed" }] } }));
  assert.equal(parentOnly.edges.some((edge) => edge.kind === "retry"), false);
  const relations = [
    { kind: "dependency" as const, fromAgentId: "a/b", toAgentId: "child", id: "d", evidence: "recorded" as const },
    { kind: "fork" as const, fromAgentId: "a/b", toAgentId: "child", id: "f", evidence: "recorded" as const }
  ];
  const ordered = adaptSemanticSnapshot(source({ relations }));
  const reversed = adaptSemanticSnapshot(source({ relations: [...relations].reverse() }));
  assert.deepEqual(ordered, reversed);
});

void test("invalid parents, cycles, missing relation endpoints and partial metadata stay explicit", () => {
  const graph = adaptSemanticSnapshot(source({
    run: { id: "run", state: "running", agents: [{ id: "a", state: "running", parentId: "b" }, { id: "b", state: "running", parentId: "a" }, { id: "c", state: "running", parentId: "missing" }] },
    relations: [{ kind: "dependency", fromAgentId: "a", toAgentId: "absent", evidence: "recorded" }],
    partial: { reasons: ["publisher snapshot clipped"], omittedNodes: 4, omittedEdges: 2 }
  }));
  assert.equal(graph.completeness.partial, true);
  assert.ok(graph.completeness.reasons.some((reason) => reason.includes("parent")));
  assert.ok(graph.completeness.reasons.some((reason) => reason.includes("endpoint")));
  assert.ok(graph.completeness.omittedNodes >= 4 && graph.completeness.omittedEdges >= 2);
});

void test("standalone subagent attempts and tool calls use their own stable scope", () => {
  const graph = adaptSemanticSnapshot({
    scope: { publisherId: "publisher", targetKind: "subagent", targetId: "solo" },
    subagent: { id: "solo", label: "Standalone", state: "completed", attempts: 2, attemptDetails: [{ attempt: 1, error: { code: "RETRY" } }, { attempt: 2 }], output: { status: "available" }, progress: { toolCalls: [{ id: "call", name: "grep", state: "completed" }] } }
  });
  assert.ok(graph.nodes.some((node) => node.kind === "tool-call" && node.sourceRef === "solo/call"));
  assert.equal(graph.edges.filter((edge) => edge.kind === "retry").length, 1);
  assert.equal(graph.scope.targetKind, "subagent");
});

void test("causal cycles are omitted deterministically rather than presented as a DAG", () => {
  const base = { scope: { publisherId: "p", targetKind: "run" as const, targetId: "r" }, run: { id: "r", state: "running", agents: [{ id: "a", state: "running" }, { id: "b", state: "running" }] } };
  const relations = [
    { kind: "dependency" as const, fromAgentId: "a", toAgentId: "b", evidence: "recorded" as const },
    { kind: "dependency" as const, fromAgentId: "b", toAgentId: "a", evidence: "recorded" as const }
  ];
  const graph = adaptSemanticSnapshot({ ...base, relations });
  const reordered = adaptSemanticSnapshot({ ...base, relations: [...relations].reverse() });
  assert.deepEqual(graph, reordered);
  assert.equal(graph.edges.filter((edge) => edge.kind === "dependency").length, 1);
  assert.ok(graph.completeness.reasons.some((reason) => reason.includes("Cyclic")));
  assert.ok(graph.completeness.omittedEdges >= 1);
  const endpointA = adaptSemanticSnapshot({ ...base, run: { ...base.run, agents: [...base.run.agents, { id: "c", state: "running" }] }, relations: [{ kind: "dependency", id: "same-edge", fromAgentId: "a", toAgentId: "b", evidence: "recorded" }] });
  const endpointB = adaptSemanticSnapshot({ ...base, run: { ...base.run, agents: [...base.run.agents, { id: "c", state: "running" }] }, relations: [{ kind: "dependency", id: "same-edge", fromAgentId: "c", toAgentId: "b", evidence: "recorded" }] });
  assert.notEqual(endpointA.edges.find((edge) => edge.kind === "dependency")?.id, endpointB.edges.find((edge) => edge.kind === "dependency")?.id);
});

void test("labels are bounded text, not executable markup or URL fields", () => {
  const graph = adaptSemanticSnapshot(source({ run: { id: "r", state: "running", agents: [{ id: "a", name: '<img src=x onerror="alert(1)"> javascript:alert(2)', state: "running" }] } }));
  const item = graph.nodes.find((node) => node.kind === "agent");
  assert.ok(item?.label.includes("<img"));
  assert.equal(item && Object.hasOwn(item, "url"), false);
  assert.equal(item && Object.hasOwn(item, "output"), false);
  const privateSource = {
    scope: { publisherId: "p", targetKind: "run", targetId: "r" },
    run: { id: "r", state: "running", script: "secret script", environment: { TOKEN: "secret" }, agents: [{ id: "a", state: "running", prompt: "private prompt", systemPrompt: "private system", toolCalls: [{ id: "call", name: "read", state: "running", arguments: { secret: "private args" } }], output: { status: "available", value: "private output" } }] }
  } as unknown as SemanticSnapshot;
  const safeGraph = JSON.stringify(adaptSemanticSnapshot(privateSource));
  for (const secret of ["secret script", "secret", "private prompt", "private system", "private args", "private output"]) assert.equal(safeGraph.includes(secret), false);
});

void test("graph caps omit rather than retain stale nodes and expose bounded partiality", () => {
  const agents = Array.from({ length: 300 }, (_, index) => ({ id: `agent-${String(index).padStart(3, "0")}`, state: "running", toolCalls: [{ id: `tool-${String(index)}`, name: "read", state: "running" }] }));
  const graph = adaptSemanticSnapshot({ scope: { publisherId: "p", targetKind: "run", targetId: "r" }, run: { id: "r", state: "running", agents } });
  assert.ok(graph.nodes.length <= 500);
  assert.ok(graph.nodes.some((node) => node.kind === "workflow"));
  assert.ok(graph.edges.length <= 1500);
  assert.equal(graph.completeness.partial, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(graph)).byteLength <= 512 * 1024);
  const reduced = adaptSemanticSnapshot({ scope: { publisherId: "p", targetKind: "run", targetId: "r" }, run: { id: "r", state: "running", agents: [] } });
  assert.equal(reduced.nodes.length, 1);
  assert.equal(reduced.nodes.some((node) => node.id === graph.nodes[1]?.id), false);
});

void test("scope and identifiers reject malformed or oversized identity components", () => {
  assert.throws(() => adaptSemanticSnapshot(source({ scope: { publisherId: "p".repeat(129), targetKind: "run", targetId: "r" } })), /Invalid semantic map publisher id/);
  assert.throws(() => adaptSemanticSnapshot(source({ scope: { publisherId: "p", targetKind: "run", targetId: "" } })), /Invalid semantic map target id/);
});
