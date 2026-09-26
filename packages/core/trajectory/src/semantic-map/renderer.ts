import type { SemanticEdge, SemanticGraph, SemanticNode, SemanticRelationKind, SemanticState } from "./adapter.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_LIMIT = 500;
const EDGE_LIMIT = 1500;
const VIEW_WIDTH = 1000;
const COLUMNS = 8;
const CARD_WIDTH = 105;
const CARD_HEIGHT = 48;
const COLUMN_STEP = 121;
const ROW_STEP = 70;
const nodeKinds = new Set(["workflow", "task", "agent", "tool-call", "result"]);
const edgeKinds = new Set<SemanticRelationKind>(["contains", "invokes", "produces", "dependency", "fork", "merge", "retry"]);
const states = new Set<SemanticState>(["running", "success", "failure", "queued", "waiting", "paused", "retrying", "cancelled", "interrupted", "unknown"]);
const safeId = /^sm-(?:[0-9a-f]{2})+$/;

export type ArchifyApi = {
  finder?: { refresh?: () => number };
  focus?: { active: () => string | string[] | null; set: (id: string, options?: Record<string, unknown>) => boolean; setMany: (ids: string[], options?: Record<string, unknown>) => boolean; clear: (options?: Record<string, unknown>) => void };
  routeProbe?: { active: () => unknown; clear: (options?: Record<string, unknown>) => void };
};
type RenderResult = { structural: boolean; nodeCount: number; edgeCount: number };
type Slot = { x: number; y: number; slot: number };
type NodeElements = { group: SVGGElement; shape: SVGRectElement; label: SVGTextElement; status: SVGTextElement };

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] { return document.createElementNS(SVG_NS, tag); }
function validNode(value: unknown): value is SemanticNode {
  if (!value || typeof value !== "object") return false;
  const node = value as SemanticNode;
  return safeId.test(node.id) && node.id.length <= 4096 && nodeKinds.has(node.kind) && states.has(node.state) && typeof node.label === "string" && node.label.length <= 120 && typeof node.rawStatus === "string" && node.rawStatus.length <= 40;
}
function validEdge(value: unknown, ids: ReadonlySet<string>): value is SemanticEdge {
  if (!value || typeof value !== "object") return false;
  const edge = value as SemanticEdge;
  return safeId.test(edge.id) && edge.id.length <= 4096 && edgeKinds.has(edge.kind) && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to;
}
function validGraph(value: unknown): value is SemanticGraph {
  if (!value || typeof value !== "object") return false;
  const graph = value as SemanticGraph;
  const version: unknown = (value as { schemaVersion?: unknown }).schemaVersion;
  return version === 1 && Array.isArray(graph.nodes) && graph.nodes.length <= NODE_LIMIT && Array.isArray(graph.edges) && graph.edges.length <= EDGE_LIMIT;
}
function layout(slot: number): Slot {
  return { x: 18 + (slot % COLUMNS) * COLUMN_STEP, y: 28 + Math.floor(slot / COLUMNS) * ROW_STEP, slot };
}
function text(element: SVGTextElement, value: string): void { const bounded = Array.from(value).slice(0, 120).join(""); if (element.textContent !== bounded) element.textContent = bounded; }
function setAttribute(element: Element, name: string, value: string): void { if (element.getAttribute(name) !== value) element.setAttribute(name, value); }
function edgePath(from: Slot, to: Slot): string {
  const sx = from.x + CARD_WIDTH;
  const sy = from.y + CARD_HEIGHT / 2;
  const tx = to.x;
  const ty = to.y + CARD_HEIGHT / 2;
  if (to.slot > from.slot) {
    const mid = Math.round((sx + tx) / 2);
    return `M ${String(sx)} ${String(sy)} H ${String(mid)} V ${String(ty)} H ${String(tx)}`;
  }
  const midY = Math.max(8, Math.min(from.y, to.y) - 8);
  return `M ${String(from.x + CARD_WIDTH / 2)} ${String(from.y)} V ${String(midY)} H ${String(to.x + CARD_WIDTH / 2)} V ${String(to.y)}`;
}

/** Incremental SVG renderer for the pinned Archify shell. All non-static SVG strings are text, never markup or URLs. */
export class SemanticMapRenderer {
  private readonly svg: SVGSVGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly nodeElements = new Map<string, NodeElements>();
  private readonly edgeElements = new Map<string, SVGGElement>();
  private readonly slots = new Map<string, Slot>();
  private readonly onClick: (event: MouseEvent) => void;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private scopeKey = "";
  private disposed = false;

