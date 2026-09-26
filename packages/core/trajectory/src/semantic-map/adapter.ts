import { SEMANTIC_MAP_LIMITS } from "../semantic-map-build.js";

export type SemanticNodeKind = "workflow" | "task" | "agent" | "tool-call" | "result";
export type SemanticRelationKind = "contains" | "invokes" | "produces" | "dependency" | "fork" | "merge" | "retry";
export type SemanticState = "running" | "success" | "failure" | "queued" | "waiting" | "paused" | "retrying" | "cancelled" | "interrupted" | "unknown";
export type SemanticNode = { id: string; kind: SemanticNodeKind; label: string; state: SemanticState; rawStatus: string; evidence: "recorded" | "structural" | "unavailable"; sourceRef: string };
export type SemanticEdge = { id: string; from: string; to: string; kind: SemanticRelationKind; evidence: "recorded" | "structural" };
export type SemanticGraph = {
  schemaVersion: 1;
  scope: { publisherId: string; targetKind: "run" | "subagent"; targetId: string; agentId?: string };
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  completeness: { partial: boolean; reasons: string[]; omittedNodes: number; omittedEdges: number };
};
export type SemanticToolCall = { id: string; name: string; state: string };
export type SemanticAttempt = { attempt: number; error?: { code?: string } };
export type SemanticOutput = { status: string };
export type SemanticAgent = {
  id: string; name?: string; label?: string; state: string; parentId?: string;
  structuralPath?: readonly string[]; attempts?: number; attemptDetails?: readonly SemanticAttempt[];
  toolCalls?: readonly SemanticToolCall[]; output?: SemanticOutput;
};
export type SemanticSnapshot = {
  scope: { publisherId: string; targetKind: "run" | "subagent"; targetId: string; agentId?: string };
  run?: { id: string; workflowName?: string; state: string; retry?: { sourceRunId?: string }; agents?: readonly SemanticAgent[] };
  subagent?: { id: string; label?: string; state: string; attempts?: number; attemptDetails?: readonly SemanticAttempt[]; output?: SemanticOutput; progress?: { toolCalls?: readonly SemanticToolCall[] } };
  relations?: readonly { kind: "dependency" | "fork" | "merge"; fromAgentId: string; toAgentId: string; id?: string; evidence: "recorded" }[];
  partial?: { reasons?: readonly string[]; omittedNodes?: number; omittedEdges?: number };
};

const MAX_SOURCE_RECORDS = 2048;
const MAX_TOOL_CALLS = 512;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
const encoder = new TextEncoder();
const allowedStates = new Set<SemanticState>(["running", "success", "failure", "queued", "waiting", "paused", "retrying", "cancelled", "interrupted", "unknown"]);

function boundedText(value: unknown, fallback: string, limit = MAX_LABEL_LENGTH): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, limit).join("") : fallback;
}
function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_LENGTH) throw new Error(`Invalid semantic map ${label}`);
  return value;
}
function targetKindOf(value: unknown): "run" | "subagent" {
  if (value === "run" || value === "subagent") return value;
  throw new Error("Invalid semantic map target kind");
}
function bytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }
function positiveCount(value: unknown): number { return Number.isSafeInteger(value) && typeof value === "number" && value > 0 ? value : 0; }
function tupleId(parts: readonly (string | number)[]): string {
  const raw = JSON.stringify(parts);
  let hex = "";
  for (const byte of encoder.encode(raw)) hex += byte.toString(16).padStart(2, "0");
  return `sm-${hex}`;
}
function stateOf(rawValue: unknown): { state: SemanticState; rawStatus: string } {
  const rawStatus = boundedText(rawValue, "unknown", 40).toLowerCase();
  const mapped: Record<string, SemanticState> = {
    running: "running", completed: "success", success: "success", failed: "failure", failure: "failure",
    queued: "queued", waiting: "waiting", paused: "paused", retrying: "retrying", stopped: "cancelled",
    cancelled: "cancelled", interrupted: "interrupted", budget_exhausted: "failure"
  };
  return { state: mapped[rawStatus] ?? (allowedStates.has(rawStatus as SemanticState) ? rawStatus as SemanticState : "unknown"), rawStatus };
}
function addReason(reasons: Set<string>, reason: string): void { reasons.add(reason); }
function hasPath(from: string, to: string, edges: readonly SemanticEdge[]): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const current = queue.pop();
    if (current === to) return true;
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.from === current && ["dependency", "fork", "merge", "retry"].includes(edge.kind)) queue.push(edge.to);
  }
  return false;
}

