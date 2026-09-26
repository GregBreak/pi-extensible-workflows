import type { SemanticSnapshot } from "./adapter.js";
import { SEMANTIC_MAP_LIMITS, SEMANTIC_MAP_VERSION } from "../semantic-map-build.js";

const CHANNEL = "pi-workflows-semantic-map";
const MAX_MESSAGE_BYTES = SEMANTIC_MAP_LIMITS.payloadBytes;
const ID_PATTERN = /^sm-(?:[0-9a-f]{2})+$/;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const PORT_MESSAGE_KEYS: Record<string, ReadonlySet<string>> = {
  ready: new Set(["type", "version", "nonce", "instance"]),
  ack: new Set(["type", "version", "nonce", "instance", "sequence", "epoch", "nodeIds", "error"]),
  select: new Set(["type", "version", "nonce", "instance", "nodeId", "epoch"]),
  detail: new Set(["type", "version", "nonce", "instance", "nodeId", "epoch"])
};
const encoder = new TextEncoder();

type PortEnvelope = { type: string; version: number; instance: string; nonce: string; [key: string]: unknown };
export type ParentSemanticNode = { id: string; kind: "workflow" | "task" | "agent" | "tool-call" | "result"; sourceRef: string };
type QueuedSnapshot = { text: string; snapshot: SemanticSnapshot; nodes: ReadonlyMap<string, ParentSemanticNode>; nodeCount: number; epoch: number };
type BridgeOptions = {
  host: HTMLElement;
  url: string;
  onStatus: (status: string) => void;
  onRequest: (node: ParentSemanticNode, detail: boolean) => void;
  theme: () => "light" | "dark";
};

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validEnvelope(value: unknown): value is PortEnvelope {
  if (!record(value)) return false;
  try { if (encoder.encode(JSON.stringify(value)).byteLength > MAX_MESSAGE_BYTES) return false; } catch { return false; }
  if (value.version !== SEMANTIC_MAP_VERSION || typeof value.type !== "string" || !PORT_MESSAGE_KEYS[value.type]) return false;
  const allowed = PORT_MESSAGE_KEYS[value.type];
  if (Object.keys(value).some((key) => !allowed?.has(key))) return false;
  return typeof value.nonce === "string" && NONCE_PATTERN.test(value.nonce) && typeof value.instance === "string" && NONCE_PATTERN.test(value.instance);
}
function randomToken(): string {
  const bytes = new Uint8Array(32);
  try { globalThis.crypto.getRandomValues(bytes); }
  catch { throw new Error("Secure randomness is unavailable; Semantic Map could not start"); }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lazy parent-side MessagePort bridge. No frame, listener, timer, adapter or serialization exists until open(). */
export class SemanticMapBridge {
  private active = false;
  private visible = true;
  private failed = false;
  private frame: HTMLIFrameElement | undefined;
  private frameLoad: (() => void) | undefined;
  private port: MessagePort | undefined;
  private nonce = "";
  private instance = "";
  private phase: "closed" | "loading" | "ready" | "failed" = "closed";
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSendAt = 0;
  private sequence = 0;
  private epoch = 0;
  private inFlight: { sequence: number; epoch: number; text: string; nodes: ReadonlyMap<string, ParentSemanticNode> } | undefined;
  private renderedNodes: ReadonlyMap<string, ParentSemanticNode> = new Map();
  private pending: QueuedSnapshot | undefined;
  private latest: QueuedSnapshot | undefined;
  private lastSentText: string | undefined;
  private scopeIdentity = "";
  private theme: "light" | "dark" = "dark";

  constructor(private readonly options: BridgeOptions) {}

  open(): void {
    if (this.active) return;
    this.active = true;
    this.failed = false;
    this.phase = "loading";
    this.pending = undefined;
    this.latest = undefined;
    this.inFlight = undefined;
    this.renderedNodes = new Map();
    this.lastSentText = undefined;
    this.scopeIdentity = "";
    this.clearTimers();
    try { this.nonce = randomToken(); this.instance = randomToken(); }
    catch (error) {
      this.failed = true;
      this.active = false;
      this.phase = "failed";
      this.options.onStatus(error instanceof Error ? error.message : "Secure Semantic Map initialization failed");
      return;
    }
    this.theme = this.options.theme();
    const frame = document.createElement("iframe");
    frame.title = "Semantic Map of the selected workflow";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("aria-label", "Interactive Semantic Map");
    frame.dataset.semanticMapInstance = this.instance;
    frame.src = this.options.url;
    frame.style.cssText = "display:block;width:100%;height:100%;min-height:280px;border:0;background:transparent";
    this.frame = frame;
    const loaded = (): void => {
      this.frameLoad = undefined;
      if (this.active && this.frame === frame) this.bootstrap(frame);
    };
    this.frameLoad = loaded;
    frame.addEventListener("load", loaded, { once: true });
    this.options.host.replaceChildren(frame);
    this.options.onStatus("Loading Semantic Map…");
    this.loadTimer = setTimeout(() => { this.fail("Semantic Map did not complete its secure handshake"); }, 10_000);
  }

  update(snapshot: SemanticSnapshot | undefined, scopeIdentity: string, nodes: ReadonlyMap<string, ParentSemanticNode>, nodeCount: number): void {
    if (!this.active || this.failed) return;
    if (!snapshot) {
      this.epoch += 1;
      this.pending = undefined;
      this.latest = undefined;
      this.lastSentText = undefined;
      this.scopeIdentity = "";
      this.renderedNodes = new Map();
      this.options.onStatus("No selected workflow or subagent. Select a target, then reopen the map.");
      return;
    }
    try {
      const text = JSON.stringify(snapshot);
      if (encoder.encode(text).byteLength > MAX_MESSAGE_BYTES) throw new Error("Semantic Map snapshot exceeds the 512 KiB limit");
      if (nodes.size > SEMANTIC_MAP_LIMITS.nodes || !Number.isSafeInteger(nodeCount) || nodeCount < nodes.size || nodeCount > SEMANTIC_MAP_LIMITS.nodes) throw new Error("Invalid bounded Semantic Map node index");
      for (const [id, node] of nodes) if (!isSemanticMapNodeId(id) || id !== node.id || !["workflow", "task", "agent", "tool-call", "result"].includes(node.kind) || typeof node.sourceRef !== "string" || node.sourceRef.length > 256) throw new Error("Invalid Semantic Map node index");
      const nextScope = scopeIdentity;
      if (nextScope !== this.scopeIdentity) {
        this.scopeIdentity = nextScope;
        this.epoch += 1;
        this.lastSentText = undefined;
        this.renderedNodes = new Map();
      }
      if (text === this.latest?.text && this.latest.epoch === this.epoch || text === this.lastSentText && !this.pending && !this.inFlight) return;
      const queued = { snapshot, nodes, nodeCount, text, epoch: this.epoch };
      this.latest = queued;
      if (this.inFlight) this.pending = queued;
      else if (this.phase === "ready" && this.visible) { this.pending = queued; this.flush(); }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Invalid Semantic Map snapshot");
    }
  }

  setTheme(theme: "light" | "dark"): void {
    this.theme = theme;
    if (this.active && this.phase === "ready") this.sendTheme();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.clearAckTimer();
      if (this.sendTimer !== undefined) clearTimeout(this.sendTimer);
      this.sendTimer = undefined;
      this.clearLoadTimer();
      return;
    }
    if (!this.active) return;
    if (this.phase === "loading" && this.frame && this.loadTimer === undefined) {
      this.loadTimer = setTimeout(() => { this.fail("Semantic Map did not complete its secure handshake"); }, 10_000);
      return;
    }
    if (this.phase === "ready" && this.inFlight && this.ackTimer === undefined) {
      this.ackTimer = setTimeout(() => { this.fail("Semantic Map stopped responding"); }, 10_000);
    }
    if (this.phase === "ready" && !this.inFlight && this.latest && this.latest.text !== this.lastSentText) {
      this.pending = this.latest;
      this.flush();
    }
  }

  close(): void {
    this.active = false;
    this.phase = "closed";
    this.epoch += 1;
    this.pending = undefined;
    this.latest = undefined;
    this.inFlight = undefined;
    this.renderedNodes = new Map();
    this.lastSentText = undefined;
    this.scopeIdentity = "";
    this.clearTimers();
    if (this.frame && this.frameLoad) this.frame.removeEventListener("load", this.frameLoad);
    this.frameLoad = undefined;
    this.port?.close();
    this.port = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.options.host.replaceChildren();
    this.options.onStatus("");
  }

  private bootstrap(frame: HTMLIFrameElement): void {
    if (!this.active || this.phase !== "loading" || this.frame !== frame || !frame.contentWindow) return;
    const channel = new MessageChannel();
    this.port = channel.port1;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => { this.receive(event.data); };
    channel.port1.start();
    try {
      // This one wildcard transfer contains only the handshake and a private MessagePort, never run data.
      frame.contentWindow.postMessage({ channel: CHANNEL, type: "bootstrap", version: SEMANTIC_MAP_VERSION, nonce: this.nonce, instance: this.instance }, "*", [channel.port2]);
    } catch { this.fail("Semantic Map handshake could not start"); return; }
  }

  private receive(value: unknown): void {
    if (!this.active || !validEnvelope(value)) return;
    if (value.instance !== this.instance || value.nonce !== this.nonce) return;
    if (this.phase === "loading") {
      if (value.type !== "ready") return;
      this.phase = "ready";
      this.clearLoadTimer();
      this.options.onStatus("Semantic Map ready");
      this.sendTheme();
      if (this.visible && this.latest) { this.pending = this.latest; this.flush(); }
      return;
    }
    if (this.phase !== "ready") return;
    if (value.type === "ack") {
      if (!this.inFlight || value.sequence !== this.inFlight.sequence || value.epoch !== this.inFlight.epoch) return;
      const accepted = this.inFlight;
      this.inFlight = undefined;
      this.clearAckTimer();
      if (typeof value.error === "string") { this.fail("Semantic Map could not render the current snapshot"); return; }
      if (accepted.epoch === this.epoch) {
        if (!Array.isArray(value.nodeIds) || value.nodeIds.length > SEMANTIC_MAP_LIMITS.nodes) { this.fail("Semantic Map returned an invalid node index"); return; }
        const visibleNodes = new Map<string, ParentSemanticNode>();
        for (const id of value.nodeIds) {
          if (!isSemanticMapNodeId(id)) { this.fail("Semantic Map returned an invalid node ID"); return; }
          const node = accepted.nodes.get(id);
          if (!node || visibleNodes.has(id)) { this.fail("Semantic Map returned an out-of-scope node ID"); return; }
          visibleNodes.set(id, node);
        }
        this.renderedNodes = visibleNodes;
        if (this.latest?.text === accepted.text && this.latest.epoch === this.epoch) this.latest = { ...this.latest, nodes: visibleNodes, nodeCount: visibleNodes.size };
        this.lastSentText = accepted.text;
        this.options.onStatus(`Partial graph · ${String(visibleNodes.size)} nodes`);
      }
      if (this.visible && this.pending && this.pending.epoch === this.epoch) this.flush();
      return;
    }
    if (value.type !== "select" && value.type !== "detail") return;
    const id = value.nodeId;
    if (typeof id !== "string" || id.length > 4096 || !ID_PATTERN.test(id) || value.epoch !== this.epoch || !this.latest || this.latest.epoch !== this.epoch) return;
    const node = this.renderedNodes.get(id);
    if (!node) return;
    this.options.onRequest(node, value.type === "detail");
  }

  private sendTheme(): void {
    if (!this.port || this.phase !== "ready") return;
    try { this.port.postMessage({ type: "theme", version: SEMANTIC_MAP_VERSION, nonce: this.nonce, instance: this.instance, theme: this.theme }); }
    catch { this.fail("Semantic Map theme could not be updated"); }
  }

  private flush(): void {
    if (!this.active || this.phase !== "ready" || !this.visible || this.inFlight || !this.pending || !this.port) return;
    const delay = Math.max(0, 250 - (Date.now() - this.lastSendAt));
    if (delay) {
      if (!this.sendTimer) this.sendTimer = setTimeout(() => { this.sendTimer = undefined; this.flush(); }, delay);
      return;
    }
    const next = this.pending;
    this.pending = undefined;
    const sequence = ++this.sequence;
    this.inFlight = { sequence, epoch: next.epoch, text: next.text, nodes: next.nodes };
    this.lastSendAt = Date.now();
    try {
      this.port.postMessage({ type: "snapshot", version: SEMANTIC_MAP_VERSION, nonce: this.nonce, instance: this.instance, sequence, epoch: next.epoch, snapshot: next.snapshot });
    } catch { this.fail("Semantic Map update could not be sent"); return; }
    this.options.onStatus("Rendering Semantic Map…");
    this.ackTimer = setTimeout(() => { this.fail("Semantic Map stopped responding"); }, 10_000);
  }

  private fail(message: string): void {
    if (!this.active) return;
    this.failed = true;
    this.active = false;
    this.phase = "failed";
    this.clearTimers();
    if (this.frame && this.frameLoad) this.frame.removeEventListener("load", this.frameLoad);
    this.frameLoad = undefined;
    this.port?.close();
    this.port = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.pending = undefined;
    this.latest = undefined;
    this.inFlight = undefined;
    this.renderedNodes = new Map();
    this.lastSentText = undefined;
    this.scopeIdentity = "";
    this.options.host.replaceChildren();
    this.options.onStatus(message);
  }

  private clearLoadTimer(): void { if (this.loadTimer !== undefined) clearTimeout(this.loadTimer); this.loadTimer = undefined; }
  private clearAckTimer(): void { if (this.ackTimer !== undefined) clearTimeout(this.ackTimer); this.ackTimer = undefined; }
  private clearTimers(): void {
    this.clearLoadTimer(); this.clearAckTimer();
    if (this.sendTimer !== undefined) clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
  }
}

