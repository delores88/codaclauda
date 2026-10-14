# Source and license provenance

Ben Van Dorn's owner-authored build brief supplied on 2026-10-13 explicitly
authorizes reuse of his first-party code in CodaClauda and Spark Dev Bridge
under MIT, naming Ben Van Dorn / DeloresAI. It requires preserving attribution,
recording exact reused files/revisions, leaving PhaseForge unchanged, and
preserving third-party licenses. This authorization does not relicense third-party code.

CodaClauda's coordination engine and first-party interface code are independently written.
Version 0.2 adapts the reviewed DGXBridge updater modules listed below, under
the same owner's MIT license. No referenced repository was modified.
Read-only design references: NVIDIALink at observed HEAD
86c95438a114af4c8649e1121d79f3dc43826f04, docs/DESIGN.md, docs/CLI.md,
crates/sparkdev/src/mcp.rs, src-tauri/tauri.conf.json. Other inspected files
were untracked active work; they are not attributed to that commit or reused.

At the owner's request, the pagination and spacing work also references
DGXBridge (formerly Spark Dev Bridge) at NVIDIALink commit
cec817b7255cbfc922b214f2b55d7d4c1213db66: ui/app.js, ui/style.css and
ui/index.html. The referenced patterns are six-item pages, page clamping,
disabled boundary controls, wrapping action rows and responsive grid sizing.
CodaClauda implements these patterns independently; no code or artwork from
those files was copied. DGXBridge's repository remains unchanged.

Dependencies retain their own licenses. Release preparation must generate
the locked dependency inventory and notices for both CLI and GUI.

## Native updater source reuse

Source: `delores88/nvidialink`, commit
`7ad8d49bb7a635ab36044e426cad5195a847f733`, copyright Ben Van Dorn / DeloresAI,
MIT. Original bytes were read from Git and checked against the handoff hashes
before adaptation. CodaClauda changes product identity, the board/settings
binding, state admission guard, persistent MCP lease, helper binding validation
and renderer integration. These original hashes are provenance, not hashes of
the adapted destination files.

| Original path | Original SHA-256 |
| --- | --- |
| `src-tauri/src/updates.rs` | `17cbc0e9b9fc51ee54e6ea5597f04badd81b5c3479ce12d9b7c498fd30303d0e` |
| `src-tauri/src/update_verify.rs` | `46766689aa880392dfa8a4dd004a4daf3b58c0285bae2c4c26d1bed3a42d5bf8` |
| `src-tauri/src/update_helper.rs` | `86aadb54c0d941f6ee3ae0679436e518df80df47423fa231d723cd3ddba7b674` |
| `src-tauri/src/update-acquisition-keys.json` | `011c1681d43fef3cb7d53d459677236a3f36427b6a107cb93f1235595a980b40` |
| `src-tauri/src/update-review-keys.json` | `011c1681d43fef3cb7d53d459677236a3f36427b6a107cb93f1235595a980b40` |

The upstream sequence references owner-authorized MIT PhaseForge source at
`ac30e04fbf0ddc03ae0144fb06b6350cacdce1fc`: `desktop/updater.cjs`,
`desktop/update-marketplace.cjs`, `desktop/update-approval.cjs`,
`desktop/update-storage.cjs`, `desktop/update_runner.py` and their tests.
Its updater source hash is
`5d04b2100ee5c92390e9368165c5c6ad91ab119fff6396bea319fdae8ba0b832`.
No PhaseForge authentication, database, Python runtime or services were copied.

The signed-envelope and namespace-aware NSIS manifest checks derive through
that handoff from DeloresAI Marketplace commit
`44c861d778e6880afebb34407a86798db39a9ada`: desktop `metadata.rs`, `review.rs`,
`nsis.rs`; API `catalog.ts`, `native-updates.ts`; contracts `native-updates.ts`;
and `docs/NATIVE-UPDATE-AUTHORIZATION.md`. Retain upstream attribution and all
dependency notices. The separate purpose-scoped public-key maps are unchanged.

Upstream's 17 desktop tests do not establish acceptance of these adaptations.
CodaClauda needs its own tests and actual installation/update evidence.

## Vendored browser dependencies for 0.3

