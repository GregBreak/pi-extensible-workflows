import type { SemanticGraph, SemanticNode } from "./adapter.js";

export const SEMANTIC_CARD = Object.freeze({ width: 140, height: 52, stepX: 154, stepY: 70 });
const COLUMNS = 3;
const BOX_WIDTH = 24 + (COLUMNS - 1) * SEMANTIC_CARD.stepX + SEMANTIC_CARD.width;
const BOX_GAP = 28;
const HEADER = 50;
const FOOTER = 22;
const STAGE_LABEL = 26;
const STAGE_GAP = 64;
const MARGIN = 18;
const BOXES_PER_ROW = 2;
const ROW_GAP = 30;
/** Room above the first stage for the viewer's floating target title. */
const TOP = 46;
const STATS_RESERVE = 72;
/** `row`/`col` are the serpentine grid position inside the agent box (odd rows run right to left). */
export type SemanticSlot = { x: number; y: number; slot: number; row: number; col: number; group: string };
export type SemanticAgentGroup = {
  id: string; agentId?: string; label: string; status: string; count: number; colorIndex: number; running: boolean;
  stage: number; stageLabel?: string; x: number; y: number; width: number; height: number;
  /** Bottom of the tallest box in the same stage: inter-agent arrows travel in the gap below it. */
  stageBottom: number;
  /** Bottom of this box's row inside its stage and the free vertical lane left of the box, for arrow routing. */
  rowBottom: number; laneX: number;
};
export type SemanticStage = { index: number; label?: string; x: number; y: number };
export type SemanticLayout = { groups: SemanticAgentGroup[]; slots: Map<string, SemanticSlot>; stages: SemanticStage[]; width: number; height: number };
const groupId = (agentId: string): string => JSON.stringify(["agent", agentId]);
const inBox = (node: SemanticNode): number => node.kind === "agent" ? 0 : node.kind === "result" ? 2 : 1;

/**
 * Presentation only. Each agent is one box; boxes are arranged in rows by recorded workflow phase and launch order.
 * Workflow and scope nodes are not drawn as cards: their information is written on the agent boxes and stage labels.
 * Ownership is explicit adapter metadata, never guessed from labels, ID prefixes or causal edges.
 */
export class SemanticAgentLayout {
  private readonly colorOrder = new Map<string, number>();

  clear(): void { this.colorOrder.clear(); }

  arrange(graph: SemanticGraph): SemanticLayout {
    const byAgent = new Map<string, SemanticNode[]>();
    for (const node of graph.nodes) {
      if (node.agentId === undefined) continue;
      const nodes = byAgent.get(node.agentId) ?? [];
      nodes.push(node); byAgent.set(node.agentId, nodes);
    }
    // Colours and first-seen order stay with an agent for the lifetime of the view; new agents take the next ones.
    for (const key of this.colorOrder.keys()) if (!byAgent.has(key)) this.colorOrder.delete(key);
    let nextColor = Math.max(-1, ...this.colorOrder.values()) + 1;
    for (const agentId of [...byAgent.keys()].sort()) if (!this.colorOrder.has(agentId)) this.colorOrder.set(agentId, nextColor++);
    const primaryOf = (agentId: string): SemanticNode | undefined => byAgent.get(agentId)?.find((node) => node.kind === "agent" && node.sourceRef === agentId) ?? byAgent.get(agentId)?.find((node) => node.kind === "agent");
    const agentIds = [...byAgent.keys()].sort((a, b) => {
      const left = primaryOf(a), right = primaryOf(b);
      return (left?.stage ?? 0) - (right?.stage ?? 0) || (left?.launch ?? Number.MAX_SAFE_INTEGER) - (right?.launch ?? Number.MAX_SAFE_INTEGER) || (this.colorOrder.get(a) ?? 0) - (this.colorOrder.get(b) ?? 0);
    });

    const stageIndexes = [...new Set(agentIds.map((agentId) => primaryOf(agentId)?.stage ?? 0))].sort((a, b) => a - b);
    const groups: SemanticAgentGroup[] = [];
    const slots = new Map<string, SemanticSlot>();
    const stages: SemanticStage[] = [];
    let top = TOP;
    let width = 1000;
    for (const stage of stageIndexes) {
      const members = agentIds.filter((agentId) => (primaryOf(agentId)?.stage ?? 0) === stage);
      const label = primaryOf(members[0] ?? "")?.stageLabel;
      stages.push({ index: stage, ...(label === undefined ? {} : { label }), x: MARGIN, y: top + 16 });
      const stageGroups: SemanticAgentGroup[] = [];
      let rowTop = top + STAGE_LABEL;
      let rowGroups: SemanticAgentGroup[] = [];
      const closeRow = (): void => { const bottom = Math.max(rowTop, ...rowGroups.map((group) => group.y + group.height)); for (const group of rowGroups) group.rowBottom = bottom; rowTop = bottom + ROW_GAP; rowGroups = []; };
      members.forEach((agentId, index) => {
        const column = index % BOXES_PER_ROW;
        if (index > 0 && column === 0) closeRow();
        const boxTop = rowTop;
        const nodes = [...(byAgent.get(agentId) ?? [])].sort((a, b) => inBox(a) - inBox(b) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
        const rows = Math.max(1, Math.ceil(nodes.length / COLUMNS));
        const x = MARGIN + column * (BOX_WIDTH + BOX_GAP);
        const height = HEADER + rows * SEMANTIC_CARD.stepY + FOOTER - (SEMANTIC_CARD.stepY - SEMANTIC_CARD.height);
        const primary = primaryOf(agentId);
        const key = groupId(agentId);
        stageGroups.push({
          id: key, agentId, label: primary?.label ?? `Agent ${agentId}`, status: primary?.rawStatus ?? "", count: nodes.length,
          colorIndex: (this.colorOrder.get(agentId) ?? 0) % 8, running: nodes.some((node) => node.state === "running"),
          stage, ...(label === undefined ? {} : { stageLabel: label }), x, y: boxTop, width: BOX_WIDTH, height, stageBottom: 0, rowBottom: 0, laneX: x - BOX_GAP / 2
        });
        rowGroups.push(stageGroups[stageGroups.length - 1] as SemanticAgentGroup);
        nodes.forEach((node, slot) => {
          const row = Math.floor(slot / COLUMNS);
          const col = row % 2 === 0 ? slot % COLUMNS : COLUMNS - 1 - (slot % COLUMNS);
          slots.set(node.id, { x: x + 12 + col * SEMANTIC_CARD.stepX, y: boxTop + HEADER + row * SEMANTIC_CARD.stepY, slot, row, col, group: key });
        });
        width = Math.max(width, x + BOX_WIDTH + MARGIN);
      });
      closeRow();
      const bottom = Math.max(top + STAGE_LABEL, ...stageGroups.map((group) => group.y + group.height));
      for (const group of stageGroups) group.stageBottom = bottom;
      groups.push(...stageGroups);
      top = bottom + STAGE_GAP;
    }
    return { groups, slots, stages, width, height: Math.max(680, top - STAGE_GAP + MARGIN + STATS_RESERVE) };
  }
}
