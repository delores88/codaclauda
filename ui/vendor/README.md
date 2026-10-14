# Vendored browser libraries

Exact files copied from the npm registry tarballs (`npm pack`, 2026-10-14) so the
desktop UI loads no remote content. All are free, open-source licenses; nothing
requires a paid key, unlock or account. SHA-256 of each shipped file is in
`SHA256SUMS.txt`.

| Library | Version | License | Shipped file(s) | Source path in package |
| --- | --- | --- | --- | --- |
| three.js | 0.170.0 | MIT | `three/three.module.min.js` | `build/three.module.min.js` |
| three.js addons | 0.170.0 | MIT | `three/addons/OrbitControls.js`, `RoundedBoxGeometry.js`, `BufferGeometryUtils.js` | `examples/jsm/{controls,geometries,utils}/` |
| marked | 15.0.12 | MIT | `marked/marked.esm.js` | `lib/marked.esm.js` |
| DOMPurify | 3.2.6 | Apache-2.0 OR MPL-2.0 | `dompurify/purify.es.js` (renamed from .mjs) | `dist/purify.es.mjs` |
| KaTeX | 0.16.22 | MIT | `katex/katex.js` (renamed from .mjs) | `dist/katex.mjs` |
| highlight.js | 11.11.1 (`@highlightjs/cdn-assets`) | BSD-3-Clause | `highlight/highlight.min.js` | `es/highlight.min.js` |

Modification: the three addons' bare `from 'three'` import was rewritten to the
relative `from '../three.module.min.js'` because the CSP forbids inline import
maps. No other bytes were changed. Each directory carries the package's own
license file. KaTeX renders MathML output only, so its fonts and CSS are not shipped.
