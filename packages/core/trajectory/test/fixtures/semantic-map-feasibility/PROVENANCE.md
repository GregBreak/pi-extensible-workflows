# Pinned Archify feasibility input (test-only)

- Upstream: [tt-a1i/archify](https://github.com/tt-a1i/archify)
- Revision: [`9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993`](https://github.com/tt-a1i/archify/tree/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993), identified by the supplied research as template label `2.17.0-dev.1` (not represented as a stable release).
- Input: [`archify/assets/template.html`](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/archify/assets/template.html), preserved verbatim as `archify-template.html` for offline browser feasibility tests.
- Raw size: 774,866 bytes. SHA-256: `505f1c6baa9c2454475c048aa75df8abd867e680e7b3b794b9218a95a56fc370`.
- Viewer contract: [`viewer/README.md`](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/viewer/README.md). The pinned contract describes generated static SVG input; Finder indexes once and has no reindex/mount/destroy API; Camera and several geometry-dependent modules retain page-lifetime references/listeners.
- License: [`archify/LICENSE`](https://github.com/tt-a1i/archify/blob/9e35d2b0b39b155553ba9fcfe0b4f2a5198dd993/archify/LICENSE), reproduced in `LICENSE`. Its MIT notice attributes Archify and Cocoon AI.
- The template embeds JetBrains Mono variable WOFF2 subsets and includes their SIL Open Font License 1.1 notice/text. It identifies Google Fonts service revision v24 and the JetBrains Mono Project Authors (2020).

The fixture is not a production viewer, runtime asset, new dependency, or claim that the upstream template supports live JSON. The browser test appends only an isolated test shim in memory; the pinned input file remains checksum-identical. No production source or package configuration is changed by this feasibility gate.
