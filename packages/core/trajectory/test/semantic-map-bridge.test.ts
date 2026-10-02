import assert from "node:assert/strict";
import test from "node:test";
import { isSemanticMapNodeId, isValidSemanticMapBridgeEnvelope } from "../src/semantic-map/bridge.js";
import { projectCurrentSemanticSnapshot } from "../src/semantic-map/index.js";
import { adaptSemanticSnapshot } from "../src/semantic-map/adapter.js";

void test("Semantic Map bridge accepts only bounded protocol envelopes and scoped node identifiers", () => {
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ready", version: 1, nonce: "a".repeat(64), instance: "b".repeat(64) }), true);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ready", version: 1, build: "0123456789abcdef", nonce: "a".repeat(64), instance: "b".repeat(64) }), true);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ack", version: 1, build: "0123456789abcdef", nonce: "a".repeat(64), instance: "b".repeat(64) }), false, "only readiness carries the viewer build");
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ready", version: 2, nonce: "a".repeat(64), instance: "b".repeat(64) }), false);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "bootstrap", version: 1 }), false);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ack", version: 1, padding: "x".repeat(512 * 1024) }), false);
  assert.equal(isSemanticMapNodeId("sm-0102ff"), true);
  assert.equal(isSemanticMapNodeId("sm-xyz"), false);
  assert.equal(isSemanticMapNodeId("sm-01\n"), false);
});

void test("Semantic Map parent projection is bounded, explicit, and excludes prompts, arguments, and output values", () => {
  const secret = "private fixture payload";
  const found = {
    publisher: { id: "pub", generation: "publisher-generation", connected: true },
    target: { kind: "run" as const, publisherId: "pub", id: "run" },
    record: {
      run: {
        id: "run", workflowName: "Fixture workflow", state: "running", retry: { sourceRunId: "previous-run" },
        agents: [{
          id: "agent", name: "Worker", label: "Worker", state: "running", attempts: 2, structuralPath: ["phase"], parentId: undefined,
          prompt: secret, output: { status: "available", value: secret },
          attemptDetails: [{ attempt: 1, error: { code: "RETRY", message: secret }, setup: { cwd: secret } }, { attempt: 2 }],
          toolCalls: [{ id: "metadata-call", name: "read", state: "completed" }],
        }, { id: "other", name: "Other", state: "queued", output: { status: "pending" } }],
        relations: [{ kind: "dependency", fromAgentId: "agent", toAgentId: "other", evidence: "recorded" }],
        parentRunId: "unproven-parent",
      },
      transcripts: { agent: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "cached-call", name: "read", arguments: { path: secret } }] } }] },
      snapshot: { script: secret, args: { token: secret } },
    },
  };
  const context = {
    state: { transcripts: { "pub\trun\tagent": found.record.transcripts.agent } },
    selected: () => found,
    setView: () => undefined,
    staticExport: false,
  } as unknown as Parameters<typeof projectCurrentSemanticSnapshot>[0];
  const projection = projectCurrentSemanticSnapshot(context);
  assert.ok(projection);
  assert.equal(projection.identity, '["pub","publisher-generation","run","run"]');
  assert.equal(projection.snapshot.run?.retry?.sourceRunId, "previous-run");
  assert.equal(projection.snapshot.relations?.length, 1);
  const projectedRun = projection.snapshot.run;
  assert.ok(projectedRun);
  const projectedAgents = projectedRun.agents;
  assert.ok(projectedAgents);
  const projectedAgent = projectedAgents[0];
  assert.ok(projectedAgent);
  assert.deepEqual(projectedAgent.events?.map((event) => [event.kind, event.id ?? event.name]), [["assistant", "Assistant"], ["tool", "cached-call"]], "cached transcript becomes a kinds-only event sequence");
  assert.equal(projectedAgent.toolCalls?.length, 0, "recorded calls are only a fallback when no transcript is cached");
  assert.equal(projectedAgents[1]?.toolCalls?.length, 0);
  assert.equal(projectedAgent.attemptDetails?.[0]?.error?.code, "RETRY");
  const serialized = JSON.stringify(projection.snapshot);
  assert.ok(new TextEncoder().encode(serialized).byteLength <= 512 * 1024);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('"arguments":'), false);
  assert.equal(serialized.includes("parentRunId"), false);
  const graph = adaptSemanticSnapshot(projection.snapshot);
  const agentNode = graph.nodes.find((node) => node.kind === "agent" && node.sourceRef === "agent");
  assert.ok(agentNode);
  assert.deepEqual(projection.nodes.get(agentNode.id), { id: agentNode.id, kind: "agent", sourceRef: "agent" });
  assert.equal(graph.completeness.partial, true);
  assert.ok(graph.nodes.some((node) => node.kind === "tool-call"));
  assert.ok(graph.edges.some((edge) => edge.kind === "retry"));
  assert.equal(agentNode.attempts, 2); assert.equal(agentNode.failedAttempts, 1);
  assert.ok(!graph.nodes.some((node) => node.kind === "agent" && node.label.includes("attempt")), "retries are drawn on one card, never as copies");
  assert.equal(projectCurrentSemanticSnapshot({ ...context, selected: () => undefined }), undefined);
});

