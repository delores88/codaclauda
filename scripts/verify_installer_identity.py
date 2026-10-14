"""Verify the renamed installer's compatibility inputs without building or running it."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tomllib


ROOT = Path(__file__).resolve().parent.parent
UPSTREAM_SHA256 = "fe22026f68bdb3292fab376756035496ce0a35e3d580e06ebaa6a28295916eb3"
LICENSE_SHA256 = "9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def verify() -> dict:
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    require(config["productName"] == "CodaClauda", "Unexpected display product name")
    require(config["identifier"] == "com.deloresai.claudacoda", "Persistent Windows application identity changed")
    require(all(w["title"] == "CodaClauda" for w in config["app"]["windows"]), "Window display name differs")
    require(config.get("mainBinaryName", "claudacoda") == "claudacoda", "Main executable path changed")
    nsis = config["bundle"]["windows"]["nsis"]
    require(nsis["installMode"] == "currentUser", "Per-user installation mode changed")
    require(nsis["template"] == "../scripts/nsis/installer.nsi", "Compatibility template is not configured")
    require(nsis["installerHooks"] == "../scripts/nsis/identity-hooks.nsh", "Compatibility hooks are not configured")
    require(nsis["startMenuFolder"] == "DeloresAI", "Shipped Start menu location changed")
    require(config["bundle"]["resources"].get("../dist/bin/") == "bin/", "Bundled CLI directory changed")
    for relative, expected in [("src-tauri/Cargo.toml", "claudacoda"), ("crates/coord-cli/Cargo.toml", "claudacoda-cli")]:
        package = tomllib.loads((ROOT / relative).read_text(encoding="utf-8"))
        binaries = [b["name"] for b in package.get("bin", [])]
        if not binaries and package["package"].get("autobins", True) and (ROOT / relative).parent.joinpath("src/main.rs").is_file():
            binaries.append(package["package"]["name"])
        require(expected in binaries, f"Executable identity changed: {relative}")

    template_path = ROOT / "scripts/nsis/installer.nsi"
    template = template_path.read_text(encoding="utf-8")
    # Reconstruct the exact upstream file. Any extra template modification must
    # be reviewed and added here instead of silently drifting with a CLI update.
    added = ('; CodaClauda display name; immutable 0.1/0.2 installation identity. See provenance.json.\n'
             '!define INSTALLIDENTITY "ClaudaCoda"\n')
    require(template.count(added) == 1, "Stable installation identity definition is missing or duplicated")
    restored = template.replace(added, "")
    lifecycle_additions = [
        "; Preserve the prior root even when the old uninstaller removes its registry key.\nVar CodaClaudaPreviousInstallRoot\n",
        "  !insertmacro CODACLAUDA_CAPTURE_INSTALL_ROOT\n\n",
        "  ; Reject conflicting /D overrides before the old uninstaller can run.\n  !insertmacro CODACLAUDA_REQUIRE_EXISTING_INSTALL_ROOT\n",
    ]
    for addition in lifecycle_additions:
        require(restored.count(addition) == 1, "Prior install-root lifecycle guard is missing or duplicated")
        restored = restored.replace(addition, "")
    on_init = template[template.index("Function .onInit"):template.index("Section EarlyChecks")]
    require(on_init.index("SetContext") < on_init.index("CODACLAUDA_CAPTURE_INSTALL_ROOT") < on_init.index("Call RestorePreviousInstallLocation") < on_init.index("CODACLAUDA_REQUIRE_EXISTING_INSTALL_ROOT"), "Prior install root must be captured and validated before installer pages run")
    hooks = (ROOT / "scripts/nsis/identity-hooks.nsh").read_text(encoding="utf-8")
    preinstall = hooks.split("!macro NSIS_HOOK_PREINSTALL\n", 1)[1].split("!macroend", 1)[0]
    require("CODACLAUDA_REQUIRE_EXISTING_INSTALL_ROOT" in preinstall and "ReadRegStr" not in preinstall, "Preinstall must validate the captured root, not a registry key the old uninstaller can remove")
    guard = hooks.split("!macro CODACLAUDA_REQUIRE_EXISTING_INSTALL_ROOT\n", 1)[1].split("!macroend", 1)[0]
    require('GetFullPathName $R8 "$INSTDIR"' in guard and "$R8 != $CodaClaudaPreviousInstallRoot" in guard, "Relocation guard must compare normalized paths against the startup snapshot")
    require(restored.count("${INSTALLIDENTITY}") == 10, "Unexpected compatibility template edit count")
    restored = restored.replace("${INSTALLIDENTITY}", "${PRODUCTNAME}")
    require(hashlib.sha256(restored.encode()).hexdigest() == UPSTREAM_SHA256, "Template has changes outside the reviewed identity split")
    provenance = json.loads((ROOT / "scripts/nsis/provenance.json").read_text(encoding="utf-8"))
    require(provenance["upstream_sha256"] == UPSTREAM_SHA256, "Upstream template hash changed")
    require(provenance["local_sha256"] == hashlib.sha256(template_path.read_bytes()).hexdigest(), "Modified template provenance hash differs")
    require(hashlib.sha256((ROOT / "scripts/nsis/LICENSE-TAURI-MIT").read_bytes()).hexdigest() == LICENSE_SHA256, "Upstream license bytes changed")
    return {
        "result": "passed",
        "display_name": config["productName"],
        "install_identity": "ClaudaCoda",
        "application_identifier": config["identifier"],
        "cli_relative_path": "bin/claudacoda-cli.exe",
        "upstream_template_sha256": UPSTREAM_SHA256,
        "template_sha256": provenance["local_sha256"],
        "installed_upgrade_acceptance": "not performed by this source check",
    }


if __name__ == "__main__":
    print(json.dumps(verify(), indent=2))
