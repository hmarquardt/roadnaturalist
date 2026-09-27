#!/usr/bin/env python3
"""Build the regional place-name gazetteer that discovery can search by name.

Source: the pinned U.S. Census Bureau **2025 Gazetteer Files - Places** national file, the same Census
vintage the pinned TIGER/Line 2025 road geometry comes from. Places are the Census Bureau's own legal and
statistical places (incorporated cities and towns, and census-designated places) with their published
interior point, name, state, and 7-digit place GEOID.

    python3 scripts/build-places.py --download      # fetch the pinned archive, then build
    python3 scripts/build-places.py --archive /path/2025_Gaz_place_national.zip
    python3 scripts/build-places.py --check         # re-derive from the cached archive and compare bytes
    python3 scripts/build-places.py --verify-artifacts   # offline: check the committed artifact and report

The artifact answers one bounded product question - "I know the place I want to explore, but I do not know
its coordinates" - and nothing else. It is not a geocoder: it holds no addresses, no streets, no landmarks,
no streams or peaks, and it never leaves the two states it declares. Matching happens in the browser
(``src/discovery/place-gazetteer.js``); this script only reduces a pinned national file to the tiny regional
list, deterministically.

Scope is the published regional coverage plus a margin wide enough for the largest search this build offers
(50 statute miles), derived with the same constants the browser's radius arithmetic uses. A place whose
centre is outside the published region is deliberately kept: its 50-mile disk can still reach published
coverage, and the interface reports the PARTIAL or NONE answer rather than hiding the place.

Only the fields the product uses are kept: the source id, the published name with its class suffix removed,
the state, the state name, the place class, and the published interior point rounded to five decimal places
(about a metre, and the precision the search definition itself keeps). Population, aliases and county are
not in this source and are not invented.
"""
import argparse
import hashlib
import json
import math
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_PATH = ROOT / "data" / "places" / "or-sw-wa-portland-places.json"
REPORT_PATH = ROOT / "data" / "places" / "build-or-sw-wa-portland-places.json"
SEARCH_AREAS_PATH = ROOT / "data" / "discovery" / "search-areas.json"

KIND = "road-discovery-place-gazetteer"
SCHEMA_VERSION = 1
ARTIFACT_VERSION = "census-2025-gaz-place-v1"
PIPELINE_VERSION = "place-gazetteer-v1"

SOURCE_AGENCY = "U.S. Census Bureau"
SOURCE_DATASET = "2025 Gazetteer Files - Places (national)"
SOURCE_VINTAGE = "2025"
SOURCE_URL = ("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
              "2025_Gazetteer/2025_Gaz_place_national.zip")
SOURCE_ARCHIVE_BYTES = 1214053
SOURCE_ARCHIVE_SHA256 = "49644173a453469d9bd77fb7a493b027f87567e209edaf2078aac7543ac2ee29"
SOURCE_MEMBER = "2025_Gaz_place_national.txt"
SOURCE_MEMBER_BYTES = 3288984
SOURCE_MEMBER_SHA256 = "15f4977a010cc42308f4d5ddc5e19f26ef63fc035f20745333a14b78aa08d3fa"
SOURCE_PUBLICATION_DATE = "2025-09-10"
SOURCE_FILE_DATE = "2025-09-08"
SOURCE_DOCS = "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html"
SOURCE_LICENSE = "Public domain (U.S. Government work)"
SOURCE_CRS = "NAD83 (EPSG:4269) decimal degrees, carried as EPSG:4326 as every other dataset here is"

# The two states the published region covers, with the state names the interface shows. The build fails
# closed on any other state, so this table can never silently grow into a national gazetteer.
INCLUDED_STATES = {"OR": "Oregon", "WA": "Washington"}
# LSAD code -> the class the artifact stores. The suffix mapping is the published NAME suffix each code
# implies, and every kept row must carry exactly that suffix: the build refuses to guess a class.
LSAD_CLASSES = {"25": "city", "43": "town", "57": "cdp"}
LSAD_NAME_SUFFIX = {"25": " city", "43": " town", "57": " CDP"}
# FUNCSTAT: A = active legal entity (incorporated city or town), S = statistical entity (CDP).
CLASS_FUNCSTAT = {"city": "A", "town": "A", "cdp": "S"}
MIN_PLACES = 300  # a truncated source is a failure, not a smaller gazetteer

