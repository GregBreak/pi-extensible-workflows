import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import { SEMANTIC_MAP_BUILD_STAMP } from "../src/semantic-map-assets.js";

void test("Semantic Map build publishes three stamped assets at one canonical package location", async () => {
  assert.match(SEMANTIC_MAP_BUILD_STAMP, /^[0-9a-f]{16}$/);
  const names = ["semantic-map.html", "semantic-map.js", "semantic-map.css"] as const;
  const canonicalDirectory = new URL("../assets/", import.meta.url);
  const serverDirectory = new URL("../src/assets/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { files?: string[] };
  for (const name of names) {
    const asset = new URL(name, canonicalDirectory);
    const info = await stat(asset);
    assert.ok(info.isFile() && info.size > 0, `${name} is generated into the canonical dist/trajectory/assets package location`);
    assert.deepEqual(await readFile(new URL(name, serverDirectory)), await readFile(asset), `${name} remains available in the source-compatible dist asset tree`);
    assert.ok(manifest.files?.includes(`!dist/trajectory/src/assets/${name}`));
    assert.ok(manifest.files?.includes(`!trajectory/src/assets/${name}`));
  }
  assert.ok(manifest.files?.includes("!trajectory/src/semantic-map.css"), "the authored stylesheet is build input, not a second distributed browser stylesheet");
  const [html, js, css, canonicalNames] = await Promise.all([
    readFile(new URL("semantic-map.html", canonicalDirectory), "utf8"),
    readFile(new URL("semantic-map.js", canonicalDirectory), "utf8"),
    readFile(new URL("semantic-map.css", canonicalDirectory), "utf8"),
    readdir(canonicalDirectory)
  ]);
  assert.ok(html.includes(`<meta name="semantic-map-build" content="${SEMANTIC_MAP_BUILD_STAMP}">`));
  assert.ok(js.includes(`build ${SEMANTIC_MAP_BUILD_STAMP}`));
  assert.ok(css.includes(`Semantic Map ${SEMANTIC_MAP_BUILD_STAMP}`));
  assert.deepEqual(canonicalNames.filter((name) => name.startsWith("semantic-map.")).sort(), [...names].sort());
  assert.ok(Buffer.byteLength(html) + Buffer.byteLength(js) + Buffer.byteLength(css) < 1_000_000);
});
