"""Verify browser-vendor provenance without executing packages or extracting tarballs.

Called by notices.py with its bounded, cached downloader. The manifest belongs to
the UI source; this module only reads it and returns records for the common notice
inventory. See PROVENANCE.md for the schema.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import tarfile
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBER_BYTES = 16 * 1024 * 1024
LICENSE_NAME = re.compile(r"^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:$|[-_.])", re.I)
INFORMATION_FILES = {"README.md", "SHA256SUMS.txt", "manifest.json"}
FONT_SUFFIXES = {".woff", ".woff2", ".ttf", ".otf"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key in vendor provenance: " + key)
        result[key] = value
    return result


def read_json(data):
    return json.loads(data.decode("utf-8-sig"), object_pairs_hook=object_without_duplicates)


def safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or "\x00" in value:
        raise ValueError("Invalid vendor relative path")
    parts = value.split("/")
    if any(part in {"", ".", ".."} or part.endswith((".", " ")) for part in parts):
        raise ValueError("Invalid vendor relative path: " + value)
    return value


def required_hash(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Vendor provenance requires a lowercase SHA-256")
    return value


def is_link(path):
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def vendor_files(directory):
    if not directory.exists():
        return {}
    if is_link(directory) or not directory.is_dir():
        raise ValueError("Vendor directory must be an ordinary directory")
    result = {}
    folded = set()
    for path in sorted(directory.rglob("*")):
        if is_link(path):
            raise ValueError("Vendor provenance does not permit links: " + str(path))
        if path.is_dir():
            continue
        relative = safe_relative(path.relative_to(directory).as_posix())
        if not path.is_file() or relative.casefold() in folded:
            raise ValueError("Non-file or case-colliding vendor entry: " + relative)
        folded.add(relative.casefold())
        result[relative] = path
    return result


def load_manifest(root):
    directory = root / "ui/vendor"
    actual = vendor_files(directory)
    if not actual:
        return None, {}, None
    if "manifest.json" not in actual:
        raise ValueError("ui/vendor contains files but has no manifest.json provenance")
    manifest_bytes = actual["manifest.json"].read_bytes()
    manifest = read_json(manifest_bytes)
    if manifest.get("schema_version") != 1 or not isinstance(manifest.get("packages"), list) or not manifest["packages"]:
        raise ValueError("Expected nonempty vendor manifest schema_version 1")
    inputs = {"file": "ui/vendor/manifest.json", "sha256": sha(manifest_bytes)}
    return manifest, actual, inputs


def archive_members(data):
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Vendor archive exceeds the 64 MiB limit")
    archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    members = {}
    total = 0
    try:
        for index, member in enumerate(archive):
            if index >= 20000:
                raise ValueError("Vendor archive has too many members")
            if member.isdir():
                continue
            name = safe_relative(member.name)
            if not name.startswith("package/") or name in members:
                raise ValueError("Vendor archive has an unexpected or duplicate member: " + name)
            if not member.isfile() or member.size > MAX_MEMBER_BYTES:
                raise ValueError("Vendor archive contains a link or oversized member: " + name)
            total += member.size
            if total > 256 * 1024 * 1024:
                raise ValueError("Vendor archive exceeds the expanded size limit")
            members[name] = member
    except Exception:
        archive.close()
        raise
    return archive, members


def member_bytes(archive, members, name):
    safe_relative(name)
    if name not in members:
        raise ValueError("Vendor archive is missing " + name)
    stream = archive.extractfile(members[name])
    if stream is None:
        raise ValueError("Cannot read vendor archive member: " + name)
    with stream:
        data = stream.read(MAX_MEMBER_BYTES + 1)
    if len(data) > MAX_MEMBER_BYTES:
        raise ValueError("Vendor member exceeds size bound: " + name)
    return data


def transformed_bytes(data, transformation, package_name, source_path):
    if transformation is None:
        return data
    if transformation != "three-relative-import-v1" or package_name != "three" or not source_path.startswith("package/examples/jsm/"):
        raise ValueError("Unreviewed vendor transformation: " + str(transformation))
    original = b"from 'three'"
    if original not in data:
        raise ValueError("Three import transformation has no matching source import")
    return data.replace(original, b"from '../three.module.min.js'")


def collect_vendor(root, fetch_archive, save_notice):
    """Return (component records, input manifest receipt); fail closed on any gap."""
    manifest, actual, inputs = load_manifest(root)
    if manifest is None:
        return [], None
    covered = set()
    packages_seen = set()
    records = []
    notice_writes = []
    for package in manifest["packages"]:
        name, version = package.get("name", ""), package.get("version", "")
        if not re.fullmatch(r"(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+", name) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
            raise ValueError("Vendor package requires an exact npm name and version")
        if name in packages_seen:
            raise ValueError("Duplicate vendor package: " + name)
        packages_seen.add(name)
        source = package.get("source", {})
        url = f"https://registry.npmjs.org/{name}/-/{name.rsplit('/', 1)[-1]}-{version}.tgz"
        if source.get("url") != url:
            raise ValueError("Vendor source must be its exact versioned npm registry archive: " + name)
        expected_archive_hash = required_hash(source.get("sha256"))
        data = fetch_archive(url, expected_archive_hash)
        if sha(data) != expected_archive_hash:
            raise ValueError("Vendor archive checksum mismatch: " + name)
        archive, members = archive_members(data)
        with archive:
            package_json_bytes = member_bytes(archive, members, "package/package.json")
            package_json = read_json(package_json_bytes)
            if package_json.get("name") != name or package_json.get("version") != version:
                raise ValueError("Vendor package manifest identity mismatch: " + name)
            expression = package_json.get("license")
            if not isinstance(expression, str) or not expression.strip():
                raise ValueError("Vendor package lacks a declared license: " + name)
            if "license_expression" in package and package["license_expression"] != expression:
                raise ValueError("Vendor license expression differs from package.json: " + name)
            files = package.get("files")
            notices = package.get("notices")
            if not isinstance(files, list) or not files or not isinstance(notices, list) or not notices or len(set(notices)) != len(notices):
                raise ValueError("Vendor package needs files and exact notice paths: " + name)
            file_records = []
            notice_sources = set()
            found_notices = set()
            fonts = []
            pending_notices = []
            for file in files:
                relative = safe_relative(file.get("path"))
                if relative in INFORMATION_FILES or relative in covered or relative not in actual:
                    raise ValueError("Unresolved or duplicate vendor file: " + relative)
                covered.add(relative)
                vendored = actual[relative].read_bytes()
                expected_file_hash = required_hash(file.get("sha256"))
                if sha(vendored) != expected_file_hash:
                    raise ValueError("Vendored file checksum mismatch: " + relative)
                source_path = safe_relative(file.get("source_path"))
                original = member_bytes(archive, members, source_path)
                transformation = file.get("transformation")
                if transformed_bytes(original, transformation, name, source_path) != vendored:
                    raise ValueError("Vendored file differs from its declared source: " + relative)
                file_record = {"file": "ui/vendor/" + relative, "sha256": expected_file_hash,
                               "bytes": len(vendored), "source_path": source_path, "source_sha256": sha(original)}
                if transformation:
                    file_record["transformation"] = transformation
                file_records.append(file_record)
                if PurePosixPath(relative).suffix.lower() in FONT_SUFFIXES:
                    fonts.append(relative)
                if relative in notices:
                    if transformation or not vendored.strip() or not LICENSE_NAME.match(PurePosixPath(source_path).name):
                        raise ValueError("Vendor notice must retain an unchanged upstream license/notice: " + relative)
                    # The notice must be valid text; retain its exact bytes, not a rewrite.
                    vendored.decode("utf-8-sig")
                    found_notices.add(relative)
                    notice_sources.add(source_path)
                    pending_notices.append(("browser/" + relative, vendored, url + "!/" + source_path))
            if found_notices != set(notices):
                raise ValueError("Vendor notice path is not a covered file: " + name)
            required_notices = {path for path in members if LICENSE_NAME.match(PurePosixPath(path).name)
                                and (len(PurePosixPath(path).parts) == 2 or PurePosixPath(path).parts[1].lower() in {"licenses", "license"})}
            if not required_notices.issubset(notice_sources):
                raise ValueError("Vendor package omitted upstream notices: " + ", ".join(sorted(required_notices - notice_sources)))
            font_notices = package.get("font_notice_paths", [])
            if fonts and (not font_notices or not set(font_notices).issubset(found_notices)):
                raise ValueError("Vendored fonts require explicit retained font_notice_paths: " + name)
            record = {"name": name, "version": version, "component_kind": "vendored_browser_package",
                      "license_expression": expression, "source": url, "source_sha256": expected_archive_hash,
                      "manifest_sha256": sha(package_json_bytes), "executables": ["claudacoda.exe"],
                      "files": file_records, "notices": []}
            if fonts:
                record["font_files"] = fonts
                record["font_notice_paths"] = font_notices
            records.append(record)
            notice_writes.append((record, pending_notices))
    unexpected = set(actual) - covered - INFORMATION_FILES
    if unexpected:
        raise ValueError("Vendor files are missing provenance: " + ", ".join(sorted(unexpected)))
    # Only publish notice files after the entire vendor directory validates.
    for record, writes in notice_writes:
        record["notices"] = [save_notice(*item) for item in writes]
    inputs["package_count"] = len(records)
    inputs["file_count"] = len(covered)
    return records, inputs


def verify_vendor_snapshot(root, inventory):
    """Ensure the packaged inventory still describes the current vendor source."""
    manifest, actual, inputs = load_manifest(root)
    recorded = inventory.get("input_browser_vendor")
    components = [item for item in inventory["components"] if item.get("component_kind") == "vendored_browser_package"]
    if manifest is None:
        if recorded is not None or components:
            raise ValueError("Notice inventory describes absent browser vendor source")
        return
    if not recorded or recorded.get("file") != inputs["file"] or recorded.get("sha256") != inputs["sha256"]:
        raise ValueError("Browser vendor manifest changed after notice generation")
    covered = set()
    for component in components:
        for file in component["files"]:
            relative = safe_relative(file["file"])
            if not relative.startswith("ui/vendor/"):
                raise ValueError("Unexpected vendor inventory file")
            relative = relative[len("ui/vendor/"):]
            if relative in covered or relative not in actual or sha(actual[relative].read_bytes()) != file["sha256"]:
                raise ValueError("Browser vendor bytes changed after notice generation: " + relative)
            covered.add(relative)
    if set(actual) - INFORMATION_FILES != covered or len(components) != recorded["package_count"] or len(covered) != recorded["file_count"]:
        raise ValueError("Browser vendor inventory no longer covers the source")