# The same constants src/discovery/search-area.js uses, so this window is the one the browser's own radius
# arithmetic implies. A test re-derives the box in Node from the artifact's declared region and margin.
MARGIN_MILES = 50  # the largest radius the interface offers (src/discovery/search-definition.js)
METRES_PER_MILE = 1609.344
METRES_PER_DEGREE_LAT = 110540
METRES_PER_DEGREE_LON = 111320
COORDINATE_DECIMALS = 5  # the precision the search definition keeps, and about a metre


def sha256_bytes(payload):
    return hashlib.sha256(payload).hexdigest()


def read_published_region():
    """The published regional bounds, read from the declaration the interface itself uses."""
    declaration = json.loads(SEARCH_AREAS_PATH.read_text())
    region = declaration.get("publishedRegion") or {}
    bounds = region.get("bounds")
    if not (isinstance(bounds, list) and len(bounds) == 4
            and all(isinstance(value, (int, float)) for value in bounds)):
        raise ValueError("the search-area declaration carries no published region")
    return region, [float(value) for value in bounds]


def expanded_bounds(region):
    """The gazetteer window: the published region plus a 50-mile margin on every side.

    The latitude margin is the metres-per-degree conversion directly. The longitude margin is evaluated at
    the box's most poleward latitude - the widest degree span 50 miles can require anywhere in the box - so
    the rectangle is a sure outer bound on the places a 50-mile search can reach.
    """
    lat_margin = MARGIN_MILES * METRES_PER_MILE / METRES_PER_DEGREE_LAT
    lat_min, lat_max = region[1] - lat_margin, region[3] + lat_margin
    max_abs_lat = max(abs(lat_min), abs(lat_max))
    cos_lat = math.cos(math.radians(max_abs_lat))
    lon_margin = MARGIN_MILES * METRES_PER_MILE / (METRES_PER_DEGREE_LON * cos_lat)
    bounds = [region[0] - lon_margin, lat_min, region[2] + lon_margin, lat_max]
    derivation = {"marginMiles": MARGIN_MILES, "latMarginDeg": lat_margin, "lonMarginDeg": lon_margin,
                  "longitudeMarginReferenceLat": max_abs_lat, "cosineAtReferenceLat": cos_lat}
    return bounds, derivation


def distance_to_region_m(latitude, longitude, region):
    """Metres from a point to the published region rectangle.

    Measured in the same local frame the browser's radius arithmetic uses - metres per degree of latitude,
    and metres per degree of longitude at the point's own latitude - so "within 50 miles of the region" here
    means the same thing as a 50-mile search reaching published coverage there.
    """
    lon_gap = max(region[0] - longitude, 0.0, longitude - region[2])
    lat_gap = max(region[1] - latitude, 0.0, latitude - region[3])
    return math.hypot(lon_gap * METRES_PER_DEGREE_LON * math.cos(math.radians(latitude)),
                      lat_gap * METRES_PER_DEGREE_LAT)


def source_archive(supplied, cache, download):
    """Return a verified local copy of the pinned archive, downloading it only when asked."""
    path = Path(supplied) if supplied else Path(cache) / Path(SOURCE_URL).name
    if path.exists():
        if sha256_bytes(path.read_bytes()) != SOURCE_ARCHIVE_SHA256:
            raise ValueError(f"{path} does not match the pinned archive digest; remove it and download again")
        return path
    if not download:
        raise FileNotFoundError(f"{path} is missing; pass --archive or --download")
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(SOURCE_URL) as response, path.open("wb") as handle:
        handle.write(response.read())
    payload = path.read_bytes()
    if len(payload) != SOURCE_ARCHIVE_BYTES or sha256_bytes(payload) != SOURCE_ARCHIVE_SHA256:
        path.unlink(missing_ok=True)
        raise ValueError("downloaded archive does not match the pinned digest")
    return path