void test("Semantic Map parent projection bounds dense metadata and indexes at most 500 visible IDs", () => {
  const agents = Array.from({ length: 60 }, (_, index) => ({
    id: `agent-${String(index).padStart(3, "0")}`, name: "N".repeat(120), label: "L".repeat(120), state: "running", attempts: 8,
    structuralPath: Array.from({ length: 8 }, () => "P".repeat(80)),
    attemptDetails: Array.from({ length: 8 }, (_, attempt) => ({ attempt: attempt + 1, error: { code: "RETRY" } })),
    output: { status: "pending" }
  }));
  const calls = Array.from({ length: 100 }, (_, index) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `${"c".repeat(120)}-${String(index).padStart(3, "0")}`, name: "T".repeat(120), arguments: { secret: "not projected" } }] } }));
  const relations = Array.from({ length: 100 }, (_, index) => ({ kind: "fork" as const, fromAgentId: "agent-000", toAgentId: "agent-001", id: `relation-${String(index)}`, evidence: "recorded" as const }));
  const found = {
    publisher: { id: "pub", generation: 4, connected: true },
    target: { kind: "run" as const, publisherId: "pub", id: "run" },
    record: { run: { id: "run", workflowName: "dense", state: "running", agents, relations } }
  };
  const context = {
    state: { transcripts: { "pub\trun\tagent-000": calls } },
    selected: () => found,
    setView: () => undefined,
    staticExport: false
  } as unknown as Parameters<typeof projectCurrentSemanticSnapshot>[0];
  const projection = projectCurrentSemanticSnapshot(context);
  assert.ok(projection);
  const denseRun = projection.snapshot.run;
  assert.ok(denseRun);
  const denseAgents = denseRun.agents;
  assert.ok(denseAgents);
  assert.ok(denseAgents.length > 0 && denseAgents.length <= 16);
  assert.ok((projection.snapshot.relations?.length ?? 0) <= 8);
  assert.equal(projection.snapshot.run?.agents?.[0]?.events?.length, 48);
  assert.ok(projection.nodes.size <= 500);
  assert.equal(projection.nodeCount, projection.nodes.size);
  const graph = adaptSemanticSnapshot(projection.snapshot);
  assert.equal(graph.nodes.length, projection.nodeCount, JSON.stringify({ inputBytes: new TextEncoder().encode(JSON.stringify(projection.snapshot)).byteLength, projectedAgents: denseAgents.length, graphNodes: graph.nodes.length, nodeIndex: projection.nodeCount, partial: graph.completeness.reasons }));
  for (const node of graph.nodes) assert.deepEqual(projection.nodes.get(node.id), { id: node.id, kind: node.kind, sourceRef: node.sourceRef });
  assert.ok(new TextEncoder().encode(JSON.stringify(projection.snapshot)).byteLength <= 512 * 1024);
  assert.ok(projection.snapshot.partial?.reasons?.includes("Transcript event projection bounded"));
  assert.ok(projection.snapshot.partial?.reasons?.includes("Recorded relation list bounded"));
});
