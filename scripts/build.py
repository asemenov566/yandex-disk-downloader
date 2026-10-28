"""Build only the explicitly listed runtime files, never local user data."""
from pathlib import Path
import hashlib
import json
import stat
import zipfile

RUNTIME_FILES = tuple(json.loads(Path(__file__).with_name("runtime-files.json").read_text(encoding="utf-8")))
ARCHIVE_PREFIX = "yandex-disk-downloader/photo_downloader_smnv/"


def checked_path(root, relative, *, directory=False):
    """Reject links/junctions in every component before reading or writing."""
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Package paths must stay inside the project")
    current = root
    for part in relative.parts:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"Linked package path is not allowed: {relative.as_posix()}")
    if not current.resolve().is_relative_to(root.resolve()):
        raise ValueError("Package path leaves the project")
    if not (current.is_dir() if directory else current.is_file()):
        raise ValueError(f"Invalid package entry: {relative.as_posix()}")
    return current


def build(root):
    root = Path(root).resolve()
    extension_name = "photo_downloader_smnv"
    files = {name: checked_path(root, f"{extension_name}/{name}") for name in RUNTIME_FILES}
    manifest = json.loads(files["manifest.json"].read_text(encoding="utf-8-sig"))
    package = json.loads(checked_path(root, "package.json").read_text(encoding="utf-8-sig"))
    if manifest["version"] != package["version"]:
        raise ValueError("Package and extension versions differ")
    for name in [manifest["action"]["default_popup"], manifest["background"]["service_worker"],
                 *manifest["icons"].values(), *manifest["action"]["default_icon"].values()]:
        if name not in files:
            raise ValueError("Manifest asset is missing from the runtime allowlist")

    dist = root / "dist"
    dist.mkdir(exist_ok=True)
    checked_path(root, "dist", directory=True)
    archive = dist / "yandex-disk-downloader.zip"
    checksum = dist / "yandex-disk-downloader.zip.sha256"
    for path in (archive, checksum):
        if path.exists() or path.is_symlink():
            checked_path(root, path.relative_to(root))
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for name, path in sorted(files.items()):
            entry = zipfile.ZipInfo(ARCHIVE_PREFIX + name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            output.writestr(entry, path.read_bytes())
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None or set(check.namelist()) != {ARCHIVE_PREFIX + name for name in files}:
            raise ValueError("Archive validation failed")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    return archive, manifest["version"], digest


if __name__ == "__main__":
    archive, version, digest = build(Path(__file__).resolve().parent.parent)
    print(f"Built {archive.name}: {archive.stat().st_size} bytes, version {version}")
    print(f"SHA256 {digest}")