def read_source_rows(archive):
    """The published place rows, verified by member digest before a single row is used."""
    with zipfile.ZipFile(archive) as bundle:
        member = bundle.read(SOURCE_MEMBER)
    if len(member) != SOURCE_MEMBER_BYTES or sha256_bytes(member) != SOURCE_MEMBER_SHA256:
        raise ValueError(f"{SOURCE_MEMBER} does not match its pinned digest")
    header, _, body = member.decode("utf-8").partition("\n")
    columns = header.rstrip("\n").split("|")
    rows = [dict(zip(columns, line.split("|"))) for line in body.splitlines() if line.strip()]
    if not rows or not {"USPS", "GEOID", "NAME", "LSAD", "FUNCSTAT", "INTPTLAT", "INTPTLONG"}.issubset(rows[0]):
        raise ValueError(f"{SOURCE_MEMBER} is missing expected columns")
    return rows


def place_row(row, region, bounds, state_fips):
    """One published row as an artifact place, or a refusal that names why it was left out."""
    state = row["USPS"]
    if state not in INCLUDED_STATES:
        return None, "state"
    latitude, longitude = float(row["INTPTLAT"]), float(row["INTPTLONG"])
    if not (bounds[0] <= longitude <= bounds[2] and bounds[1] <= latitude <= bounds[3]):
        return None, "outside-window"
    # The rectangle is a sure outer bound; the rule is the distance. A place whose own 50-mile search cannot
    # reach published coverage can never return a corridor, so it is not offered as a search centre at all.
    if distance_to_region_m(latitude, longitude, region) > MARGIN_MILES * METRES_PER_MILE:
        return None, "beyond-margin"
    lsad = row["LSAD"]
    if lsad not in LSAD_CLASSES:
        raise ValueError(f"unknown LSAD {lsad} for {row['NAME']} ({row['GEOID']})")
    feature_class, suffix, name = LSAD_CLASSES[lsad], LSAD_NAME_SUFFIX[lsad], row["NAME"]
    if not name.endswith(suffix):
        raise ValueError(f"{name} ({row['GEOID']}) does not carry the '{suffix.strip()}' suffix LSAD {lsad} implies")
    name = name[:-len(suffix)]
    if not name:
        raise ValueError(f"{row['NAME']} ({row['GEOID']}) is empty once its class suffix is removed")
    if row["FUNCSTAT"] != CLASS_FUNCSTAT[feature_class]:
        raise ValueError(f"{row['NAME']} ({row['GEOID']}) has FUNCSTAT {row['FUNCSTAT']}, expected "
                         f"{CLASS_FUNCSTAT[feature_class]} for a {feature_class}")
    geoid = row["GEOID"]
    if len(geoid) != 7 or not geoid.isdigit():
        raise ValueError(f"{row['NAME']} has a malformed GEOID: {geoid!r}")
    if state in state_fips and state_fips[state] != geoid[:2]:
        raise ValueError(f"{row['NAME']} ({geoid}) does not match {state}'s established FIPS prefix {state_fips[state]}")
    state_fips.setdefault(state, geoid[:2])
    return {"id": geoid, "name": name, "state": state, "stateName": INCLUDED_STATES[state],
            "featureClass": feature_class,
            "center": [round(longitude, COORDINATE_DECIMALS), round(latitude, COORDINATE_DECIMALS)]}, None


def sort_key(place):
    return (place["name"].casefold(), place["state"], place["id"])


