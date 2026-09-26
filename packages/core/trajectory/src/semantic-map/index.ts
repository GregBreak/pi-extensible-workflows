import type { SemanticAgent, SemanticSnapshot } from "./adapter.js";
import { SemanticMapBridge, type ParentSemanticNode } from "./bridge.js";

const MAX_CACHED_CALLS = 32;
const MAX_SOURCE_AGENTS = 16;
const MAX_SOURCE_RELATIONS = 8;
const MAX_STRUCTURAL_PATH = 8;
const MAX_RUN_TOOL_CALLS = 16;
const MAX_SNAPSHOT_BYTES = 384 * 1024;
const encoder = new TextEncoder();
type SemanticProjection = { snapshot: SemanticSnapshot; identity: string; nodes: ReadonlyMap<string, ParentSemanticNode>; nodeCount: number };
type TargetKind = "run" | "subagent";
type Target = { kind: TargetKind; publisherId: string; id: string };
type FoundTarget = { publisher: Record<string, unknown>; record: Record<string, unknown>; target: Target };
type AppState = { transcripts: Record<string, unknown> };
type AppContext = {
  state: AppState;
  selected: () => FoundTarget | undefined;
  setView: (view: string) => void;
  staticExport: boolean;
};
type UiWindow = Window & { __PIEWF_SEMANTIC_MAP_CONTEXT__?: AppContext; __PIEWF_SEMANTIC_MAP_REFRESH__?: () => void; __PIEWF_SEMANTIC_MAP_VISIBILITY__?: (visible: boolean) => void; __PIEWF_SEMANTIC_MAP_THEME__?: () => void };

