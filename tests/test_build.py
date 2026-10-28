"""Packaging checks use only a disposable, synthetic project."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("build", Path(__file__).resolve().parents[1] / "scripts/build.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="downloader-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.extension = self.root / "photo_downloader_smnv"
        for name in packaging.RUNTIME_FILES:
            path = self.extension / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic fixture", encoding="utf-8")
        manifest = {"version": "1.0.0", "action": {"default_popup": "app.html", "default_icon": {"16": "icons/icon-16.png"}},
                    "background": {"service_worker": "background.js"}, "icons": {"128": "icons/icon-128.png"}}
        (self.extension / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (self.root / "package.json").write_text(json.dumps({"version": "1.0.0"}), encoding="utf-8")

    def test_only_runtime_files_are_packaged(self):
        for name in ("downloader-state.json", "downloader-dates.json", "config.local.json", ".env",
                     "capture.har", "capture.png", "download.log", "profile/Default/Cookies", ".git/config", "extra.js"):
            path = self.extension / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("private synthetic sentinel", encoding="utf-8")
        archive, _, _ = packaging.build(self.root)
        with zipfile.ZipFile(archive) as result:
            self.assertEqual(set(result.namelist()), {packaging.ARCHIVE_PREFIX + name for name in packaging.RUNTIME_FILES})
            self.assertTrue(all(b"private synthetic sentinel" not in result.read(name) for name in result.namelist()))

    def test_missing_runtime_file_fails_before_packaging(self):
        (self.extension / "app.js").unlink()
        with self.assertRaises(FileNotFoundError):
            packaging.build(self.root)
        self.assertFalse((self.root / "dist").exists())

    def test_manifest_cannot_add_unlisted_file(self):
        path = self.extension / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["action"]["default_popup"] = "capture.html"
        path.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            packaging.build(self.root)

    def test_symlinked_asset_is_rejected(self):
        path = self.extension / "app.js"
        path.unlink()
        try:
            path.symlink_to(self.extension / "core.js")
        except OSError:
            self.skipTest("Creating symlinks is unavailable on this system")
        with self.assertRaises(ValueError):
            packaging.build(self.root)

    def test_symlinked_directory_is_rejected(self):
        original = self.extension / "icons"
        replacement = self.root / "icons"
        original.rename(replacement)
        try:
            original.symlink_to(replacement, target_is_directory=True)
        except OSError:
            self.skipTest("Creating symlinks is unavailable on this system")
        with self.assertRaises(ValueError):
            packaging.build(self.root)


if __name__ == "__main__":
    unittest.main()
