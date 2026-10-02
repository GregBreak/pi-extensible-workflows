/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */
export const SEMANTIC_MAP_BUILD_STAMP = "a7ea51ffcc89aeb8";
export type SemanticMapAssetName = "index.html" | "semantic-map.html" | "semantic-map.js" | "semantic-map.css";
export type SemanticMapAssetDigest = Readonly<{ bytes: number; sha256: string }>;
/** Expected final bytes of the parent shell and the three browser assets for this build; a server constant, not a browser asset. */
export const SEMANTIC_MAP_ASSET_MANIFEST: Readonly<{ schema: 1; stamp: string; versionParameter: "v"; assets: Readonly<Record<SemanticMapAssetName, SemanticMapAssetDigest>> }> = Object.freeze({
  schema: 1,
  stamp: SEMANTIC_MAP_BUILD_STAMP,
  versionParameter: "v",
  assets: Object.freeze({
    "index.html": Object.freeze({ bytes: 175433, sha256: "3529263188bf63d33d048d80b8ac1711c6001964d0298819a8726e4f993f58f2" }),
    "semantic-map.html": Object.freeze({ bytes: 772188, sha256: "621b870cd9f9ecbf48b302c932dc4ee8a5ff31cc9ccfb7329fb95aab6a8babdd" }),
    "semantic-map.js": Object.freeze({ bytes: 32463, sha256: "94f04028ea4cecc7d103ce4bb3763ace56539e0bfc2a0b027ac0003be9e3ca4a" }),
    "semantic-map.css": Object.freeze({ bytes: 9410, sha256: "1247dbf625fddde4bb86b609035da5232a3dab928e3b526087de2d6716e9eb4f" })
  })
});
