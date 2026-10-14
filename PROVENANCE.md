# Source and license provenance

Ben Van Dorn's owner-authored build brief supplied on 2026-10-13 explicitly
authorizes reuse of his first-party code in ClaudaCoda and Spark Dev Bridge
under MIT, naming Ben Van Dorn / DeloresAI. It requires preserving attribution,
recording exact reused files/revisions, leaving PhaseForge unchanged, and
preserving third-party licenses. This authorization does not relicense third-party code.

ClaudaCoda's coordination engine and interface are independently written.
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
ClaudaCoda implements these patterns independently; no code or artwork from
those files was copied. DGXBridge's repository remains unchanged.

Dependencies retain their own licenses. Release preparation must generate
the locked dependency inventory and notices for both CLI and GUI.

## Native updater source reuse

Source: `delores88/nvidialink`, commit
`7ad8d49bb7a635ab36044e426cad5195a847f733`, copyright Ben Van Dorn / DeloresAI,
MIT. Original bytes were read from Git and checked against the handoff hashes
before adaptation. ClaudaCoda changes product identity, the board/settings
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
ClaudaCoda needs its own tests and actual installation/update evidence.
