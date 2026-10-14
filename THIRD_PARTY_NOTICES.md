# CodaClauda third-party notices

CodaClauda's original application source and artwork are MIT licensed. Its
dependencies retain their own licenses; this statement does not relicense them.

Every distributable installer must contain `notices/inventory.json` and the
corresponding exact license and copyright texts. `scripts/notices.py` reconciles
both executables' embedded cargo-auditable dependency records with the downloaded
registry package manifests and license files. Missing text or an unresolved
package stops packaging. The inventory records declared license expressions,
source provenance, affected executables, and notice file hashes. An SPDX
expression alone is not a replacement for the actual license text.

Vendored browser libraries are reconciled separately from Rust dependencies.
`scripts/vendor_notices.py` verifies `ui/vendor/manifest.json` against exact,
checksum-pinned npm archives, checks every shipped file against its declared
archive member, and adds their records to the same `notices/inventory.json`.
Exact upstream license and copyright files are installed under `notices/browser/`.
Missing provenance, modified license text, unlisted vendor files or an
unreviewed source transformation stops packaging. A declared package license
does not replace additional license or NOTICE files in its archive.

The 0.3 browser inventory is intended to include three.js, marked, DOMPurify,
KaTeX and highlight.js. Exact shipped versions and hashes come from the release's
verified manifest, not this list. DOMPurify retains its complete dual-license
text. The planned MathML-only KaTeX integration ships no fonts or CSS; adding
fonts requires explicit font provenance and retained notices before packaging.

For MPL 2.0 components, the exact unmodified registry source archives are also
included under `notices/sources/` as `.crate` files (gzip-compressed tar archives).
Their source remains governed by its original license. The inventory records
each archive's source URL and Cargo-verified checksum. Source headers referring
to Mozilla's canonical MPL 2.0 text are retained with that complete license.

The generated notices also cover the Rust standard library/toolchain, the
Microsoft WebView2 SDK loader code (separately from the MIT Rust bindings), and
the NSIS installer plus Tauri's NSIS plugin. WebView2 SDK loader files are checked
against their exact official NuGet package; its SDK license is retained. The
existing Microsoft Edge WebView2 runtime is a separate prerequisite and is not
downloaded or redistributed by this installer.

The NSIS source archive and Tauri plugin source are pinned to the versions used
by the packaging CLI. Their license and copyright notices remain separate from
the application's MIT license. Build-only utilities such as cargo-auditable,
the Tauri CLI, and the project-local 7-Zip extractor are recorded in the build
receipt and are not shipped as application payload.

The custom installer template adapts Tauri's MIT-licensed NSIS template.
`scripts/nsis/provenance.json` pins its upstream revision and original hash,
the reviewed adapted hash and the exact upstream license bytes. Its attribution
and provenance are included under `notices/installer/tauri-template/`. The
separately authored installer hooks retain this repository's MIT license.

For a particular release, consult its installed `notices/` directory and the
published inventory/build receipt. This source document describes the process;
it is not a claim that an unbuilt source checkout has passed license inventory,
installation, or Marketplace acceptance.