def build_document(archive, region, region_bounds, bounds, derivation):
    """The artifact document plus the tally the build report records."""
    state_fips, places, skipped = {}, [], Counter()
    for row in read_source_rows(archive):
        place, reason = place_row(row, region_bounds, bounds, state_fips)
        if reason:
            skipped[reason] += 1
            continue
        places.append(place)
    if len(places) < MIN_PLACES:
        raise ValueError(f"only {len(places)} places extracted; the source looks truncated")
    if len({place["id"] for place in places}) != len(places):
        raise ValueError("duplicate place ids in the extraction")
    if sorted(state_fips) != sorted(INCLUDED_STATES) or len(set(state_fips.values())) != len(state_fips):
        raise ValueError(f"the extraction does not cover both declared states distinctly: {state_fips}")
    places.sort(key=sort_key)
    by_state = Counter(place["state"] for place in places)
    by_class = Counter(place["featureClass"] for place in places)
    document = {
        "kind": KIND, "schemaVersion": SCHEMA_VERSION, "version": ARTIFACT_VERSION,
        "note": ("Named places in the published regional coverage and a 50-mile margin around it, reduced "
                 "from the pinned U.S. Census Bureau Gazetteer file. A place here is a search centre only: it "
                 "is not a road, not an access finding, and not evidence about any corridor."),
        "source": {"agency": SOURCE_AGENCY, "dataset": SOURCE_DATASET, "vintage": SOURCE_VINTAGE,
                   "url": SOURCE_URL, "archiveBytes": SOURCE_ARCHIVE_BYTES, "archiveSha256": SOURCE_ARCHIVE_SHA256,
                   "member": SOURCE_MEMBER, "memberBytes": SOURCE_MEMBER_BYTES, "memberSha256": SOURCE_MEMBER_SHA256,
                   "publicationDate": SOURCE_PUBLICATION_DATE, "sourceFileDate": SOURCE_FILE_DATE,
                   "documentationUrl": SOURCE_DOCS, "license": SOURCE_LICENSE,
                   "coordinateReferenceSystem": SOURCE_CRS},
        "scope": {"kind": "published region plus a 50-mile search margin",
                  "publishedRegion": {"id": region.get("id"), "name": region.get("name"), "bounds": region_bounds},
                  "marginMiles": MARGIN_MILES, "bounds": bounds, "derivation": derivation,
                  "inclusion": ("Kept when the place lies inside the window rectangle AND its own distance to the "
                                "published region is within the margin, so every place here can reach published "
                                "coverage with a search of at most 50 miles."),
                  "includedStates": dict(INCLUDED_STATES),
                  "includedFeatureClasses": {code: LSAD_CLASSES[code] for code in sorted(LSAD_CLASSES)},
                  "counts": {"places": len(places), "byState": dict(sorted(by_state.items())),
                             "byClass": dict(sorted(by_class.items()))}},
        "build": {"pipelineVersion": PIPELINE_VERSION, "method": (
            "Read the pinned national place gazetteer; keep only the declared states and only places whose "
            "published interior point lies inside the published region expanded by the 50-mile margin; require "
            "the published NAME suffix to match the row's LSAD class and FUNCSTAT to match that class's status; "
            "strip the class suffix from the name; keep the GEOID as the place id; round the published interior "
            "point to five decimal places; sort by name, state and id."),
            "excludedFields": ["population", "aliases", "county", "land and water area"],
            "notes": ["Matching is case-, punctuation- and whitespace-insensitive and happens in the browser.",
                      "The artifact carries no normalized or precomputed query keys: the browser derives them.",
                      "Coordinates are the published interior point, not a road, entrance or parking location."]},
        "places": places,
    }
    tally = {"skipped": dict(sorted(skipped.items())), "stateFips": dict(sorted(state_fips.items())),
             "byState": dict(sorted(by_state.items())), "byClass": dict(sorted(by_class.items())),
             "places": len(places)}
    return document, tally


def render_artifact(document):
    """The artifact bytes: a readable header, then one place per line so a change is reviewable."""
    head = {key: value for key, value in document.items() if key != "places"}
    head_text = json.dumps(head, indent=2, ensure_ascii=False)
    if not head_text.endswith("\n}"):
        raise ValueError("unexpected artifact header shape")
    lines = ["  " + json.dumps(place, ensure_ascii=False, separators=(", ", ": ")) for place in document["places"]]
    return (head_text[:-2].rstrip("\n") + ',\n  "places": [\n' + ",\n".join(lines) + "\n  ]\n}\n").encode("utf-8")


def build_report(document, payload, tally, artifact_relative):
    """The committed build report: what was read, what was kept, and the artifact's own digest."""
    return {
        "kind": "road-discovery-place-gazetteer-build", "pipelineVersion": PIPELINE_VERSION,
        "builtAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "artifact": {"path": artifact_relative, "bytes": len(payload), "sha256": sha256_bytes(payload),
                     "places": len(document["places"])},
        "source": document["source"],
        "scope": {"bounds": document["scope"]["bounds"], "marginMiles": document["scope"]["marginMiles"],
                  "derivation": document["scope"]["derivation"], "counts": document["scope"]["counts"]},
        "extraction": {"places": tally["places"], "stateFips": tally["stateFips"], "byState": tally["byState"],
                       "byClass": tally["byClass"], "skipped": tally["skipped"]},
        "artifactVersion": ARTIFACT_VERSION, "schemaVersion": SCHEMA_VERSION,
    }


