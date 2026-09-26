import { adaptSemanticSnapshot, type SemanticGraph, type SemanticSnapshot } from "./adapter.js";
import { SemanticMapRenderer } from "./renderer.js";

declare global { interface Window { Archify?: ConstructorParameters<typeof SemanticMapRenderer>[0]; SemanticMap?: SemanticMapApi } }
export type SemanticMapApi = { version: 1; build: string; render: (snapshot: SemanticSnapshot) => SemanticGraph; dispose: () => void };
declare const __SEMANTIC_MAP_BUILD_STAMP__: string;

function start(): void {
  if (window.SemanticMap) return;
  const renderer = new SemanticMapRenderer(window.Archify);
  const api: SemanticMapApi = {
    version: 1,
    build: __SEMANTIC_MAP_BUILD_STAMP__,
    render(snapshot) {
      const graph = adaptSemanticSnapshot(snapshot);
      renderer.render(graph);
      const notice = document.getElementById("semantic-map-completeness");
      if (notice) notice.textContent = graph.completeness.partial ? `Partial graph — ${graph.completeness.reasons.join("; ")}` : `Complete within available metadata — ${String(graph.nodes.length)} nodes`;
      return graph;
    },
    dispose() { renderer.dispose(); delete window.SemanticMap; }
  };
  window.SemanticMap = api;
  const diagram = document.querySelector(".diagram-container");
  if (diagram && !document.getElementById("semantic-map-completeness")) {
    const notice = document.createElement("p");
    notice.id = "semantic-map-completeness";
    notice.className = "semantic-map-completeness";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    diagram.append(notice);
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
