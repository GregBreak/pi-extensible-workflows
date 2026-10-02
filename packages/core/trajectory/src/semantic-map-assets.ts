/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */
export const SEMANTIC_MAP_BUILD_STAMP = "73ee054b92d038dc";
export type SemanticMapAssetName = "index.html" | "semantic-map.html" | "semantic-map.js" | "semantic-map.css";
export type SemanticMapAssetDigest = Readonly<{ bytes: number; sha256: string }>;
/** Expected final bytes of the parent shell and the three browser assets for this build; a server constant, not a browser asset. */
export const SEMANTIC_MAP_ASSET_MANIFEST: Readonly<{ schema: 1; stamp: string; versionParameter: "v"; assets: Readonly<Record<SemanticMapAssetName, SemanticMapAssetDigest>> }> = Object.freeze({
  schema: 1,
  stamp: SEMANTIC_MAP_BUILD_STAMP,
  versionParameter: "v",
  assets: Object.freeze({
    "index.html": Object.freeze({ bytes: 181199, sha256: "6fd8d18493e25bdecdb7abc28df26097b09c85ce704db2bff3581385a1513a62" }),
    "semantic-map.html": Object.freeze({ bytes: 772188, sha256: "ad38c8ebda0678c0fd27410c8d931e9bc6cbcd04340f8903a960920d6e3e9cc7" }),
    "semantic-map.js": Object.freeze({ bytes: 38346, sha256: "e701cbf6125d2afbe9aed68ef57efcaf9342208aefd609293c28667c07e5549d" }),
    "semantic-map.css": Object.freeze({ bytes: 13136, sha256: "e3724f7471a59b0035bd2ecd003b97a0e412062fbd7e866cab12bbf6bd3aca5d" })
  })
});