# Places the browser tests and the product examples rely on. A source refresh that drops or renames one of
# them is a failure here rather than a surprise in a browser run.
TESTED_PLACES = [("4134100", "Hillsboro", "OR"), ("4177250", "Vernonia", "OR"),
                 ("4164600", "St. Helens", "OR"), ("4174000", "Toledo", "OR"), ("5371785", "Toledo", "WA"),
                 ("4124250", "Fairview", "OR"), ("4124300", "Fairview", "OR"),
                 ("5311475", "Chehalis", "WA"), ("5347175", "Morton", "WA"), ("5356170", "Prairie Ridge", "WA")]


def verify_artifacts():
    """Offline check of the committed artifact and report: no source archive and no network needed."""
    problems = []
    if not ARTIFACT_PATH.exists():
        print(f"FAIL: {ARTIFACT_PATH} is missing")
        return 1
    payload = ARTIFACT_PATH.read_bytes()
    document = json.loads(payload)
    region_bounds = read_published_region()[1]
    bounds, derivation = expanded_bounds(region_bounds)
    if (document.get("kind"), document.get("schemaVersion"), document.get("version")) != \
            (KIND, SCHEMA_VERSION, ARTIFACT_VERSION):
        problems.append("artifact kind, schema version or artifact version is not the one this build declares")
    source = document.get("source") or {}
    for key, expected in (("archiveSha256", SOURCE_ARCHIVE_SHA256), ("memberSha256", SOURCE_MEMBER_SHA256),
                          ("license", SOURCE_LICENSE), ("url", SOURCE_URL)):
        if source.get(key) != expected:
            problems.append(f"artifact source.{key} is not the pinned value")
    scope = document.get("scope") or {}
    if scope.get("marginMiles") != MARGIN_MILES:
        problems.append("artifact margin is not the declared search margin")
    if not (isinstance(scope.get("bounds"), list) and len(scope["bounds"]) == 4
            and all(abs(scope["bounds"][index] - bounds[index]) < 1e-9 for index in range(4))):
        problems.append("artifact window does not match the published region plus its declared margin")
    for key in ("latMarginDeg", "lonMarginDeg"):
        if abs((scope.get("derivation") or {}).get(key, 0) - derivation[key]) > 1e-9:
            problems.append(f"artifact margin derivation disagrees about {key}")
    places = document.get("places")
    if not isinstance(places, list) or len(places) < MIN_PLACES:
        problems.append("artifact does not carry a plausible place list")
        places = []
    ids, verified, by_state, by_class = set(), set(), Counter(), Counter()
    for place in places:
        geoid, name = place.get("id", ""), place.get("name", "")
        if len(geoid) != 7 or not geoid.isdigit():
            problems.append(f"place id is not a 7-digit GEOID: {geoid!r}")
        if geoid in ids:
            problems.append(f"duplicate place id: {geoid}")
        ids.add(geoid)
        if not name or name != name.strip():
            problems.append(f"place {geoid} has an unusable name: {name!r}")
        if any(name.endswith(suffix) for suffix in LSAD_NAME_SUFFIX.values()):
            problems.append(f"place {geoid} still carries a class suffix: {name!r}")
        if place.get("state") not in INCLUDED_STATES:
            problems.append(f"place {geoid} is in an undeclared state: {place.get('state')!r}")
        elif place.get("stateName") != INCLUDED_STATES[place["state"]]:
            problems.append(f"place {geoid} names its state inconsistently")
        if place.get("featureClass") not in CLASS_FUNCSTAT:
            problems.append(f"place {geoid} has an unsupported class: {place.get('featureClass')!r}")
        center = place.get("center")
        if not (isinstance(center, list) and len(center) == 2
                and all(isinstance(value, (int, float)) for value in center)):
            problems.append(f"place {geoid} has no usable centre")
            continue
        if not (bounds[0] <= center[0] <= bounds[2] and bounds[1] <= center[1] <= bounds[3]):
            problems.append(f"place {geoid} lies outside the declared window")
        for value in center:
            if len(str(abs(value)).split(".")[-1]) > COORDINATE_DECIMALS:
                problems.append(f"place {geoid} carries more precision than the artifact declares")
        verified.add((geoid, name, place.get("state")))
        by_state[place["state"]] += 1
        by_class[place["featureClass"]] += 1
    for entry in TESTED_PLACES:
        if entry not in verified:
            problems.append(f"the artifact no longer carries the tested place {entry}")
    counts = scope.get("counts") or {}
    if counts.get("places") != len(places) or counts.get("byState") != dict(sorted(by_state.items())) \
            or counts.get("byClass") != dict(sorted(by_class.items())):
        problems.append("the artifact's declared counts do not match its place list")
    if not REPORT_PATH.exists():
        problems.append(f"{REPORT_PATH} is missing")
    else:
        report = json.loads(REPORT_PATH.read_text())
        if (report.get("artifact") or {}).get("sha256") != sha256_bytes(payload):
            problems.append("the build report's artifact digest does not match the committed artifact")
        if (report.get("artifact") or {}).get("bytes") != len(payload):
            problems.append("the build report's artifact byte count does not match the committed artifact")
        if (report.get("source") or {}).get("archiveSha256") != SOURCE_ARCHIVE_SHA256:
            problems.append("the build report's source digest is not the pinned one")
    print(f"{ARTIFACT_PATH.relative_to(ROOT)}: {len(places)} places, {len(payload):,} bytes, "
          f"SHA-256 {sha256_bytes(payload)}")
    print(f"window {[round(value, 6) for value in bounds]}, classes {dict(sorted(by_class.items()))}, "
          f"states {dict(sorted(by_state.items()))}")
    if problems:
        print("FAIL:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("OK: the committed place gazetteer matches its declared source, window, classes and counts")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", type=Path, help="pre-downloaded gazetteer ZIP matching the pinned digest")
    parser.add_argument("--cache", type=Path, default=Path("/tmp/roadnaturalist-place-sources"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--check", action="store_true",
                        help="re-derive from the archive and compare the bytes with the committed artifact")
    parser.add_argument("--verify-artifacts", action="store_true",
                        help="offline check of the committed artifact and its report")
    args = parser.parse_args()
    if args.verify_artifacts:
        return verify_artifacts()

    region, region_bounds = read_published_region()
    bounds, derivation = expanded_bounds(region_bounds)
    archive = source_archive(args.archive, args.cache, args.download)
    document, tally = build_document(archive, region, region_bounds, bounds, derivation)
    payload = render_artifact(document)

    artifact_relative = str(ARTIFACT_PATH.relative_to(ROOT))
    print(f"window {[round(value, 6) for value in bounds]}")
    print(f"  published region {region_bounds} plus {derivation['latMarginDeg']:.6f} deg latitude and "
          f"{derivation['lonMarginDeg']:.6f} deg longitude ({MARGIN_MILES} mi, evaluated at "
          f"{derivation['longitudeMarginReferenceLat']:.4f} deg north)")
    print(f"extraction: {tally['places']} places ({tally['byState']}), classes {tally['byClass']}, "
          f"skipped {tally['skipped'] or '{}'}, state FIPS {tally['stateFips']}")

    if args.check:
        if not ARTIFACT_PATH.exists():
            print(f"CHECK FAILED: {artifact_relative} is missing")
            return 1
        committed = ARTIFACT_PATH.read_bytes()
        if committed == payload:
            print(f"CHECK OK: {artifact_relative} is exactly what the pinned source and this code produce "
                  f"({len(payload):,} bytes, SHA-256 {sha256_bytes(payload)})")
            return 0
        print(f"CHECK FAILED: {artifact_relative} is stale ({len(committed):,} committed bytes vs "
              f"{len(payload):,} derived)")
        return 1

    ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ARTIFACT_PATH.write_bytes(payload)
    REPORT_PATH.write_text(json.dumps(build_report(document, payload, tally, artifact_relative), indent=2) + "\n")
    print(f"{artifact_relative}: {len(payload):,} bytes, {len(document['places'])} places, "
          f"SHA-256 {sha256_bytes(payload)}")
    print(f"{REPORT_PATH.relative_to(ROOT)}: written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
