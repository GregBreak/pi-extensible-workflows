import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const trajectory = join(root, "packages/core/trajectory");
const vendor = join(trajectory, "vendor/archify");
const assets = join(trajectory, "src/assets");
const normalize = (value) => value.replace(/\r\n/g, "\n");
async function writeIfChanged(path, value) {
  try { if ((await readFile(path, "utf8")) === value) return; } catch { /* New generated output. */ }
  await writeFile(path, value, "utf8");
}
function replaceOnce(value, find, replacement, description) {
  const first = value.indexOf(find);
  if (first < 0 || value.indexOf(find, first + find.length) >= 0) throw new Error(`Expected exactly one ${description}`);
  return value.slice(0, first) + replacement + value.slice(first + find.length);
}

const sourceInfo = JSON.parse(await readFile(join(vendor, "source.json"), "utf8"));
const rawInput = await readFile(join(vendor, "template.html"));
const inputBytes = Buffer.from(normalize(rawInput.toString("utf8")), "utf8");
const inputHash = createHash("sha256").update(inputBytes).digest("hex");
if (inputHash !== sourceInfo.sha256) throw new Error(`Pinned Archify template checksum mismatch: ${inputHash}`);
let viewerHtml = inputBytes.toString("utf8");
const patches = JSON.parse(await readFile(join(vendor, "patches.json"), "utf8"));
for (const patch of patches) {
  const count = viewerHtml.split(patch.find).length - 1;
  if (count !== 1) throw new Error(`Archify patch anchor must match once, found ${String(count)}: ${patch.find.slice(0, 100)}`);
  viewerHtml = viewerHtml.replace(patch.find, patch.replacement);
}

const bridgePath = join(trajectory, "src/semantic-map/bridge.ts");
const bridgeSource = normalize(await readFile(bridgePath, "utf8"));
const bridgeStart = "export const SEMANTIC_MAP_BRIDGE_CLIENT = `";
const bridgeEnd = "`;\n\nexport const SEMANTIC_MAP_BRIDGE_LIMITS";
const bridgeStartAt = bridgeSource.indexOf(bridgeStart);
const bridgeEndAt = bridgeSource.indexOf(bridgeEnd, bridgeStartAt + bridgeStart.length);
if (bridgeStartAt < 0 || bridgeEndAt < 0 || bridgeSource.indexOf(bridgeStart, bridgeStartAt + bridgeStart.length) >= 0 || bridgeSource.slice(bridgeStartAt + bridgeStart.length, bridgeEndAt).includes("`")) {
  throw new Error("Could not extract the single, literal child-side MessagePort bridge source");
}
const childBridge = bridgeSource.slice(bridgeStartAt + bridgeStart.length, bridgeEndAt).trim();

const shellPath = join(assets, "index.html");
let shell = normalize(await readFile(shellPath, "utf8"));
shell = shell.replace(/\s*<meta name="semantic-map-build" content="[0-9a-f]{16}">\n/g, "\n");
const appOpen = "<script data-semantic-map-app>";
const appOpenAt = shell.indexOf(appOpen);
const appCloseAt = shell.indexOf("</script>", appOpenAt + appOpen.length);
if (appOpenAt < 0 || appCloseAt < 0 || shell.indexOf(appOpen, appOpenAt + appOpen.length) >= 0) throw new Error("Expected one generated Semantic Map app script in the main Trajectory shell");
const appMarker = "__SEMANTIC_MAP_APP_BUNDLE__";
const canonicalShell = shell.slice(0, appOpenAt + appOpen.length) + `\n${appMarker}\n  ` + shell.slice(appCloseAt);
const appResult = await esbuild.build({
  entryPoints: [join(trajectory, "src/semantic-map/index.ts")],
  bundle: true, write: false, platform: "browser", format: "iife", target: ["es2022"], minify: true,
  legalComments: "none", charset: "utf8"
});
if (appResult.outputFiles.length !== 1) throw new Error("Semantic Map app bundler produced an unexpected output count");
const appBundle = normalize(appResult.outputFiles[0].text).trim();

const sourceFiles = [
  join(root, "scripts/build-semantic-map.mjs"),
  join(trajectory, "src/semantic-map-build.ts"),
  join(trajectory, "src/semantic-map/adapter.ts"),
  join(trajectory, "src/semantic-map/bridge.ts"),
  join(trajectory, "src/semantic-map/index.ts"),
  join(trajectory, "src/semantic-map/renderer.ts"),
  join(trajectory, "src/semantic-map/viewer.ts"),
  join(trajectory, "src/semantic-map.css"),
  join(vendor, "patches.json"),
  join(vendor, "source.json")
];
const stampHash = createHash("sha256").update(inputBytes).update(canonicalShell).update(appBundle).update(childBridge);
for (const path of sourceFiles) stampHash.update(Buffer.from(normalize(await readFile(path, "utf8")), "utf8"));
const stamp = stampHash.digest("hex").slice(0, 16);
viewerHtml = viewerHtml.replaceAll("__SEMANTIC_MAP_BUILD_STAMP__", stamp).replaceAll("[PROJECT NAME]", "Trajectory Semantic Map");
const generatedAppScript = `<script data-semantic-map-app>\n${appBundle}\n  </script>`;
const appHtml = replaceOnce(shell, shell.slice(appOpenAt, appCloseAt + "</script>".length), generatedAppScript, "main app script");
const stampedAppHtml = replaceOnce(appHtml, "</head>", `  <meta name="semantic-map-build" content="${stamp}">\n</head>`, "main shell head close");
const viewerResult = await esbuild.build({
  entryPoints: [join(trajectory, "src/semantic-map/viewer.ts")],
  bundle: true, write: false, platform: "browser", format: "iife", target: ["es2022"], minify: true,
  define: { __SEMANTIC_MAP_BUILD_STAMP__: JSON.stringify(stamp) },
  legalComments: "none", charset: "utf8"
});
if (viewerResult.outputFiles.length !== 1) throw new Error("Semantic Map viewer bundler produced an unexpected output count");
const js = `/* Archify ${sourceInfo.revision}; build ${stamp}; licenses: trajectory/vendor/archify/LICENSE */\n${normalize(viewerResult.outputFiles[0].text).trim()}\n/* PIEWF_SEMANTIC_MAP_PRIVATE_BRIDGE */\n${childBridge}\n`;
const cssInput = normalize(await readFile(join(trajectory, "src/semantic-map.css"), "utf8"));
const css = `/* Semantic Map ${stamp} */\n${cssInput}`;
const tsStamp = `/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */\nexport const SEMANTIC_MAP_BUILD_STAMP = ${JSON.stringify(stamp)};\n`;
await Promise.all([
  writeIfChanged(shellPath, normalize(stampedAppHtml)),
  writeIfChanged(join(assets, "semantic-map.html"), normalize(viewerHtml)),
  writeIfChanged(join(assets, "semantic-map.js"), normalize(js)),
  writeIfChanged(join(assets, "semantic-map.css"), normalize(css)),
  writeIfChanged(join(trajectory, "src/semantic-map-assets.ts"), tsStamp)
]);
process.stdout.write(`Semantic Map ${stamp}: ${Buffer.byteLength(viewerHtml)} B HTML, ${Buffer.byteLength(js)} B JS, ${Buffer.byteLength(css)} B CSS\n`);
