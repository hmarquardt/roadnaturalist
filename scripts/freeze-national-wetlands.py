#!/usr/bin/env python3
"""Pin the current FWS NWI GeoPackage archives without requiring them all on disk.

Each package is downloaded to a temporary file, validated as a ZIP, hashed, and
recorded immediately.  A later run reuses completed lock entries after checking
the remote byte length and Last-Modified value.  Use --keep to retain archives.
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
LOCK = ROOT / "data/national/nwi-state-lock.json"
DEFAULT_WORK = ROOT / "data/national-wetlands-work"
STATES = "AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split()
URL = "https://documentst.ecosphere.fws.gov/wetlands/data/State-Downloads/{state}_geopackage_wetlands.zip"


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    temporary.replace(path)


def remote_metadata(state):
    request = urllib.request.Request(URL.format(state=state), method="HEAD", headers={"User-Agent": "RoadNaturalist-NWI/1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        headers = response.headers
        return {"url": response.url, "filename": f"{state}_geopackage_wetlands.zip",
                "bytes": int(headers["Content-Length"]), "lastModified": headers.get("Last-Modified"),
                "etag": (headers.get("ETag") or "").strip('"'), "versionId": headers.get("x-amz-version-id")}


def hash_download(state, metadata, work, keep):
    sources = work / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    final = sources / metadata["filename"]
    if shutil.disk_usage(work).free < metadata["bytes"] + 2 * 1024**3:
        raise OSError(f"{state} needs its {metadata['bytes']:,}-byte ZIP plus 2 GiB of free disk headroom")
    target = final if keep else Path(tempfile.mkstemp(prefix=f"nwi-{state}-", suffix=".zip", dir=work)[1])
    digest = hashlib.sha256()
    size = 0
    started = time.monotonic()
    try:
        request = urllib.request.Request(metadata["url"], headers={"User-Agent": "RoadNaturalist-NWI/1"})
        with urllib.request.urlopen(request, timeout=300) as response, target.open("wb") as output:
            while block := response.read(4 * 1024 * 1024):
                output.write(block)
                digest.update(block)
                size += len(block)
        if size != metadata["bytes"]:
            raise ValueError(f"{state} byte length {size} != {metadata['bytes']}")
        if not zipfile.is_zipfile(target):
            raise ValueError(f"{state} response is not a ZIP archive")
        with zipfile.ZipFile(target) as archive:
            members = sorted(item.filename for item in archive.infolist() if not item.is_dir())
            gpkg = [name for name in members if name.lower().endswith(".gpkg")]
            if len(gpkg) != 1:
                raise ValueError(f"{state} expected one GeoPackage, found {gpkg}")
            uncompressed = sum(item.file_size for item in archive.infolist())
            member_bytes = archive.getinfo(gpkg[0]).file_size
        return {**metadata, "sha256": digest.hexdigest(), "member": gpkg[0],
                "uncompressedBytes": uncompressed, "memberBytes": member_bytes,
                "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "downloadSeconds": round(time.monotonic() - started, 3)}
    finally:
        if not keep and target.exists():
            target.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--states", help="comma-separated subset; default all 48 contiguous states and DC")
    parser.add_argument("--keep", action="store_true", help="retain verified archives in the ignored source cache")
    parser.add_argument("--check", action="store_true", help="verify a complete committed lock without network")
    args = parser.parse_args()
    selected = args.states.split(",") if args.states else STATES
    prior = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    packages = dict(prior.get("packages", {}))
    if args.check:
        missing = sorted(set(STATES) - packages.keys())
        invalid = [state for state in STATES if state in packages and
                   (len(packages[state].get("sha256", "")) != 64 or packages[state].get("bytes", 0) <= 0)]
        if missing or invalid:
            raise SystemExit(f"incomplete NWI lock: missing={missing}, invalid={invalid}")
        print(json.dumps({"packages": len(packages), "bytes": sum(packages[s]["bytes"] for s in STATES)}))
        return
    args.work.mkdir(parents=True, exist_ok=True)
    for state in selected:
        if state not in STATES:
            raise ValueError(f"{state} is outside the CONUS profile")
        metadata = remote_metadata(state)
        old = packages.get(state)
        if old and old.get("bytes") == metadata["bytes"] and old.get("lastModified") == metadata["lastModified"] and old.get("sha256"):
            print(f"{state}: pinned {old['sha256'][:16]} ({old['bytes']:,} bytes)", flush=True)
            continue
        packages[state] = hash_download(state, metadata, args.work, args.keep)
        result = {"schemaVersion": 1, "kind": "fws-nwi-conus-state-geopackage-lock",
                  "coverage": "48 contiguous states plus District of Columbia",
                  "packageCount": len(packages), "totalBytes": sum(entry["bytes"] for entry in packages.values()),
                  "packages": dict(sorted(packages.items()))}
        atomic_json(LOCK, result)
        print(f"{state}: pinned {packages[state]['sha256'][:16]} ({packages[state]['bytes']:,} bytes)", flush=True)


if __name__ == "__main__":
    main()
