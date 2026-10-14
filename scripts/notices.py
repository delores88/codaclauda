"""Collect exact linked dependency notices; standard library only, no Cargo run.

Inputs are cargo-auditable records extracted from the final CLI and GUI. Package
licenses come from their actual registry manifests/cache or, when omitted from
the crate archive, their immutable recorded source commit. Unresolved packages
fail closed. Output and download cache are restricted to this repository.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import re
import subprocess
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "local/release-tools/notices"
LICENSE_NAME = re.compile(r"^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:$|[-_.])", re.I)
FIRST_PARTY = {"claudacoda-cli", "claudacoda-desktop", "coord-core"}
NSIS_URL = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
NSIS_SHA256 = "c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1"
PLUGIN_COMMIT = "13d9edd27b69310e108d6fbd49f90992f8a05390"
MPL_URL = "https://www.mozilla.org/media/MPL/2.0/index.txt"
MPL_SHA256 = "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, expected=None, optional=False):
    if not url.startswith("https://"):
        raise ValueError("Notice sources require HTTPS")
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / (sha(url.encode()) + ".download")
    if cached.exists():
        data = cached.read_bytes()
    else:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ClaudaCoda-license-inventory/1"})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read(64 * 1024 * 1024 + 1)
                if response.headers.get("Content-Encoding", "").lower() == "gzip":
                    data = gzip.decompress(data)
            if len(data) > 64 * 1024 * 1024:
                raise ValueError("Notice source exceeds the 64 MiB download bound: " + url)
        except urllib.error.HTTPError as error:
            if optional and error.code == 404:
                return None
            raise
        cached.write_bytes(data)
    if expected and sha(data) != expected:
        raise ValueError("Source checksum mismatch: " + url)
    return data


def safe_part(value):
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+", value):
        raise ValueError("Unsafe inventory identifier")
    return value


class Inventory:
    def __init__(self, destination, cargo_home):
        self.destination = destination
        self.cargo_home = cargo_home
        self.records = []
        self.package_dirs = {}

    def save(self, relative, data, source):
        path = self.destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {"file": relative.replace("\\", "/"), "sha256": sha(data), "bytes": len(data), "source": source}

    def registry_package(self, name, version):
        key = (name, version)
        if key in self.package_dirs:
            return self.package_dirs[key]
        matches = []
        registry = self.cargo_home / "registry/src"
        for index in registry.iterdir() if registry.exists() else []:
            path = index / (name + "-" + version)
            if (path / "Cargo.toml").is_file():
                package = tomllib.loads((path / "Cargo.toml").read_text(encoding="utf-8"))["package"]
                if package.get("name") == name and package.get("version") == version:
                    matches.append((path, package))
        if len(matches) != 1:
            raise ValueError(f"Expected one downloaded registry source for {name} {version}, found {len(matches)}")
        self.package_dirs[key] = matches[0]
        return matches[0]

    def source_licenses(self, path, package):
        files = [file for file in path.iterdir() if file.is_file() and LICENSE_NAME.match(file.name)]
        for directory in (path / "licenses", path / "LICENSES"):
            if directory.is_dir():
                files.extend(file for file in directory.rglob("*") if file.is_file())
        declared = package.get("license-file")
        if declared:
            declared_path = (path / declared).resolve()
            if declared_path.is_file() and declared_path.is_relative_to(path.resolve()):
                files.append(declared_path)
        if files:
            return [(str(file.relative_to(path)).replace("\\", "/"), file.read_bytes(), "registry package/" + str(file.relative_to(path)).replace("\\", "/")) for file in sorted(set(files))]
        # Some Servo packages publish the MPL notice in each Rust source file
        # instead of a standalone license. Require that actual source notice
        # before using the canonical, checksum-pinned license it references.
        if package.get("license") == "MPL-2.0":
            for source in sorted(path.glob("*.rs")):
                text = source.read_text(encoding="utf-8")
                header = text.split("*/", 1)[0] + "*/\n"
                if text.startswith("/*") and "Mozilla Public" in header and "https://mozilla.org/MPL/2.0/" in header:
                    return [("LICENSE-MPL-2.0.txt", fetch(MPL_URL, MPL_SHA256), MPL_URL),
                            ("NOTICE-source.txt", header.encode("utf-8"), "registry package/" + source.name)]
        # Crate archives occasionally omit a workspace-root license. Use only
        # the immutable upstream commit recorded in that exact published crate.
        vcs_path = path / ".cargo_vcs_info.json"
        repository = package.get("repository", "")
        match = re.fullmatch(r"https://github\.com/([\w.-]+/[\w.-]+?)(?:\.git)?/?", repository)
        if not match or not vcs_path.is_file():
            raise ValueError("Package omitted license text and immutable GitHub provenance: " + path.name)
        vcs = json.loads(vcs_path.read_text())
        commit = vcs.get("git", {}).get("sha1", "")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Missing immutable source commit: " + path.name)
        candidates = ["LICENSE", "LICENSE-MIT", "LICENSE-APACHE", "LICENSE_MIT", "LICENSE_APACHE-2.0", "LICENSE.txt", "LICENSE.md", "COPYING", "UNLICENSE"]
        prefixes = [""]
        directory = PurePosixPath(vcs.get("path_in_vcs", ""))
        if str(directory) != ".":
            prefixes += [str(directory), str(directory.parent)]
        for prefix in dict.fromkeys(prefixes):
            found = []
            for filename in candidates:
                relative = str(PurePosixPath(prefix) / filename)
                url = f"https://raw.githubusercontent.com/{match[1]}/{commit}/{relative}"
                data = fetch(url, optional=True)
                if data:
                    found.append((filename, data, url))
            if found:
                return found
        raise ValueError("No exact upstream license text found: " + path.name)

    def crate(self, name, version, users):
        label = safe_part(name) + "-" + safe_part(version)
        if name in FIRST_PARTY:
            record = {"name": name, "version": version, "license_expression": "MIT", "source": "ClaudaCoda first-party source", "executables": users,
                      "notices": [self.save(f"crates/{label}/LICENSE", (ROOT / "LICENSE").read_bytes(), "repository/LICENSE")]}
        else:
            path, package = self.registry_package(name, version)
            expression = package.get("license")
            if not expression and not package.get("license-file"):
                raise ValueError("Package has no declared license: " + label)
            texts = self.source_licenses(path, package)
            record = {"name": name, "version": version, "license_expression": expression or "See declared license-file", "source": "downloaded registry package", "repository": package.get("repository"), "executables": users,
                      "notices": [self.save(f"crates/{label}/{relative}", data, source) for relative, data, source in texts]}
            record["manifest_sha256"] = sha((path / "Cargo.toml").read_bytes())
            checksum = path / ".cargo-checksum.json"
            if checksum.is_file():
                record["registry_archive_checksum"] = json.loads(checksum.read_text()).get("package")
            vcs = path / ".cargo_vcs_info.json"
            if vcs.is_file():
                record["registry_source_vcs"] = json.loads(vcs.read_text())
            if "MPL-2.0" in (expression or ""):
                # Retain the exact unmodified source archive alongside the
                # executable notices so recipients need no external service.
                archive = self.cargo_home / "registry/cache" / path.parent.name / (label + ".crate")
                data = archive.read_bytes()
                if sha(data) != record.get("registry_archive_checksum"):
                    raise ValueError("MPL source archive differs from Cargo checksum: " + label)
                source_url = f"https://static.crates.io/crates/{name}/{label}.crate"
                record["source_archive"] = self.save("sources/" + label + ".crate", data, source_url)
                record["source_notice"] = "Unmodified MPL source is included in this gzip-compressed tar archive; its existing license notices are retained."
        self.records.append(record)

    def webview_loader(self, name, version):
        path, package = self.registry_package(name, version)
        vcs = json.loads((path / ".cargo_vcs_info.json").read_text())
        commit = vcs["git"]["sha1"]
        source = f"https://raw.githubusercontent.com/wravery/webview2-rs/{commit}/crates/update-bindings/src/main.rs"
        update = fetch(source).decode()
        sdk_version = re.search(r'const WEBVIEW2_VERSION: &str = "([0-9.]+)"', update)
        if not sdk_version:
            raise ValueError("Cannot identify exact WebView2 SDK version for " + name + version)
        sdk_version = sdk_version[1]
        prefix = f"https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{sdk_version}/microsoft.web.webview2.{sdk_version}"
        archive_url = prefix + ".nupkg"
        archive = fetch(archive_url)
        registration = json.loads(fetch(f"https://api.nuget.org/v3/registration5-gz-semver2/microsoft.web.webview2/{sdk_version}.json"))
        catalog_url = registration["catalogEntry"]
        if not catalog_url.startswith("https://api.nuget.org/"):
            raise ValueError("Unexpected NuGet catalog origin")
        catalog = json.loads(fetch(catalog_url))
        if catalog.get("packageHashAlgorithm", "").upper() != "SHA512" or base64.b64encode(hashlib.sha512(archive).digest()).decode() != catalog["packageHash"]:
            raise ValueError("Official NuGet package hash mismatch")
        with zipfile.ZipFile(io.BytesIO(archive)) as sdk:
            matched = []
            for binary in ("WebView2Loader.dll", "WebView2Loader.dll.lib", "WebView2LoaderStatic.lib"):
                data = sdk.read("build/native/x64/" + binary)
                if sha(data) != sha((path / "x64" / binary).read_bytes()):
                    raise ValueError("Cached WebView2 loader differs from official SDK: " + binary)
                matched.append({"file": "x64/" + binary, "sha256": sha(data)})
            license_data = sdk.read("LICENSE.txt")
        self.records.append({"name": "Microsoft.Web.WebView2 SDK loader", "version": sdk_version, "license_expression": "Microsoft WebView2 SDK license; see exact text", "source": archive_url, "source_sha256": sha(archive), "crate": name + " " + version, "loader_files_verified": matched,
                             "notices": [self.save(f"native/webview2-{sdk_version}/LICENSE.txt", license_data, archive_url + "!/LICENSE.txt")]})

    def installer(self):
        archive = fetch(NSIS_URL, NSIS_SHA256)
        files = []
        plugin_sources = {}
        with zipfile.ZipFile(io.BytesIO(archive)) as nsis:
            for filename in nsis.namelist():
                if not filename.endswith("/") and LICENSE_NAME.match(PurePosixPath(filename).name) and not filename.endswith(".nsh"):
                    relative = str(PurePosixPath(filename).relative_to("nsis-3.11"))
                    files.append(self.save("installer/nsis-3.11/" + relative, nsis.read(filename), NSIS_URL + "!/" + filename))
                if filename.startswith("nsis-3.11/Plugins/x86-unicode/") and filename.endswith(".dll"):
                    plugin_sources[PurePosixPath(filename).name.lower()] = sha(nsis.read(filename))
        if not files:
            raise ValueError("Pinned NSIS archive did not contain license notices")
        self.records.append({"name": "NSIS", "version": "3.11", "license_expression": "See NSIS COPYING and component licenses", "source": NSIS_URL, "source_sha256": NSIS_SHA256, "notices": files, "plugin_source_hashes": plugin_sources})
        files = []
        for filename in ("LICENSE_MIT", "LICENSE_APACHE-2.0"):
            url = f"https://raw.githubusercontent.com/tauri-apps/nsis-tauri-utils/{PLUGIN_COMMIT}/{filename}"
            files.append(self.save("installer/nsis-tauri-utils-0.5.3/" + filename, fetch(url), url))
        self.records.append({"name": "nsis-tauri-utils and nsis-plugin-api", "version": "0.5.3", "license_expression": "MIT OR Apache-2.0", "source_commit": PLUGIN_COMMIT,
                             "plugin_sha256": "5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709", "notices": files,
                             "dependency_notice_reference": "Rust standard-library notices and included windows-sys/windows-link crate notices",
                             "dependency_version_scope": "Upstream source declares windows-sys 0.61.2; this upstream plugin release does not publish a Cargo.lock. Reused Windows-rs license texts do not assert an exact compiled plugin dependency version."})

    def rust(self, version):
        files = []
        for filename in ("LICENSE-MIT", "LICENSE-APACHE"):
            url = f"https://raw.githubusercontent.com/rust-lang/rust/{version}/{filename}"
            files.append(self.save("toolchain/rust-" + version + "/" + filename, fetch(url), url))
        sysroot = Path(subprocess.check_output(["rustup", "run", version, "rustc", "--print", "sysroot"], text=True).strip())
        doc = sysroot / "share/doc/rust"
        copyright_file = doc / "COPYRIGHT-library.html"
        if not copyright_file.is_file():
            raise ValueError("The exact installed Rust distribution is missing COPYRIGHT-library.html")
        files.append(self.save("toolchain/rust-" + version + "/COPYRIGHT-library.html", copyright_file.read_bytes(), "installed Rust " + version + "/share/doc/rust/COPYRIGHT-library.html"))
        for license_file in sorted((doc / "licenses").glob("*.txt")):
            files.append(self.save("toolchain/rust-" + version + "/licenses/" + license_file.name, license_file.read_bytes(), "installed Rust " + version + "/share/doc/rust/licenses/" + license_file.name))
        self.records.append({"name": "Rust standard library", "version": version, "license_expression": "MIT OR Apache-2.0, with retained per-component notices", "source": f"https://github.com/rust-lang/rust/tree/{version}/library", "notices": files})


def generate(args):
    destination = args.output.resolve()
    if destination != (ROOT / "dist/notices").resolve():
        raise ValueError("Notice output is restricted to this repository's dist/notices")
    destination.mkdir(parents=True, exist_ok=True)
    inventory = Inventory(destination, args.cargo_home.resolve())
    users = {}
    inputs = []
    for path in args.dependencies:
        data = path.read_bytes()
        inputs.append({"file": path.name, "sha256": sha(data)})
        metadata = json.loads(data)
        for package in metadata["packages"]:
            key = (package["name"], package["version"])
            users.setdefault(key, []).append(path.name.replace(".dependencies.json", ".exe"))
    for (name, version), executables in sorted(users.items()):
        inventory.crate(name, version, sorted(set(executables)))
    for name, version in sorted(users):
        if name == "webview2-com-sys":
            inventory.webview_loader(name, version)
    inventory.installer()
    inventory.rust(args.rust_version)
    # NSIS's pinned helper links these crates; require their actual license texts
    # even if the application did not otherwise use the same versions.
    for name, version in (("windows-sys", "0.61.2"), ("windows-link", "0.2.1")):
        if (name, version) not in users:
            inventory.crate(name, version, ["NSIS nsis-tauri-utils.dll"])
    introduction = inventory.save("THIRD_PARTY_NOTICES.md", (ROOT / "THIRD_PARTY_NOTICES.md").read_bytes(), "repository/THIRD_PARTY_NOTICES.md")
    record = {"schema_version": 1, "status": "complete", "input_dependencies": inputs, "linked_crates_reconciled": len(users), "component_count": len(inventory.records), "introduction": introduction, "components": inventory.records}
    (destination / "inventory.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(f"Reconciled {len(users)} linked crates; preserved {len(inventory.records)} component notice records")


def verify(args):
    source = (ROOT / "dist/notices").resolve()
    gui = list(args.extracted.rglob("claudacoda.exe"))
    if len(gui) != 1:
        raise ValueError("Expected one extracted GUI before verifying installed notices")
    installed = gui[0].parent / "notices"
    expected = sorted(path for path in source.rglob("*") if path.is_file())
    for file in expected:
        extracted = installed / file.relative_to(source)
        if not extracted.is_file() or sha(extracted.read_bytes()) != sha(file.read_bytes()):
            raise ValueError("Installed notice missing or byte mismatch: " + str(file.relative_to(source)))
    inventory = json.loads((installed / "inventory.json").read_text())
    if inventory.get("status") != "complete":
        raise ValueError("Installed notice inventory is incomplete")
    installer = next(item for item in inventory["components"] if item["name"] == "NSIS")
    expected_dlls = installer["plugin_source_hashes"] | {"nsis_tauri_utils.dll": "5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709"}
    verified_dlls = []
    for dll in args.extracted.rglob("*.dll"):
        # Only installer plugins, not unrelated application DLLs, use this table.
        if dll.name.lower() in expected_dlls:
            actual = sha(dll.read_bytes())
            if actual != expected_dlls[dll.name.lower()]:
                raise ValueError("Installer plugin differs from pinned notice source: " + dll.name)
            verified_dlls.append({"file":dll.name,"sha256":actual})
        elif any(part.lower() == "$pluginsdir" for part in dll.parts):
            raise ValueError("Installer contains a plugin without pinned notice provenance: " + dll.name)
    if args.report:
        args.report.write_text(json.dumps({"status":"passed","notice_files_verified":len(expected),"installer_plugins_verified":verified_dlls},indent=2)+"\n",encoding="utf-8")
    print(f"Verified {len(expected)} installed notice files against their generated source bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    generate_parser = commands.add_parser("generate")
    generate_parser.add_argument("--dependencies", action="append", type=Path, required=True)
    generate_parser.add_argument("--cargo-home", type=Path, required=True)
    generate_parser.add_argument("--output", type=Path, required=True)
    generate_parser.add_argument("--rust-version", required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--extracted", type=Path, required=True)
    verify_parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.operation == "generate":
        generate(args)
    else:
        verify(args)


if __name__ == "__main__":
    main()