The UI owner records the exact files added under `ui/vendor/` in
`ui/vendor/manifest.json`, alongside upstream licenses. This source manifest is
required whenever the vendor directory contains files. Release generation
checks the manifest before reconciling Rust notices, without running package
scripts or extracting archives into the checkout. It downloads only versioned
npm registry tarballs with recorded SHA-256 hashes, verifies their
`package/package.json` name and version, and records the exact license expression
from that package manifest. Versions and hashes are not inferred from filenames
or a README.

Schema 1 is an object with `schema_version: 1` and a nonempty `packages` array.
Each package contains:

- `name` and `version`: exact npm package identity, including a scope if present.
- `source`: `url` of its exact `https://registry.npmjs.org/` versioned `.tgz`
  archive, and lowercase 64-character `sha256` of the archive bytes.
- `files`: an entry for every shipped file, including license files. Each entry
  has `path` relative to `ui/vendor/`, `source_path` naming the exact tar member
  (normally beginning `package/`), and lowercase `sha256` of the shipped bytes.
- `notices`: vendor-relative paths to the unchanged license/copyright/NOTICE
  files, also included in `files`. Include every license or NOTICE at the package
  root and in its root `license/` or `licenses/` directory.
- Optional `license_expression`: when provided, it must exactly match the
  archive's `package.json`. Omitting it uses that upstream value directly.
- When fonts are shipped, `font_notice_paths`: paths already included in
  `notices` that cover those exact font files. Font redistribution requires
  review of their original copyright and license, not just the JavaScript
  package's SPDX declaration.

Example entry shape (hash placeholders are documentation only and are rejected
by the generator):

```json
{
  "schema_version": 1,
  "packages": [{
    "name": "three",
    "version": "0.170.0",
    "source": {
      "url": "https://registry.npmjs.org/three/-/three-0.170.0.tgz",
      "sha256": "<archive SHA-256>"
    },
    "files": [
      {"path": "three/three.module.min.js", "source_path": "package/build/three.module.min.js", "sha256": "<file SHA-256>"},
      {"path": "three/LICENSE", "source_path": "package/LICENSE", "sha256": "<license SHA-256>"}
    ],
    "notices": ["three/LICENSE"]
  }]
}
```

The one supported source modification is `transformation:
"three-relative-import-v1"` on Three addon entries. It changes every exact
`from 'three'` byte sequence to `from '../three.module.min.js'`. The verifier
replays that operation against the pinned source member and rejects any other
difference. Original and shipped hashes, plus the transformation name, appear
in the generated inventory. Other modifications require a reviewed verifier
change; they cannot be explained away with free-form text.

Only `README.md`, `SHA256SUMS.txt` and `manifest.json` at the vendor root are
informational files excluded from package payload coverage. Those files are not
runtime assets. Every JavaScript, CSS, font, image, map, license and other file
must be covered; links, duplicate paths, unexpected tar members and missing
notices fail closed. UI source and this manifest must be reviewed together.

The current UI plan uses KaTeX MathML output and does not redistribute its fonts
or CSS. If that changes, all added assets and applicable font notices must be
included before a release can pass inventory generation. Browser packages join
the existing Rust, WebView2, NSIS and toolchain component records; they do not
replace cargo-auditable reconciliation. Package verification checks the installed
notice bytes and detects changes to vendor source after inventory generation.

Run the bounded, network-free verifier fixtures with:
`python -I scripts/vendor_notices_test.py`. Passing those fixtures is evidence
about the verifier, not evidence that an unbuilt UI or installer is accepted.

## Tauri NSIS template adaptation for 0.3

`scripts/nsis/installer.nsi` adapts Tauri's template from tag
`tauri-cli-v2.10.1`, commit `9b17a7aeae9a83222ffe829aa4e2d8a5ba6bed8c`, path
`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`. Its original SHA-256
is `fe22026f68bdb3292fab376756035496ce0a35e3d580e06ebaa6a28295916eb3`.
The selected upstream MIT license is preserved verbatim in
`scripts/nsis/LICENSE-TAURI-MIT`, SHA-256
`9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d`, copyright
Tauri Apps Contributors. Exact source URLs and the adapted template hash are
recorded in `scripts/nsis/provenance.json` and rechecked during notice generation.

The adaptation separates the visible CodaClauda product name from the existing
ClaudaCoda installation identity, registry keys and physical directory. The
separately written `scripts/nsis/identity-hooks.nsh` guards the existing install
location and changes shortcut labels only when their targets match this product.
These source changes require an actual in-place installation test; provenance
checks alone do not establish preservation of installed state.
