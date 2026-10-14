# Source and license provenance

Ben Van Dorn's owner-authored build brief supplied on 2026-10-13 explicitly
authorizes reuse of his first-party code in CodaClauda and Spark Dev Bridge
under MIT, naming Ben Van Dorn / DeloresAI. It requires preserving attribution,
recording exact reused files/revisions, leaving PhaseForge unchanged, and
preserving third-party licenses. This authorization does not relicense third-party code.

CodaClauda currently uses independently written first-party implementation.
No PhaseForge, Spark Link, or Spark Dev Bridge module has been copied.
Read-only design references: NVIDIALink at observed HEAD
86c95438a114af4c8649e1121d79f3dc43826f04, docs/DESIGN.md, docs/CLI.md,
crates/sparkdev/src/mcp.rs, src-tauri/tauri.conf.json. Other inspected files
were untracked active work; they are not attributed to that commit or reused.

Dependencies retain their own licenses. Release preparation must generate
the locked dependency inventory and notices for both CLI and GUI.
