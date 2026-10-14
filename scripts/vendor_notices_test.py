"""Offline source-to-vendor reconciliation fixtures; no builds or provider jobs."""
import copy
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("vendor_notices", ROOT / "scripts/vendor_notices.py")
VENDOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VENDOR)
NOTICES_SPEC = importlib.util.spec_from_file_location("notices", ROOT / "scripts/notices.py")
NOTICES = importlib.util.module_from_spec(NOTICES_SPEC)
NOTICES_SPEC.loader.exec_module(NOTICES)


class VendorProvenanceTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "local/vendor-notices-tests"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "ui/vendor"
        self.directory.mkdir(parents=True)
        self.members = {"package/package.json": b'{"name":"three","version":"0.170.0","license":"MIT"}',
                        "package/LICENSE": b"MIT License\nCopyright Example\n", "package/build/library.js": b"export const answer = 42;\n"}
        self.manifest = {"schema_version": 1, "packages": [{"name": "three", "version": "0.170.0",
            "source": {"url": "https://registry.npmjs.org/three/-/three-0.170.0.tgz", "sha256": ""},
            "files": [], "notices": ["three/LICENSE"]}]}
        self.archives = {}
        self.saved = []
        self.add_file("three/LICENSE", "package/LICENSE")
        self.add_file("three/library.js", "package/build/library.js")

    def add_file(self, relative, source_path, transformation=None, data=None):
        data = self.members[source_path] if data is None else data
        path = self.directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        entry = {"path": relative, "source_path": source_path, "sha256": VENDOR.sha(data)}
        if transformation:
            entry["transformation"] = transformation
        self.manifest["packages"][0]["files"].append(entry)

    def write(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, data in self.members.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        data = output.getvalue()
        source = self.manifest["packages"][0]["source"]
        source["sha256"] = VENDOR.sha(data)
        self.archives[source["url"]] = data
        (self.directory / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def collect(self):
        def save(path, data, source):
            self.saved.append((path, data, source))
            return {"file": path, "sha256": VENDOR.sha(data), "bytes": len(data), "source": source}
        return VENDOR.collect_vendor(self.root, lambda url, expected: self.archives[url], save)

    def installed_notice_fixture(self):
        self.write()
        records, inputs = self.collect()
        source = self.root / "dist/notices"
        installed = self.root / "extracted/notices"
        source.mkdir(parents=True)
        installed.mkdir(parents=True)
        (installed.parent / "claudacoda.exe").write_bytes(b"fixture GUI marker, never executed")
        introduction = {"file": "THIRD_PARTY_NOTICES.md", "sha256": VENDOR.sha(b"Fixture introduction"), "bytes": len(b"Fixture introduction")}
        nsis_notice = {"file": "installer/LICENSE", "sha256": VENDOR.sha(b"Fixture NSIS license"), "bytes": len(b"Fixture NSIS license")}
        records.append({"name": "NSIS", "plugin_source_hashes": {}, "notices": [nsis_notice]})
        for root in (source, installed):
            for relative, data, _ in self.saved:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            (root / introduction["file"]).write_bytes(b"Fixture introduction")
            (root / "installer").mkdir()
            (root / nsis_notice["file"]).write_bytes(b"Fixture NSIS license")
        inventory = {"schema_version": 1, "status": "complete", "introduction": introduction,
                     "components": records, "input_browser_vendor": inputs}
        self.write_notice_inventory(source, installed, inventory)
        args = SimpleNamespace(extracted=installed.parent, report=None)
        return source, installed, inventory, args

    def write_notice_inventory(self, source, installed, inventory):
        data = json.dumps(inventory).encode()
        for root in (source, installed):
            (root / "inventory.json").write_bytes(data)

    def test_exact_source_notices_and_snapshot(self):
        self.write()
        records, inputs = self.collect()
        self.assertEqual(inputs["file_count"], 2)
        self.assertEqual(records[0]["license_expression"], "MIT")
        self.assertEqual(self.saved[0][1], self.members["package/LICENSE"])
        inventory = {"input_browser_vendor": inputs, "components": records}
        VENDOR.verify_vendor_snapshot(self.root, inventory)
        (self.directory / "three/library.js").write_bytes(b"changed after build")
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            VENDOR.verify_vendor_snapshot(self.root, inventory)

    def test_rejects_file_hash_tamper(self):
        self.write()
        (self.directory / "three/library.js").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.collect()

    def test_rejects_uninventoried_file(self):
        self.write()
        (self.directory / "unreviewed.js").write_bytes(b"bad")
        with self.assertRaisesRegex(ValueError, "missing provenance"):
            self.collect()
        self.assertEqual(self.saved, [])

    def test_rejects_missing_manifest(self):
        with self.assertRaisesRegex(ValueError, "no manifest.json"):
            self.collect()

    def test_rejects_same_hash_but_wrong_source(self):
        changed = b"locally modified, manifest hash adjusted"
        (self.directory / "three/library.js").write_bytes(changed)
        self.manifest["packages"][0]["files"][1]["sha256"] = VENDOR.sha(changed)
        self.write()
        with self.assertRaisesRegex(ValueError, "differs from its declared source"):
            self.collect()

    def test_rejects_missing_upstream_notice(self):
        self.members["package/NOTICE"] = b"Additional required attribution\n"
        self.write()
        with self.assertRaisesRegex(ValueError, "omitted upstream notices.*NOTICE"):
            self.collect()

    def test_rejects_modified_license_even_when_hash_updated(self):
        changed = b"Shortened MIT statement"
        (self.directory / "three/LICENSE").write_bytes(changed)
        self.manifest["packages"][0]["files"][0]["sha256"] = VENDOR.sha(changed)
        self.write()
        with self.assertRaisesRegex(ValueError, "differs from its declared source"):
            self.collect()

    def test_rejects_archive_tamper(self):
        self.write()
        url = self.manifest["packages"][0]["source"]["url"]
        self.archives[url] += b"tampered"
        with self.assertRaisesRegex(ValueError, "archive checksum mismatch"):
            self.collect()

    def test_rejects_wrong_package_identity(self):
        self.members["package/package.json"] = b'{"name":"different","version":"0.170.0","license":"MIT"}'
        self.write()
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.collect()

    def test_rejects_traversal(self):
        self.manifest["packages"][0]["files"][1]["path"] = "../outside.js"
        self.write()
        with self.assertRaisesRegex(ValueError, "relative path"):
            self.collect()

    def test_rejects_duplicate_file(self):
        self.manifest["packages"][0]["files"].append(copy.deepcopy(self.manifest["packages"][0]["files"][0]))
        self.write()
        with self.assertRaisesRegex(ValueError, "duplicate vendor file"):
            self.collect()

    def test_reviewed_three_transformation(self):
        self.members["package/examples/jsm/controls/OrbitControls.js"] = b"import {Controls} from 'three';\n"
        self.add_file("three/addons/OrbitControls.js", "package/examples/jsm/controls/OrbitControls.js",
                      "three-relative-import-v1", b"import {Controls} from '../three.module.min.js';\n")
        self.write()
        records, _ = self.collect()
        entry = records[0]["files"][-1]
        self.assertNotEqual(entry["sha256"], entry["source_sha256"])
        self.assertEqual(entry["transformation"], "three-relative-import-v1")

    def test_rejects_unknown_transformation(self):
        self.manifest["packages"][0]["files"][1]["transformation"] = "trust arbitrary modifications"
        self.write()
        with self.assertRaisesRegex(ValueError, "Unreviewed vendor transformation"):
            self.collect()

    def test_font_requires_explicit_notice_coverage(self):
        self.members["package/dist/font.woff2"] = b"synthetic-font-fixture"
        self.add_file("three/font.woff2", "package/dist/font.woff2")
        self.write()
        with self.assertRaisesRegex(ValueError, "font_notice_paths"):
            self.collect()
        self.manifest["packages"][0]["font_notice_paths"] = ["three/LICENSE"]
        self.write()
        records, _ = self.collect()
        self.assertEqual(records[0]["font_files"], ["three/font.woff2"])

    def test_rejects_nonregistry_archive(self):
        self.manifest["packages"][0]["source"]["url"] = "https://example.com/library.tgz"
        self.write()
        with self.assertRaisesRegex(ValueError, "exact versioned npm registry archive"):
            self.collect()

    def test_absent_vendor_directory_is_not_a_false_component(self):
        empty = self.root / "separate-checkout"
        empty.mkdir()
        records, inputs = VENDOR.collect_vendor(empty, None, None)
        self.assertEqual(records, [])
        self.assertIsNone(inputs)

    def test_manifest_change_after_generation_is_rejected(self):
        self.write()
        records, inputs = self.collect()
        (self.directory / "manifest.json").write_text(json.dumps(self.manifest, indent=2), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "manifest changed"):
            VENDOR.verify_vendor_snapshot(self.root, {"input_browser_vendor": inputs, "components": records})

    def test_package_verification_rejects_notice_removed_before_bundle(self):
        source, installed, _, args = self.installed_notice_fixture()
        with patch.object(NOTICES, "ROOT", self.root):
            NOTICES.verify(args)
            # The original bug accepted this because both directory listings
            # agreed after deletion. The inventory remains the required-file list.
            for root in (source, installed):
                (root / "browser/three/LICENSE").unlink()
            with self.assertRaisesRegex(ValueError, "Required notice missing.*browser/three/LICENSE"):
                NOTICES.verify(args)

    def test_package_verification_rejects_matching_but_corrupt_notice_copies(self):
        source, installed, _, args = self.installed_notice_fixture()
        for root in (source, installed):
            (root / "browser/three/LICENSE").write_bytes(b"both copies truncated")
        with patch.object(NOTICES, "ROOT", self.root), self.assertRaisesRegex(ValueError, "differs from inventory"):
            NOTICES.verify(args)

    def test_package_verification_rejects_descriptor_traversal(self):
        source, installed, inventory, args = self.installed_notice_fixture()
        inventory["components"][0]["notices"][0]["file"] = "../outside/LICENSE"
        self.write_notice_inventory(source, installed, inventory)
        with patch.object(NOTICES, "ROOT", self.root), self.assertRaisesRegex(ValueError, "relative path"):
            NOTICES.verify(args)

    def test_package_verification_rejects_missing_retained_source_archive(self):
        source, installed, inventory, args = self.installed_notice_fixture()
        inventory["components"][0]["source_archive"] = {"file": "sources/required.crate", "sha256": "0" * 64, "bytes": 10}
        self.write_notice_inventory(source, installed, inventory)
        with patch.object(NOTICES, "ROOT", self.root), self.assertRaisesRegex(ValueError, "Required notice missing.*sources/required.crate"):
            NOTICES.verify(args)

    def test_package_verification_rejects_missing_introduction(self):
        source, installed, _, args = self.installed_notice_fixture()
        for root in (source, installed):
            (root / "THIRD_PARTY_NOTICES.md").unlink()
        with patch.object(NOTICES, "ROOT", self.root), self.assertRaisesRegex(ValueError, "Required notice missing.*THIRD_PARTY_NOTICES"):
            NOTICES.verify(args)


if __name__ == "__main__":
    unittest.main()
