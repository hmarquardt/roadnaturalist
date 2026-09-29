#!/usr/bin/env python3
"""Pin legacy NHD High Resolution HU8 staged GDB archives without requiring them all on disk.

Each unit is downloaded to a temporary file, validated as a ZIP, hashed, and recorded immediately: source unit
id, URL, bytes, SHA-256, Last-Modified, ETag, ZIP members with their uncompressed sizes, and the unit name taken
from the staged metadata XML. A later run reuses a completed entry only when the remote byte length and
Last-Modified value still agree, so a republished source is detected rather than silently trusted.

The national CONUS set is 2,166 units / 23.65 GB compressed (measured from the bucket listing; the full
inventory is committed as data/national/nhd-hr-hu8-inventory.json). Pinning every unit is a deliberate
large-machine step: this tool pins whatever subset a build actually needs, and the inventory records exactly
what is left. Use --keep to retain verified archives in the source cache.
"""
import argparse
import hashlib
import json
import shutil
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "data/national/nhd-hr-hu8-lock.json"
DEFAULT_WORK = ROOT / "data/national-hydro-work"
BASE = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Hydrography/NHD/HU8/GDB/"
AGENT = "RoadNaturalist-NHD/1"
# HUC2 regions of the CONUS profile (01-18). Alaska (19), Hawaii/Pacific (20), the Caribbean (21) and the
# Pacific territories (22) are outside the project's coverage.
CONUS_REGIONS = {f"{code:02d}" for code in range(1, 19)}


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    temporary.replace(path)


def filename(unit):
    return f"NHD_H_{unit}_HU8_GDB.zip"


def remote_metadata(unit):
    request = urllib.request.Request(BASE + filename(unit), method="HEAD", headers={"User-Agent": AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        headers = response.headers
        return {"url": response.url, "filename": filename(unit), "bytes": int(headers["Content-Length"]),
                "lastModified": headers.get("Last-Modified"), "etag": (headers.get("ETag") or "").strip('"'),
                "versionId": headers.get("x-amz-version-id")}


def unit_name(archive, unit):
    """The staged metadata XML carries the basin name; it is worth recording, never guessing."""
    candidate = f"NHD_H_{unit}_HU8_GDB.xml"
    if candidate not in archive.namelist():
        return None
    text = archive.read(candidate).decode("utf-8", "replace")
    for tag in ("gname", "title", "supplinf"):
        start = text.find(f"<{tag}>")
        if start != -1:
            value = " ".join(text[start + len(tag) + 2:text.find(f"</{tag}>", start)].split())
            if value:
                return value[:120]
    return None


def hash_download(unit, metadata, work, keep):
    sources = work / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    final = sources / metadata["filename"]
    if shutil.disk_usage(work).free < metadata["bytes"] + 2 * 1024**3:
        raise OSError(f"{unit} needs its {metadata['bytes']:,}-byte ZIP plus 2 GiB of free disk headroom")
    target = final if keep else Path(tempfile.mkstemp(prefix=f"nhd-{unit}-", suffix=".zip", dir=work)[1])
    digest = hashlib.sha256()
    size = 0
    started = time.monotonic()
    try:
        request = urllib.request.Request(metadata["url"], headers={"User-Agent": AGENT})
        with urllib.request.urlopen(request, timeout=600) as response, target.open("wb") as output:
            while block := response.read(4 * 1024 * 1024):
                output.write(block)
                digest.update(block)
                size += len(block)
        if size != metadata["bytes"]:
            raise ValueError(f"{unit} byte length {size} != {metadata['bytes']}")
        if not zipfile.is_zipfile(target):
            raise ValueError(f"{unit} response is not a ZIP archive")
        with zipfile.ZipFile(target) as archive:
            members = sorted(item.filename for item in archive.infolist() if not item.is_dir())
            gdb = sorted({name.split("/")[0] for name in members if name.endswith(".gdb/")})
            uncompressed = sum(item.file_size for item in archive.infolist())
            return {**metadata, "unit": unit, "region": unit[:2], "name": unit_name(archive, unit),
                    "sha256": digest.hexdigest(), "members": len(members), "uncompressedBytes": uncompressed,
                    "gdb": gdb[0] if gdb else None,
                    "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "downloadSeconds": round(time.monotonic() - started, 3)}
    finally:
        if not keep and target.exists():
            target.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--units", help="comma-separated HUC8 units; default: every unit already in the lock")
    parser.add_argument("--keep", action="store_true", help="retain verified archives in the ignored source cache")
    parser.add_argument("--check", action="store_true", help="verify the committed lock offline (no network)")
    args = parser.parse_args()
    prior = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    units = dict(prior.get("units", {}))
    if args.check:
        invalid = [unit for unit, entry in units.items()
                   if len(entry.get("sha256", "")) != 64 or entry.get("bytes", 0) <= 0
                   or entry.get("region") not in CONUS_REGIONS]
        if invalid or not units:
            raise SystemExit(f"invalid NHD lock entries: {invalid}; units={len(units)}")
        print(json.dumps({"units": len(units), "bytes": sum(entry["bytes"] for entry in units.values()),
                          "regions": sorted({entry["region"] for entry in units.values()})}))
        return
    selected = args.units.split(",") if args.units else sorted(units)
    if not selected:
        raise SystemExit("nothing to pin: pass --units")
    args.work.mkdir(parents=True, exist_ok=True)
    for unit in selected:
        if len(unit) != 8 or unit[:2] not in CONUS_REGIONS:
            raise ValueError(f"{unit} is outside the CONUS HUC8 profile")
        metadata = remote_metadata(unit)
        old = units.get(unit)
        if (old and old.get("bytes") == metadata["bytes"] and old.get("lastModified") == metadata["lastModified"]
                and old.get("sha256")):
            print(f"{unit}: pinned {old['sha256'][:16]} ({old['bytes']:,} bytes)", flush=True)
            continue
        units[unit] = hash_download(unit, metadata, args.work, args.keep)
        atomic_json(LOCK, {"schemaVersion": 1, "kind": "usgs-nhd-hr-hu8-staged-lock",
                           "dataset": "National Hydrography Dataset (NHD) High Resolution - HU8 staged extract",
                           "base": BASE, "coverage": "CONUS HUC2 regions 01-18",
                           "unitCount": len(units), "totalBytes": sum(entry["bytes"] for entry in units.values()),
                           "units": dict(sorted(units.items()))})
        print(f"{unit}: pinned {units[unit]['sha256'][:16]} ({units[unit]['bytes']:,} bytes) {units[unit].get('name')}",
              flush=True)


if __name__ == "__main__":
    main()
