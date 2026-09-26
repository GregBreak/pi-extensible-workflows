import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "packages/core/trajectory/vendor/archify");
const output = join(root, "packages/core/trajectory/src/assets");
const sourceInfo = JSON.parse(await readFile(join(vendor, "source.json"), "utf8"));
const rawInput = await readFile(join(vendor, "template.html"));
const inputBytes = Buffer.from(rawInput.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const inputHash = createHash("sha256").update(inputBytes).digest("hex");
if (inputHash !== sourceInfo.sha256) throw new Error(`Pinned Archify template checksum mismatch: ${inputHash}`);
let html = inputBytes.toString("utf8");
const patches = JSON.parse(await readFile(join(vendor, "patches.json"), "utf8"));
for (const patch of patches) {
  const count = html.split(patch.find).length - 1;
  if (count !== 1) throw new Error(`Archify patch anchor must match once, found ${String(count)}: ${patch.find.slice(0, 100)}`);
  html = html.replace(patch.find, patch.replacement);
}
const sourceFiles = [
  join(root, "scripts/build-semantic-map.mjs"),
  join(root, "packages/core/trajectory/src/semantic-map-build.ts"),
  join(root, "packages/core/trajectory/src/semantic-map/adapter.ts"),
  join(root, "packages/core/trajectory/src/semantic-map/renderer.ts"),
  join(root, "packages/core/trajectory/src/semantic-map/viewer.ts"),
  join(root, "packages/core/trajectory/src/semantic-map.css"),
  join(vendor, "patches.json"),
  join(vendor, "source.json")
];
const stampHash = createHash("sha256").update(inputBytes);
for (const path of sourceFiles) stampHash.update(Buffer.from((await readFile(path)).toString("utf8").replace(/\r\n/g, "\n"), "utf8"));
const stamp = stampHash.digest("hex").slice(0, 16);
html = html.replaceAll("__SEMANTIC_MAP_BUILD_STAMP__", stamp).replaceAll("[PROJECT NAME]", "Trajectory Semantic Map");
const jsResult = await esbuild.build({
  entryPoints: [join(root, "packages/core/trajectory/src/semantic-map/viewer.ts")],
  bundle: true, write: false, platform: "browser", format: "iife", target: ["es2022"], minify: true,
  define: { __SEMANTIC_MAP_BUILD_STAMP__: JSON.stringify(stamp) },
  legalComments: "none", charset: "utf8"
});
if (jsResult.outputFiles.length !== 1) throw new Error("Semantic Map bundler produced an unexpected output count");
const js = `/* Archify ${sourceInfo.revision}; build ${stamp}; licenses in ../../vendor/archify/LICENSE */\n${jsResult.outputFiles[0].text.replace(/\r\n/g, "\n")}`;
const cssInput = (await readFile(join(root, "packages/core/trajectory/src/semantic-map.css"), "utf8")).replace(/\r\n/g, "\n");
const css = `/* Semantic Map ${stamp} */\n${cssInput}`;
await Promise.all([
  writeFile(join(output, "semantic-map.html"), html, "utf8"),
  writeFile(join(output, "semantic-map.js"), js, "utf8"),
  writeFile(join(output, "semantic-map.css"), css, "utf8")
]);
process.stdout.write(`Semantic Map ${stamp}: ${Buffer.byteLength(html)} B HTML, ${Buffer.byteLength(js)} B JS, ${Buffer.byteLength(css)} B CSS\n`);