function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function safeText(value: unknown, max = 128): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined; }
function safeArray(value: unknown, max: number): unknown[] { return Array.isArray(value) ? value.slice(0, max) : []; }
function safeOutput(value: unknown): { status: string } | undefined {
  const status = asRecord(value)?.status;
  return typeof status === "string" && status.length <= 40 ? { status } : undefined;
}
function tupleNodeId(scope: SemanticSnapshot["scope"], kind: ParentSemanticNode["kind"], key: readonly (string | number)[]): string {
  const parts = [scope.publisherId, scope.targetKind, scope.targetId, scope.agentId ?? "", kind, ...key];
  return `sm-${Array.from(encoder.encode(JSON.stringify(parts)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function normalizedPath(value: string): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, 80).join("") : "task";
}
function boundedSnapshot(input: SemanticSnapshot): SemanticSnapshot {
  let snapshot = input;
  const reasons = new Set(input.partial?.reasons ?? []);
  let omittedNodes = 0;
  let omittedEdges = 0;
  const updateReasons = (): void => {
    snapshot = { ...snapshot, partial: {
      ...snapshot.partial, reasons: [...reasons],
      omittedNodes: (input.partial?.omittedNodes ?? 0) + omittedNodes,
      omittedEdges: (input.partial?.omittedEdges ?? 0) + omittedEdges
    } };
  };
  while (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) {
    const run = snapshot.run;
    if (snapshot.relations?.length) {
      reasons.add("Recorded relations bounded to the bridge payload limit");
      omittedEdges += 1;
      snapshot = { ...snapshot, relations: snapshot.relations.slice(0, -1) };
    } else if (run?.agents?.length) {
      reasons.add("Source agents bounded to the bridge payload limit");
      omittedNodes += 1;
      snapshot = { ...snapshot, run: { ...run, agents: run.agents.slice(0, -1) } };
    } else if (snapshot.subagent?.progress?.toolCalls?.length) {
      reasons.add("Subagent tool calls bounded to the bridge payload limit");
      omittedNodes += 1;
      snapshot = { ...snapshot, subagent: { ...snapshot.subagent, progress: { toolCalls: snapshot.subagent.progress.toolCalls.slice(0, -1) } } };
    } else throw new Error("Semantic Map scope exceeds the 512 KiB bridge payload limit");
    updateReasons();
  }
  return snapshot;
}
function indexSemanticNodes(snapshot: SemanticSnapshot): { nodes: ReadonlyMap<string, ParentSemanticNode>; nodeCount: number } {
  const scope = snapshot.scope;
  const candidates = new Map<string, ParentSemanticNode>();
  const keys = new Set<string>();
  const add = (kind: ParentSemanticNode["kind"], key: readonly (string | number)[], sourceRef: string): string => {
    const id = tupleNodeId(scope, kind, key);
    const identity = JSON.stringify([kind, ...key]);
    if (!keys.has(identity)) {
      keys.add(identity);
      const cleanSourceRef = sourceRef.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
      candidates.set(id, { id, kind, sourceRef: Array.from(cleanSourceRef || "unavailable").slice(0, 256).join("") });
    }
    return id;
  };
  const rootId = add("workflow", [scope.targetId], scope.targetId);
  if (snapshot.run) {
    const sortedAgents = [...(snapshot.run.agents ?? [])].sort((left, right) => left.id.localeCompare(right.id) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const seenAgents = new Set<string>();
    for (const agent of sortedAgents) {
      if (seenAgents.has(agent.id)) continue;
      seenAgents.add(agent.id);
      add("agent", [agent.id], agent.id);
      let path: string[] = [];
      for (const part of agent.structuralPath ?? []) { path = [...path, normalizedPath(part)]; add("task", path, agent.id); }
      for (const attempt of agent.attemptDetails ?? []) add("agent", [agent.id, "attempt", attempt.attempt], agent.id);
      add("result", [agent.id, "output"], agent.id);
      for (const call of agent.toolCalls ?? []) add("tool-call", [agent.id, agent.attempts || 1, call.id], `${agent.id}/${call.id}`);
    }
    if (snapshot.run.retry?.sourceRunId) add("workflow", [snapshot.run.retry.sourceRunId], snapshot.run.retry.sourceRunId);
  } else if (snapshot.subagent) {
    const agent = snapshot.subagent;
    add("agent", [agent.id], agent.id);
    add("result", [agent.id, "output"], agent.id);
    for (const attempt of agent.attemptDetails ?? []) add("agent", [agent.id, "attempt", attempt.attempt], agent.id);
    for (const call of agent.progress?.toolCalls ?? []) add("tool-call", [agent.id, agent.attempts ?? 0, call.id], `${agent.id}/${call.id}`);
  }
  const visibleIds = [rootId, ...[...candidates.keys()].filter((id) => id !== rootId).sort().slice(0, 499)];
  return { nodes: new Map(visibleIds.flatMap((id) => candidates.has(id) ? [[id, candidates.get(id) as ParentSemanticNode] as const] : [])), nodeCount: visibleIds.length };
}

function cachedToolCalls(context: AppContext, found: FoundTarget, agentId: string, attempt: number): { calls: { id: string; name: string; state: string }[]; omitted: number } {
  const isSubagent = found.target.kind === "subagent";
  const key = isSubagent ? `${String(found.publisher.id)}\tsubagent\t${String(found.record.id)}` : `${String(found.publisher.id)}\t${String(asRecord(found.record.run)?.id)}\t${agentId}`;
  const entries = context.state.transcripts[key];
  if (!Array.isArray(entries)) return { calls: [], omitted: 0 };
  const calls = new Map<string, { id: string; name: string; state: string }>();
  const results = new Map<string, boolean>();
  for (const rawEntry of entries.slice(-4096)) {
    const entry = asRecord(rawEntry);
    const message = asRecord(entry?.message) ?? entry;
    if (!entry || !message) continue;
    const callId = safeText(message.toolCallId, 128);
    if (callId && (entry.type === "tool_result" || message.role === "toolResult")) results.set(callId, message.isError === true || entry.isError === true);
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part || part.type !== "toolCall") continue;
      const id = safeText(part.id, 128);
      const name = safeText(part.name, 120);
      if (id && name && !calls.has(id)) calls.set(id, { id, name, state: "running" });
    }
  }
  for (const [id, call] of calls) {
    if (results.has(id)) calls.set(id, { ...call, state: results.get(id) ? "failed" : "completed" });
  }
  const ordered = [...calls.values()];
  return { calls: ordered.slice(-MAX_CACHED_CALLS).map((call) => ({ ...call, state: call.state || `attempt-${String(attempt)}` })), omitted: Math.max(0, ordered.length - MAX_CACHED_CALLS) };
}

/** Whitelist current accepted metadata; never copies prompts, scripts, environment, args, or result values. */
export function projectCurrentSemanticSnapshot(context: AppContext): SemanticProjection | undefined {
  const found = context.selected();
  if (!found || found.publisher.connected !== true) return undefined;
  const publisherId = safeText(found.publisher.id, 128);
  const targetId = safeText(found.target.id, 128);
  if (!publisherId || !targetId) return undefined;
  const rawGeneration = found.publisher.generation;
  const generation = typeof rawGeneration === "string" && rawGeneration.length <= 128 || typeof rawGeneration === "number" && Number.isSafeInteger(rawGeneration) ? rawGeneration : null;
  const identity = JSON.stringify([publisherId, generation, found.target.kind, targetId]);
  if (found.target.kind === "run") {
    const run = asRecord(found.record.run);
    if (!run || safeText(run.id, 128) !== targetId) return undefined;
    const allAgents = Array.isArray(run.agents) ? run.agents : [];
    const rawAgents = allAgents.slice(0, MAX_SOURCE_AGENTS);
    let callsRemaining = MAX_RUN_TOOL_CALLS;
    let omittedToolCalls = 0;
    let omittedStructure = 0;
    let invalidAgents = 0;
    const omittedReasons = new Set<string>();
    const agents = rawAgents.flatMap((raw): SemanticAgent[] => {
      const agent = asRecord(raw);
      const id = safeText(agent?.id, 128);
      if (!agent || !id) { invalidAgents += 1; return []; }
      const sourceAttempts = Array.isArray(agent.attemptDetails) ? agent.attemptDetails : [];
      const attemptDetails = safeArray(sourceAttempts, 8).flatMap((rawAttempt) => {
        const detail = asRecord(rawAttempt);
        const attempt = detail?.attempt;
        if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) return [];
        const error = asRecord(detail?.error);
        const code = safeText(error?.code, 40);
        return [{ attempt: attempt as number, ...(error ? { error: { ...(code ? { code } : {}) } } : {}) }];
      });
      const attempt = typeof agent.attempts === "number" && Number.isSafeInteger(agent.attempts) ? agent.attempts : attemptDetails.length;
      const allPath = Array.isArray(agent.structuralPath) ? agent.structuralPath : [];
      const structuralPath = allPath.slice(0, MAX_STRUCTURAL_PATH).flatMap((part) => typeof part === "string" && part.length <= 80 ? [part] : []);
      omittedStructure += Math.max(0, allPath.length - structuralPath.length) + Math.max(0, sourceAttempts.length - attemptDetails.length);
      if (allPath.length > structuralPath.length || sourceAttempts.length > 8) omittedReasons.add("Attempt and structural-path history bounded");
      const name = safeText(agent.name, 120);
      const label = safeText(agent.label, 120);
      const output = safeOutput(agent.output);
      const parentId = safeText(agent.parentId, 128);
      const cached = cachedToolCalls(context, found, id, attempt);
      const toolCalls = callsRemaining > 0 ? cached.calls.slice(0, callsRemaining) : [];
      callsRemaining -= toolCalls.length;
      omittedToolCalls += cached.omitted + cached.calls.length - toolCalls.length;
      if (omittedToolCalls > 0) omittedReasons.add("Cached tool-call projection bounded");
      return [{
        id, ...(name ? { name } : {}), ...(label ? { label } : {}), state: safeText(agent.state, 40) ?? "unknown",
        ...(parentId ? { parentId } : {}), structuralPath,
        attempts: attempt, attemptDetails, toolCalls, ...(output ? { output } : {})
      }];
    });
    const allRelations = Array.isArray(run.relations) ? run.relations : [];
    const rawRelations = allRelations.slice(0, MAX_SOURCE_RELATIONS);
    const relations = rawRelations.flatMap((raw) => {
      const relation = asRecord(raw);
      const kind = relation?.kind;
      const fromAgentId = safeText(relation?.fromAgentId, 128);
      const toAgentId = safeText(relation?.toAgentId, 128);
      const id = safeText(relation?.id, 128);
      if (!relation || !["dependency", "fork", "merge"].includes(String(kind)) || !fromAgentId || !toAgentId) return [];
      return [{ kind: kind as "dependency" | "fork" | "merge", fromAgentId, toAgentId, ...(id ? { id } : {}), evidence: "recorded" as const }];
    });
    const retry = asRecord(run.retry);
    const sourceRunId = safeText(retry?.sourceRunId, 128);
    const workflowName = safeText(run.workflowName, 120);
    const snapshot = boundedSnapshot({
      scope: { publisherId, targetKind: "run", targetId },
      run: {
        id: targetId, ...(workflowName ? { workflowName } : {}), state: safeText(run.state, 40) ?? "unknown",
        ...(sourceRunId ? { retry: { sourceRunId } } : {}), agents
      },
      ...(relations.length ? { relations } : {}),
      partial: {
        reasons: ["Live projection excludes prompts, scripts, environment, tool arguments, and result values", ...(allAgents.length > MAX_SOURCE_AGENTS ? ["Source agent list bounded"] : []), ...(allRelations.length > MAX_SOURCE_RELATIONS ? ["Recorded relation list bounded"] : []), ...omittedReasons],
        omittedNodes: Math.max(0, allAgents.length - rawAgents.length) + invalidAgents + omittedStructure + omittedToolCalls,
        omittedEdges: Math.max(0, allRelations.length - relations.length)
      }
    });
    return { identity, snapshot, ...indexSemanticNodes(snapshot) };
  }
  const output = safeOutput(found.record.output);
  const attempts = typeof found.record.attempts === "number" && Number.isSafeInteger(found.record.attempts) ? found.record.attempts : 0;
  const details = safeArray(found.record.attemptDetails, 8).flatMap((rawAttempt) => {
    const detail = asRecord(rawAttempt);
    if (!Number.isSafeInteger(detail?.attempt) || (detail?.attempt as number) < 1) return [];
    const error = asRecord(detail?.error);
    const code = safeText(error?.code, 40);
    return [{ attempt: detail?.attempt as number, ...(error ? { error: { ...(code ? { code } : {}) } } : {}) }];
  });
  const progress = asRecord(found.record.progress);
  const label = safeText(found.record.label, 120);
  const toolCalls = safeArray(progress?.toolCalls, MAX_CACHED_CALLS).flatMap((rawCall) => {
    const call = asRecord(rawCall);
    const id = safeText(call?.id, 128);
    const name = safeText(call?.name, 120);
    return call && id && name ? [{ id, name, state: safeText(call.state, 40) ?? "unknown" }] : [];
  });
  const allToolCalls = asRecord(found.record.progress)?.toolCalls;
  const allAttempts = found.record.attemptDetails;
  const omittedAttempts = Math.max(0, (Array.isArray(allAttempts) ? allAttempts.length : 0) - details.length);
  const omittedCalls = Math.max(0, (Array.isArray(allToolCalls) ? allToolCalls.length : 0) - toolCalls.length);
  const snapshot = boundedSnapshot({
    scope: { publisherId, targetKind: "subagent", targetId },
    subagent: {
      id: targetId, ...(label ? { label } : {}), state: safeText(found.record.state, 40) ?? "unknown",
      attempts, attemptDetails: details, ...(output ? { output } : {}), progress: { toolCalls }
    },
    partial: {
      reasons: ["Live projection excludes prompts, scripts, environment, tool arguments, and result values", ...(omittedCalls ? ["Subagent tool-call list bounded"] : []), ...(omittedAttempts ? ["Subagent attempt history bounded"] : [])],
      omittedNodes: omittedCalls + omittedAttempts
    }
  });
  return { identity, snapshot, ...indexSemanticNodes(snapshot) };
}

/** Owns accessible tabs and explicit activation; static exports never create a browsing context. */
export function installSemanticMapUI(context: AppContext): void {
  const view = document.getElementById("view-run");
  const host = document.getElementById("semantic-map-host");
  const status = document.getElementById("semantic-map-status");
  const tabs = document.getElementById("projection-tabs");
  const timelinePanel = document.getElementById("timeline-panel");
  const mapPanel = document.getElementById("semantic-map-panel");
  const timelineTab = document.getElementById("timeline-tab");
  const mapTab = document.getElementById("semantic-map-tab");
  if (!view || !host || !status || !tabs || !timelinePanel || !mapPanel || !timelineTab || !mapTab) return;
  let selectedTab: "timeline" | "map" = "timeline";
  const theme = (): "light" | "dark" => document.documentElement.dataset.theme === "light" || document.documentElement.dataset.theme === "dark"
    ? document.documentElement.dataset.theme
    : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const mapUrl = new URL("./semantic-map.html?embed=1", location.href);
  mapUrl.searchParams.set("theme", theme());
  const bridge = new SemanticMapBridge({
    host,
    url: mapUrl.href,
    theme,
    onStatus(message) { status.textContent = message; },
    onRequest(node, detail) { handleNodeRequest(context, node, detail); }
  });
  const update = (): void => {
    if (selectedTab !== "map" || context.staticExport || document.body.dataset.view !== "run" || document.hidden) return;
    const projection = projectCurrentSemanticSnapshot(context);
    if (!projection) {
      bridge.close();
      status.textContent = "No selected workflow or subagent. Select a target, then reopen the map.";
      return;
    }
    if (!host.querySelector("iframe")) bridge.open();
    bridge.update(projection.snapshot, projection.identity, projection.nodes, projection.nodeCount);
  };
  const activate = (tab: "timeline" | "map"): void => {
    selectedTab = tab;
    const isMap = tab === "map";
    timelineTab.setAttribute("aria-selected", String(!isMap)); mapTab.setAttribute("aria-selected", String(isMap));
    timelineTab.tabIndex = isMap ? -1 : 0; mapTab.tabIndex = isMap ? 0 : -1;
    timelinePanel.hidden = isMap; mapPanel.hidden = !isMap;
    if (!isMap) bridge.close();
    else if (context.staticExport) status.textContent = "Semantic Map is available for live Trajectory sessions only; this is a static export.";
    else if (!context.selected()) status.textContent = "No selected workflow or subagent. Select a target, then reopen the map.";
    else { if (!host.querySelector("iframe")) bridge.open(); update(); }
  };
  tabs.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLElement>("[data-semantic-tab]")?.dataset.semanticTab;
    if (tab === "timeline" || tab === "map") activate(tab);
  });
  tabs.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" || event.key === "ArrowLeft" ? "timeline" : "map";
    activate(next); (next === "timeline" ? timelineTab : mapTab).focus();
  });
  const close = document.getElementById("semantic-map-close");
  close?.addEventListener("click", () => { activate("timeline"); timelineTab.focus(); });
  const appWindow = window as UiWindow;
  appWindow.__PIEWF_SEMANTIC_MAP_REFRESH__ = update;
  appWindow.__PIEWF_SEMANTIC_MAP_VISIBILITY__ = (visible) => { bridge.setVisible(visible); };
  appWindow.__PIEWF_SEMANTIC_MAP_THEME__ = () => { bridge.setTheme(theme()); };
  void view;
}

function handleNodeRequest(context: AppContext, node: ParentSemanticNode, detail: boolean): void {
  const found = context.selected();
  if (!found || found.publisher.connected !== true) return;
  const projection = projectCurrentSemanticSnapshot(context);
  if (!projection) return;
  const current = projection.nodes.get(node.id);
  if (!current || current.kind !== node.kind || current.sourceRef !== node.sourceRef) return;
  if (current.kind === "workflow") return;
  if (found.target.kind === "subagent") {
    if (current.sourceRef !== found.target.id) return;
    if (detail) context.setView("subagent");
    return;
  }
  const run = asRecord(found.record.run);
  const state = context.state as AppState & { currentAgent?: string; selectedEvent?: number; inspMode?: string };
  const agents = safeArray(run?.agents, MAX_SOURCE_AGENTS).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  let agentId: string | undefined;
  if (current.kind === "agent" || current.kind === "tool-call" || current.kind === "result") {
    if (current.kind === "tool-call") {
      const matching = agents.filter((agent) => typeof agent.id === "string" && current.sourceRef.startsWith(`${agent.id}/`)).sort((a, b) => String(b.id).length - String(a.id).length)[0];
      agentId = safeText(matching?.id, 128);
    } else agentId = safeText(current.sourceRef, 128);
  }
  if (!agentId || !agents.some((agent) => agent.id === agentId)) return;
  state.currentAgent = agentId;
  if (detail && current.kind === "tool-call") {
    const transcriptKey = `${String(found.publisher.id)}\t${String(run?.id)}\t${agentId}`;
    const entries = context.state.transcripts[transcriptKey];
    if (Array.isArray(entries)) {
      const callId = current.sourceRef.slice(agentId.length + 1);
      const eventIndex = entries.findIndex((raw) => {
        const entry = asRecord(raw);
        const message = asRecord(entry?.message);
        return Array.isArray(message?.content) && message.content.some((part) => asRecord(part)?.type === "toolCall" && asRecord(part)?.id === callId);
      });
      if (eventIndex >= 0) { state.selectedEvent = eventIndex; state.inspMode = "event"; }
    }
  }
  if (detail) context.setView("agent");
}

if (typeof window !== "undefined") {
  const uiWindow = window as UiWindow;
  if (uiWindow.__PIEWF_SEMANTIC_MAP_CONTEXT__) installSemanticMapUI(uiWindow.__PIEWF_SEMANTIC_MAP_CONTEXT__);
}
