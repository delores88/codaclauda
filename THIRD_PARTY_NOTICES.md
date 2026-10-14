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

For a particular release, consult its installed `notices/` directory and the
published inventory/build receipt. This source document describes the process;
it is not a claim that an unbuilt source checkout has passed license inventory,
installation, or Marketplace acceptance.