/** Builds a privacy-whitelisted, deterministic, bounded graph from Trajectory metadata only. */
export function adaptSemanticSnapshot(input: SemanticSnapshot): SemanticGraph {
  const inputScope: unknown = (input as unknown as { scope?: unknown }).scope;
  if (!inputScope || typeof inputScope !== "object") throw new Error("Invalid semantic map scope");
  const rawScope = inputScope as { publisherId?: unknown; targetKind?: unknown; targetId?: unknown; agentId?: unknown };
  const scope = {
    publisherId: boundedId(rawScope.publisherId, "publisher id"),
    targetKind: targetKindOf(rawScope.targetKind),
    targetId: boundedId(rawScope.targetId, "target id"),
    ...(rawScope.agentId === undefined ? {} : { agentId: boundedId(rawScope.agentId, "agent id") })
  };
  const reasonInput = input.partial?.reasons ?? [];
  const reasons = new Set<string>(reasonInput.slice(0, 32).map((item) => boundedText(item, "partial source", 100)).filter(Boolean));
  reasons.add("Causality is limited to explicitly recorded metadata");
  if (reasonInput.length > 32) reasons.add("Publisher completeness reasons bounded");
  let omittedSourceNodes = 0;
  let omittedSourceEdges = 0;
  const projectCalls = (calls: readonly SemanticToolCall[] = []) => {
    const sorted = calls.slice(0, MAX_SOURCE_RECORDS).map((call) => ({ id: boundedId(call.id, "tool call id"), name: boundedText(call.name, "Tool call"), state: boundedText(call.state, "unknown", 40) }))
      .sort((a, b) => a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const unique = sorted.filter((call, index) => index === 0 || sorted[index - 1]?.id !== call.id);
    const retained = unique.slice(0, MAX_TOOL_CALLS);
    return { calls: retained, omitted: Math.max(0, calls.length - retained.length) };
  };
  const rawAgents = input.run?.agents ?? [];
  const projected = rawAgents.slice(0, MAX_SOURCE_RECORDS).map((agent) => {
    const tools = projectCalls(agent.toolCalls ?? []);
    const rawAttempts = agent.attemptDetails ?? [];
    if (rawAttempts.length > 32) { omittedSourceNodes += rawAttempts.length - 32; addReason(reasons, "Attempt history bounded"); }
    const rawPath = agent.structuralPath ?? [];
    if (rawPath.length > 16) { omittedSourceNodes += rawPath.length - 16; addReason(reasons, "Structural path bounded"); }
    const attempts = rawAttempts.slice(0, 32).map((attempt) => ({ attempt: attempt.attempt, failed: Boolean(attempt.error) }))
      .filter((attempt) => Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0)
      .sort((a, b) => a.attempt - b.attempt || Number(a.failed) - Number(b.failed));
    return {
      id: boundedId(agent.id, "agent id"), name: boundedText(agent.label ?? agent.name, "Agent"), state: boundedText(agent.state, "unknown", 40),
      ...(agent.parentId === undefined ? {} : { parentId: boundedId(agent.parentId, "parent id") }),
      path: rawPath.slice(0, 16).map((part) => boundedText(part, "task", 80)),
      attempts: Number.isSafeInteger(agent.attempts) && (agent.attempts ?? 0) > 0 ? agent.attempts as number : 0,
      attemptsSeen: attempts.filter((attempt, index) => index === 0 || attempts[index - 1]?.attempt !== attempt.attempt),
      output: agent.output ? boundedText(agent.output.status, "unknown", 40) : "missing",
      tools: tools.calls, toolsOmitted: tools.omitted
    };
  }).sort((a, b) => a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const agents: typeof projected = [];
  for (const candidate of projected) {
    if (agents.at(-1)?.id === candidate.id) { omittedSourceNodes += 1; addReason(reasons, "Duplicate source agent identity omitted"); }
    else agents.push(candidate);
    omittedSourceNodes += candidate.toolsOmitted;
    if (candidate.toolsOmitted) addReason(reasons, "Source tool-call list bounded");
  }
  if (rawAgents.length > projected.length) { omittedSourceNodes += rawAgents.length - projected.length; addReason(reasons, "Source agent list truncated"); }
  const rawStandalone = input.subagent;
  const standaloneTools = projectCalls(rawStandalone?.progress?.toolCalls ?? []);
  if (standaloneTools.omitted) { omittedSourceNodes += standaloneTools.omitted; addReason(reasons, "Source tool-call list bounded"); }
  const rawStandaloneAttempts = rawStandalone?.attemptDetails ?? [];
  if (rawStandaloneAttempts.length > 32) { omittedSourceNodes += rawStandaloneAttempts.length - 32; addReason(reasons, "Attempt history bounded"); }
  const standaloneAttempts = rawStandaloneAttempts.slice(0, 32).map((attempt) => ({ attempt: attempt.attempt, failed: Boolean(attempt.error) }))
    .filter((attempt) => Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0)
    .sort((a, b) => a.attempt - b.attempt || Number(a.failed) - Number(b.failed));
  let safeSnapshot = {
    scope,
    run: input.run ? { id: boundedId(input.run.id, "run id"), state: boundedText(input.run.state, "unknown", 40), agents } : undefined,
    subagent: rawStandalone ? {
      id: boundedId(rawStandalone.id, "subagent id"), label: boundedText(rawStandalone.label, "Subagent"), state: boundedText(rawStandalone.state, "unknown", 40),
      attempts: Number.isSafeInteger(rawStandalone.attempts) && (rawStandalone.attempts ?? 0) > 0 ? rawStandalone.attempts as number : 0,
      attemptsSeen: standaloneAttempts.filter((attempt, index) => index === 0 || standaloneAttempts[index - 1]?.attempt !== attempt.attempt),
      output: boundedText(rawStandalone.output?.status, "missing", 40), tools: standaloneTools.calls
    } : undefined
  };
  while (bytes(safeSnapshot) > SEMANTIC_MAP_LIMITS.payloadBytes && (agents.length || (safeSnapshot.subagent?.tools.length ?? 0) > 0)) {
    if (agents.length) { agents.pop(); omittedSourceNodes += 1; safeSnapshot = { ...safeSnapshot, run: safeSnapshot.run ? { ...safeSnapshot.run, agents } : undefined }; }
    else if (safeSnapshot.subagent) {
      const tools = safeSnapshot.subagent.tools.slice(0, -1);
      omittedSourceNodes += 1;
      safeSnapshot = { ...safeSnapshot, subagent: { ...safeSnapshot.subagent, tools } };
    }
    addReason(reasons, "Source metadata exceeds the bridge payload limit");
  }
  if (bytes(safeSnapshot) > SEMANTIC_MAP_LIMITS.payloadBytes) throw new Error("Semantic map scope exceeds the 512 KiB bridge payload limit");

  const nodes: SemanticNode[] = [];
  const edges: SemanticEdge[] = [];
  const nodeByKey = new Map<string, string>();
  const sourcePrefix = [scope.publisherId, scope.targetKind, scope.targetId, scope.agentId ?? ""] as const;
  const node = (kind: SemanticNodeKind, key: readonly (string | number)[], label: string, raw: string, evidence: SemanticNode["evidence"], sourceRef: string): string => {
    const id = tupleId([...sourcePrefix, kind, ...key]);
    const mapKey = JSON.stringify([kind, ...key]);
    if (!nodeByKey.has(mapKey)) {
      const status = stateOf(raw);
      nodes.push({ id, kind, label: boundedText(label, kind), ...status, evidence, sourceRef: boundedText(sourceRef, "unavailable", 256) });
      nodeByKey.set(mapKey, id);
    }
    return id;
  };
  const edge = (kind: SemanticRelationKind, from: string, to: string, relationKey: readonly (string | number)[], evidence: SemanticEdge["evidence"]): void => {
    if (from === to || edges.some((item) => item.from === from && item.to === to && item.kind === kind)) return;
    if (["dependency", "fork", "merge", "retry"].includes(kind) && hasPath(to, from, edges)) { addReason(reasons, "Cyclic causal relation omitted"); omittedSourceEdges += 1; return; }
    edges.push({ id: tupleId([...sourcePrefix, "edge", kind, ...relationKey, from, to]), from, to, kind, evidence });
  };
  const rootId = scope.targetKind === "run"
    ? node("workflow", [input.run?.id ?? scope.targetId], input.run?.workflowName ?? "Workflow", input.run?.state ?? "unknown", "recorded", input.run?.id ?? scope.targetId)
    : node("workflow", [input.subagent?.id ?? scope.targetId], "Standalone subagent", input.subagent?.state ?? "unknown", "structural", input.subagent?.id ?? scope.targetId);
  const agentBySource = new Map<string, { agent: typeof agents[number]; id: string }>();

  for (const agent of agents) {
    const id = node("agent", [agent.id], agent.name, agent.state, "recorded", agent.id);
    agentBySource.set(agent.id, { agent, id });
  }
  const parentWouldCycle = (childId: string, parentId: string): boolean => {
    const seen = new Set<string>([childId]);
    let current: string | undefined = parentId;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = agentBySource.get(current)?.agent.parentId;
    }
    return false;
  };
  for (const { agent, id } of agentBySource.values()) {
    let parent = rootId;
    let pathKey: string[] = [];
    for (const segment of agent.path) {
      pathKey = [...pathKey, segment];
      const taskId = node("task", pathKey, segment, "unknown", "structural", agent.id);
      edge("contains", parent, taskId, ["task", ...pathKey], "structural");
      parent = taskId;
    }
    if (agent.parentId) {
      const parentAgent = agentBySource.get(agent.parentId);
      if (!parentAgent) addReason(reasons, "Agent parent missing");
      else if (parentWouldCycle(agent.id, agent.parentId)) addReason(reasons, "Cyclic agent parent omitted");
      else edge("contains", parentAgent.id, id, ["parent", agent.parentId, agent.id], "recorded");
    } else edge("contains", parent, id, ["agent", agent.id], agent.path.length ? "structural" : "recorded");

    const attempts = [...new Set(agent.attemptsSeen.map((attempt) => attempt.attempt))].sort((a, b) => a - b);
    for (const attempt of attempts) {
      const record = agent.attemptsSeen.find((item) => item.attempt === attempt);
      const attemptId = node("agent", [agent.id, "attempt", attempt], `${agent.name} · attempt ${String(attempt)}`, record?.failed ? "failed" : "unknown", "recorded", agent.id);
      edge("contains", id, attemptId, ["attempt", agent.id, attempt], "structural");
    }
    if (attempts.length > 1) for (let index = 1; index < attempts.length; index += 1) {
      const previous = attempts[index - 1]; const current = attempts[index];
      if (previous !== undefined && current !== undefined && current > previous) {
        const before = nodeByKey.get(JSON.stringify(["agent", agent.id, "attempt", previous]));
        const after = nodeByKey.get(JSON.stringify(["agent", agent.id, "attempt", current]));
        if (before && after) edge("retry", before, after, [agent.id, previous, current], "recorded");
      }
    }
    if (agent.attempts > attempts.length && agent.attempts > 1) addReason(reasons, "Attempt history partial");
    const resultStatus = agent.output === "missing" ? "unavailable" : agent.output;
    const resultState = resultStatus === "failed" ? "failed" : resultStatus === "cancelled" ? "cancelled" : resultStatus === "pending" ? "running" : resultStatus === "available" && stateOf(agent.state).state === "success" ? "completed" : "unknown";
    const resultId = node("result", [agent.id, "output"], resultStatus === "missing" ? "Result unavailable" : `Result ${resultStatus}`, resultState, resultStatus === "missing" ? "unavailable" : "recorded", agent.id);
    edge("produces", id, resultId, [agent.id, "result"], "recorded");
    for (const call of agent.tools) {
      const callId = node("tool-call", [agent.id, agent.attempts || 1, call.id], call.name, call.state, "recorded", `${agent.id}/${call.id}`);
      edge("invokes", id, callId, [agent.id, call.id], "recorded");
    }
  }
  const standalone = safeSnapshot.subagent;
  if (standalone && scope.targetKind === "subagent") {
    const id = node("agent", [standalone.id], standalone.label, standalone.state, "recorded", standalone.id);
    edge("contains", rootId, id, ["subagent", standalone.id], "structural");
    const resultStatus = standalone.output;
    const resultState = resultStatus === "failed" ? "failed" : resultStatus === "cancelled" ? "cancelled" : resultStatus === "pending" ? "running" : resultStatus === "available" && stateOf(standalone.state).state === "success" ? "completed" : "unknown";
    const resultId = node("result", [standalone.id, "output"], resultStatus === "missing" ? "Result unavailable" : `Result ${resultStatus}`, resultState, resultStatus === "missing" ? "unavailable" : "recorded", standalone.id);
    edge("produces", id, resultId, [standalone.id, "result"], "recorded");
    const attempts = [...new Set(standalone.attemptsSeen.map((attempt) => attempt.attempt))].sort((a, b) => a - b);
    for (const attempt of attempts) {
      const record = standalone.attemptsSeen.find((item) => item.attempt === attempt);
      const attemptId = node("agent", [standalone.id, "attempt", attempt], `${standalone.label} · attempt ${String(attempt)}`, record?.failed ? "failed" : "unknown", "recorded", standalone.id);
      edge("contains", id, attemptId, ["attempt", standalone.id, attempt], "structural");
    }
    for (let index = 1; index < attempts.length; index += 1) {
      const previous = attempts[index - 1]; const current = attempts[index];
      if (previous !== undefined && current !== undefined && current > previous) {
        const before = nodeByKey.get(JSON.stringify(["agent", standalone.id, "attempt", previous]));
        const after = nodeByKey.get(JSON.stringify(["agent", standalone.id, "attempt", current]));
        if (before && after) edge("retry", before, after, [standalone.id, previous, current], "recorded");
      }
    }
    if (standalone.attempts > attempts.length && standalone.attempts > 1) addReason(reasons, "Attempt history partial");
    for (const call of standalone.tools) {
      const callId = node("tool-call", [standalone.id, standalone.attempts, call.id], call.name, call.state, "recorded", `${standalone.id}/${call.id}`);
      edge("invokes", id, callId, [standalone.id, call.id], "recorded");
    }
  }
  const runId = input.run?.id ?? scope.targetId;
  const sourceRunId = input.run?.retry?.sourceRunId;
  if (sourceRunId) {
    const previousId = node("workflow", [boundedId(sourceRunId, "retry source id")], "Previous run", "unknown", "recorded", sourceRunId);
    edge("retry", previousId, rootId, [sourceRunId, runId], "recorded");
  }
  const relationInput = input.relations ?? [];
  const relationRecords = relationInput.slice(0, MAX_SOURCE_RECORDS).flatMap((relation) => {
    if (!["dependency", "fork", "merge"].includes(relation.kind)) { omittedSourceEdges += 1; return []; }
    return [{ kind: relation.kind, fromAgentId: boundedId(relation.fromAgentId, "relation source id"), toAgentId: boundedId(relation.toAgentId, "relation target id"), id: relation.id === undefined ? undefined : boundedId(relation.id, "relation id") }];
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.fromAgentId.localeCompare(b.fromAgentId) || a.toAgentId.localeCompare(b.toAgentId) || (a.id ?? "").localeCompare(b.id ?? ""));
  if (relationInput.length > MAX_SOURCE_RECORDS) { omittedSourceEdges += relationInput.length - MAX_SOURCE_RECORDS; addReason(reasons, "Recorded relations bounded"); }
  if (relationRecords.length < Math.min(relationInput.length, MAX_SOURCE_RECORDS)) addReason(reasons, "Recorded relations invalid");
  for (const relation of relationRecords) {
    const from = agentBySource.get(relation.fromAgentId)?.id;
    const to = agentBySource.get(relation.toAgentId)?.id;
    if (!from || !to) { addReason(reasons, "Recorded relation endpoint missing"); omittedSourceEdges += 1; continue; }
    edge(relation.kind, from, to, [relation.id ?? relation.fromAgentId, relation.toAgentId], "recorded");
  }
  const publisherOmittedNodes = positiveCount(input.partial?.omittedNodes);
  const publisherOmittedEdges = positiveCount(input.partial?.omittedEdges);
  if (publisherOmittedNodes) { omittedSourceNodes += publisherOmittedNodes; addReason(reasons, "Publisher omitted nodes"); }
  if (publisherOmittedEdges) { omittedSourceEdges += publisherOmittedEdges; addReason(reasons, "Publisher omitted edges"); }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  const omittedNodes = Math.max(0, nodes.length - SEMANTIC_MAP_LIMITS.nodes);
  const omittedEdges = Math.max(0, edges.length - SEMANTIC_MAP_LIMITS.edges);
  const rootNode = nodes.find((item) => item.id === rootId);
  const visibleNodes = [rootNode, ...nodes.filter((item) => item.id !== rootId).slice(0, SEMANTIC_MAP_LIMITS.nodes - 1)].filter((item): item is SemanticNode => item !== undefined);
  const visibleIds = new Set(visibleNodes.map((item) => item.id));
  const visibleEdges = edges.filter((item) => visibleIds.has(item.from) && visibleIds.has(item.to)).slice(0, SEMANTIC_MAP_LIMITS.edges);
  const edgeOmission = Math.max(omittedEdges, edges.length - visibleEdges.length);
  if (omittedNodes || edgeOmission || omittedSourceNodes || omittedSourceEdges) addReason(reasons, "Graph data omitted by bounds or validation");
  const graph: SemanticGraph = {
    schemaVersion: 1, scope, nodes: visibleNodes, edges: visibleEdges,
    completeness: { partial: reasons.size > 0, reasons: [...reasons].sort(), omittedNodes: omittedNodes + omittedSourceNodes, omittedEdges: edgeOmission + omittedSourceEdges }
  };
  if (bytes(graph) > SEMANTIC_MAP_LIMITS.payloadBytes) {
    const initialEdges = graph.edges.length;
    addReason(reasons, "Rendered graph exceeds bridge payload limit");
    graph.completeness.partial = true;
    graph.completeness.reasons = [...reasons].sort();
    while (graph.nodes.length && bytes(graph) > SEMANTIC_MAP_LIMITS.payloadBytes) {
      const removed = graph.nodes.pop();
      graph.edges = graph.edges.filter((item) => item.from !== removed?.id && item.to !== removed?.id);
      graph.completeness.omittedNodes += 1;
      graph.completeness.partial = true;
    }
    graph.completeness.omittedEdges += initialEdges - graph.edges.length;
  }
  return graph;
}