/** Child-side opaque-window bootstrap and strict MessagePort client, appended by the maintainer build. */
export const SEMANTIC_MAP_BRIDGE_CLIENT = `(()=>{
  const channelName="pi-workflows-semantic-map",maxBytes=512*1024,noncePattern=/^[0-9a-f]{64}$/,idPattern=/^sm-(?:[0-9a-f]{2})+$/;
  const encoder=new TextEncoder();let initialized=false,port,nonce,instance,epoch=-1,lastSequence=0,nodeIds=new Set();
  const record=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
  const bytes=value=>{try{return encoder.encode(JSON.stringify(value)).byteLength}catch{return maxBytes+1}};
  const send=(value)=>{if(!port)return;try{port.postMessage({...value,version:1,nonce,instance})}catch{}};
  const request=(event,type)=>{if(!initialized||!nodeIds.size)return;const target=event.target instanceof Element?event.target.closest("[data-node-id]"):null;const id=target?.getAttribute("data-node-id");if(typeof id!=="string"||id.length>4096||!idPattern.test(id)||!nodeIds.has(id))return;send({type,nodeId:id,epoch})};
  const accept=(event)=>{
    const data=event.data;
    if(initialized||event.source!==parent||!record(data)||Object.keys(data).length!==5||Object.keys(data).some(key=>!["channel","type","version","nonce","instance"].includes(key))||data.channel!==channelName||data.type!=="bootstrap"||data.version!==1||typeof data.nonce!=="string"||!noncePattern.test(data.nonce)||typeof data.instance!=="string"||!noncePattern.test(data.instance)||event.ports.length!==1)return;
    initialized=true;nonce=data.nonce;instance=data.instance;port=event.ports[0];window.removeEventListener("message",accept);
    const svg=document.querySelector(".diagram-container > svg");
    const click=event=>request(event,"select"),detail=event=>request(event,"detail"),key=event=>{if(event.key==="Enter"||event.key===" ")request(event,"select")};
    if(svg){svg.addEventListener("click",click);svg.addEventListener("dblclick",detail);svg.addEventListener("keydown",key)}
    port.onmessage=message=>{
      const next=message.data;
      if(!record(next)||bytes(next)>maxBytes||next.version!==1||next.nonce!==nonce||next.instance!==instance)return;
      if(next.type==="theme"){if(Object.keys(next).some(key=>!["type","version","nonce","instance","theme"].includes(key))||next.theme!=="light"&&next.theme!=="dark")return;document.documentElement.setAttribute("data-theme",next.theme);return}
      if(next.type!=="snapshot"||Object.keys(next).some(key=>!["type","version","nonce","instance","sequence","epoch","snapshot"].includes(key))||!Number.isSafeInteger(next.sequence)||next.sequence<=lastSequence||!Number.isSafeInteger(next.epoch)||!record(next.snapshot))return;
      lastSequence=next.sequence;const seq=next.sequence,incomingEpoch=next.epoch;
      if(incomingEpoch<epoch){send({type:"ack",sequence:seq,epoch:incomingEpoch,nodeIds:Array.from(nodeIds)});return}
      try{if(!window.SemanticMap||window.SemanticMap.version!==1)throw Error("viewer version mismatch");const graph=window.SemanticMap.render(next.snapshot);epoch=incomingEpoch;nodeIds=new Set(graph.nodes.map(node=>node.id));send({type:"ack",sequence:seq,epoch:incomingEpoch,nodeIds:Array.from(nodeIds)})}catch(error){send({type:"ack",sequence:seq,epoch:incomingEpoch,error:(error instanceof Error?error.message:"render failed").slice(0,200)})}
    };
    port.start();send({type:"ready"});
  };
  window.addEventListener("message",accept);
})();`;

export const SEMANTIC_MAP_BRIDGE_LIMITS = Object.freeze({ messageBytes: MAX_MESSAGE_BYTES, messagesPerSecond: 4 });
export function isValidSemanticMapBridgeEnvelope(value: unknown): boolean { return validEnvelope(value); }
export function isSemanticMapNodeId(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && ID_PATTERN.test(value); }
