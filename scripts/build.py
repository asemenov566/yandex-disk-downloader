"""Build the installable ZIP using Python's standard library only."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
extension = root / "photo_downloader_smnv"
manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8-sig"))
package = json.loads((root / "package.json").read_text(encoding="utf-8-sig"))
assert manifest["version"] == package["version"], "Package and extension versions differ"
for filename in [manifest["action"]["default_popup"], manifest["background"]["service_worker"],
                 *manifest["icons"].values(), *manifest["action"]["default_icon"].values()]:
    assert (extension / filename).is_file(), f"Missing manifest asset: {filename}"

files = sorted(path for path in extension.rglob("*") if path.is_file())
assert not any(path.suffix.lower() == ".md" for path in files), "Documentation belongs outside extension"
dist = root / "dist"
dist.mkdir(exist_ok=True)
archive = dist / "yandex-disk-downloader.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for path in sorted(files):
        assert not path.is_symlink(), f"Symlink is not allowed: {path}"
        name = "yandex-disk-downloader/" + path.relative_to(root).as_posix()
        entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        output.writestr(entry, path.read_bytes())
with zipfile.ZipFile(archive) as check:
    assert check.testzip() is None, "Archive CRC validation failed"
    assert "yandex-disk-downloader/photo_downloader_smnv/manifest.json" in check.namelist()
    assert all(name.startswith("yandex-disk-downloader/photo_downloader_smnv/") for name in check.namelist())
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(dist / "yandex-disk-downloader.zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
print(f"Built {archive.name}: {archive.stat().st_size} bytes, version {manifest['version']}")
print(f"SHA256 {digest}")
