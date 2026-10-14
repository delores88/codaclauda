# ClaudaCoda

Read docs/DESIGN.md before implementation. This repository alone is writable.
Do not modify PhaseForge or NVIDIALink, their services, sessions, releases, or caches.
All local Cargo invocations must use the unchanged shared gate:
`python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`.
Keep CARGO_TARGET_DIR under this project's C: directory. Never reduce the gate's memory threshold.
Use bounded, independently reviewed changes and record actual acceptance separately from unit tests.
Never commit credentials, session tokens, local state, or private transcripts.
First-party source is MIT; retain third-party notices and exact provenance for any copied code.