  constructor(private readonly archify: ArchifyApi = window.Archify as ArchifyApi) {
    const found = document.querySelector(".diagram-container > svg");
    if (!(found instanceof SVGSVGElement)) throw new Error("Archify SVG canvas is unavailable");
    this.svg = found;
    const defs = this.svg.querySelector("defs");
    const grid = this.svg.querySelector('rect[fill="url(#grid)"]');
    this.svg.replaceChildren(...[defs, grid].filter((element): element is SVGElement => element instanceof SVGElement));
    this.edgeLayer = svgElement("g");
    this.edgeLayer.setAttribute("class", "semantic-map-edges");
    this.nodeLayer = svgElement("g");
    this.nodeLayer.setAttribute("class", "semantic-map-nodes");
    this.svg.append(this.edgeLayer, this.nodeLayer);
    this.onClick = (event) => { this.selectFromEvent(event); };
    this.onKeyDown = (event) => { if (event.key === "Enter" || event.key === " ") this.selectFromEvent(event); };
    this.svg.addEventListener("click", this.onClick);
    this.svg.addEventListener("keydown", this.onKeyDown);
  }

  render(graph: SemanticGraph): RenderResult {
    if (this.disposed) throw new Error("Semantic map renderer is disposed");
    if (!validGraph(graph)) throw new Error("Invalid bounded semantic graph");
    const ids = new Set<string>();
    for (const item of graph.nodes) {
      if (!validNode(item) || ids.has(item.id)) throw new Error("Invalid or duplicate semantic node");
      ids.add(item.id);
    }
    const edges = graph.edges.filter((item) => validEdge(item, ids));
    if (edges.length !== graph.edges.length) throw new Error("Invalid semantic relation endpoint or identifier");
    const nextScope = JSON.stringify(graph.scope);
    if (this.scopeKey && nextScope !== this.scopeKey) this.clearGraph();
    this.scopeKey = nextScope;
    const nextNodes = new Map(graph.nodes.map((item) => [item.id, item]));
    const nextEdges = new Map(edges.map((item) => [item.id, item]));
    const structural = [...this.nodeElements.keys()].some((id) => !nextNodes.has(id)) || [...nextNodes.keys()].some((id) => !this.nodeElements.has(id)) || [...this.edgeElements.keys()].some((id) => !nextEdges.has(id)) || [...nextEdges.keys()].some((id) => !this.edgeElements.has(id));
    const active = this.archify.focus?.active() ?? null;
    const activeIds = Array.isArray(active) ? active : active ? [active] : [];
    const removed = activeIds.some((id) => !nextNodes.has(id));

    for (const [id, entry] of this.nodeElements) if (!nextNodes.has(id)) { entry.group.remove(); this.nodeElements.delete(id); this.slots.delete(id); }
    for (const [id, entry] of this.edgeElements) if (!nextEdges.has(id)) { entry.remove(); this.edgeElements.delete(id); }
    const occupied = new Set([...this.slots.values()].map((slot) => slot.slot));
    const missing = [...nextNodes.keys()].filter((id) => !this.slots.has(id)).sort();
    for (const id of missing) {
      let slot = 0;
      while (occupied.has(slot)) slot += 1;
      occupied.add(slot);
      this.slots.set(id, layout(slot));
    }
    const maxSlot = Math.max(0, ...[...this.slots.values()].map((slot) => slot.slot));
    const height = Math.max(680, Math.ceil((maxSlot + 1) / COLUMNS) * ROW_STEP + 24);
    if (structural && this.svg.getAttribute("viewBox") !== `0 0 ${String(VIEW_WIDTH)} ${String(height)}`) this.svg.setAttribute("viewBox", `0 0 ${String(VIEW_WIDTH)} ${String(height)}`);

    for (const item of graph.nodes) {
      let entry = this.nodeElements.get(item.id);
      if (!entry) {
        const group = svgElement("g"); group.setAttribute("class", "semantic-map-node"); group.setAttribute("tabindex", "0"); group.setAttribute("role", "button");
        const shape = svgElement("rect"); shape.setAttribute("class", "semantic-map-node-shape"); shape.setAttribute("width", String(CARD_WIDTH)); shape.setAttribute("height", String(CARD_HEIGHT)); shape.setAttribute("rx", "6");
        const label = svgElement("text"); label.setAttribute("class", "semantic-map-node-label"); label.setAttribute("x", "7"); label.setAttribute("y", "19");
        const status = svgElement("text"); status.setAttribute("class", "semantic-map-node-status"); status.setAttribute("x", "7"); status.setAttribute("y", "37");
        group.append(shape, label, status); this.nodeLayer.append(group); entry = { group, shape, label, status }; this.nodeElements.set(item.id, entry);
      }
      const at = this.slots.get(item.id);
      if (!at) throw new Error("Semantic node has no stable layout slot");
      setAttribute(entry.group, "data-node-id", item.id);
      setAttribute(entry.group, "data-node-kind", item.kind);
      setAttribute(entry.group, "data-node-label", item.label);
      setAttribute(entry.group, "data-node-status", item.state);
      setAttribute(entry.group, "data-node-sublabel", item.rawStatus);
      setAttribute(entry.group, "data-profile-x", String(at.x));
      setAttribute(entry.group, "data-profile-y", String(at.y));
      setAttribute(entry.group, "aria-label", `${item.label}, ${item.rawStatus}`);
      setAttribute(entry.group, "aria-pressed", activeIds.includes(item.id) ? "true" : "false");
      setAttribute(entry.group, "transform", `translate(${String(at.x)} ${String(at.y)})`);
      setAttribute(entry.shape, "class", `semantic-map-node-shape state-${item.state}`);
      text(entry.label, item.label);
      text(entry.status, item.rawStatus);
    }
    for (const item of edges) {
      let group = this.edgeElements.get(item.id);
      if (!group) {
        group = svgElement("g"); group.setAttribute("class", "semantic-map-edge");
        const path = svgElement("path"); path.setAttribute("class", "semantic-map-edge-path"); path.setAttribute("marker-end", "url(#arrowhead)"); group.append(path);
        this.edgeLayer.append(group); this.edgeElements.set(item.id, group);
      }
      const from = this.slots.get(item.from); const to = this.slots.get(item.to); const path = group.firstElementChild;
      if (!from || !to || !(path instanceof SVGPathElement)) throw new Error("Semantic edge geometry is unavailable");
      setAttribute(group, "data-edge-id", item.id); setAttribute(group, "data-edge-key", item.id);
      setAttribute(group, "data-edge-from", item.from); setAttribute(group, "data-edge-to", item.to);
      setAttribute(group, "data-edge-type", item.kind); setAttribute(group, "data-edge-label", item.kind);
      if (structural || !path.hasAttribute("d")) setAttribute(path, "d", edgePath(from, to));
      setAttribute(path, "class", `semantic-map-edge-path relation-${item.kind}`);
    }
    if (removed) {
      const survivors = activeIds.filter((id) => nextNodes.has(id));
      if (survivors.length) this.archify.focus?.setMany(survivors, { toggle: false, updateUrl: false, preserveRoute: true });
      else this.archify.focus?.clear({ preserveView: true, updateUrl: false });
    }
    if (structural) {
      if (this.archify.routeProbe?.active()) this.archify.routeProbe.clear({ updateUrl: false, preserveView: true, restoreFocus: false });
      this.archify.finder?.refresh?.();
    }
    return { structural, nodeCount: graph.nodes.length, edgeCount: edges.length };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.svg.removeEventListener("click", this.onClick);
    this.svg.removeEventListener("keydown", this.onKeyDown);
    this.clearGraph();
    this.edgeLayer.remove(); this.nodeLayer.remove();
  }

  private clearGraph(): void {
    const active = this.archify.focus?.active() ?? null;
    if (active) this.archify.focus?.clear({ preserveView: true, updateUrl: false });
    this.nodeElements.clear(); this.edgeElements.clear(); this.slots.clear();
    this.edgeLayer.replaceChildren(); this.nodeLayer.replaceChildren();
  }

  private selectFromEvent(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const node = target.closest<SVGGElement>("[data-node-id]");
    const id = node?.getAttribute("data-node-id");
    if (!node || !id || !safeId.test(id)) return;
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    if (event instanceof KeyboardEvent) event.preventDefault();
    this.archify.focus?.set(id, { updateUrl: false });
  }
}
