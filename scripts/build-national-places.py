#!/usr/bin/env python3
"""Build the national place-name gazetteer discovery searches against.

    python3 scripts/build-national-places.py --download     # fetch the pinned sources, then build
    python3 scripts/build-national-places.py                # build from the cache
    python3 scripts/build-national-places.py --measure      # build in memory and print sizes and counts
    python3 scripts/build-national-places.py --check        # re-derive and compare with the committed artifacts
    python3 scripts/build-national-places.py --verify-artifacts

The gazetteer answers one product question - "where is the place I typed?" - and nothing else. It is not a
geocoder: it holds no street addresses, no live geocoding, no consumer mapping data. Every source is an
authoritative U.S. Government product in the public domain, pinned by digest, and the reduction is
deterministic: the same pinned sources and the same code always produce the same bytes.

Two tiers, because they have different jobs and different sizes:

  * ``national-places.json`` - the core tier, loaded with the workspace: populated places, counties, and named
    federal protected areas. This is what an ordinary place query matches.
  * ``national-places-extended.json`` - the extended tier, loaded on demand: ZIP Code Tabulation Areas and the
    GNIS communities a Census place file does not carry. It is fetched the first time a query is a postal code
    or the core tier finds nothing, so the common case never pays for it.
"""
import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path(os.environ.get("ROADNATURALIST_BUILD_VOLUME", "/Volumes/Lexar/roadnaturalist")) / "work" / "places-sources"
CORE_PATH = ROOT / "data" / "places" / "national-places.json"
ZIP_PATH = ROOT / "data" / "places" / "national-places-zip.json"
COMMUNITY_PATH = ROOT / "data" / "places" / "national-places-communities.json"
FIXTURE_PATH = ROOT / "data" / "places" / "place-normalization-fixture.json"
REPORT_PATH = ROOT / "data" / "places" / "build-national-places.json"

KIND = "road-discovery-place-gazetteer"   # the artifact family; the schema version names the shape
SCHEMA_VERSION = 2
ARTIFACT_VERSION = "national-places-v1"
PIPELINE_VERSION = "national-place-gazetteer-v1"
# The longest published name in the sources is a wildlife refuge at 80 characters; the reader's bound is 96.
MAX_NAME_LENGTH = 96

# The schema every row follows, in this order. `state`, `county`, `type` and `source` are indices into the
# artifact's own dictionaries, so a row is ten small values rather than ten spelled-out strings.
COLUMNS = ("id", "name", "state", "county", "lat", "lon", "type", "population", "prominence", "source")

# The conterminous states plus the District of Columbia: the coverage the national derived corridor-metrics
# plane actually has. A place outside it could never return a corridor at any radius, so it is not offered and
# the search says why (see the artifact's `scope.note`).
CONUS = ("AL", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
         "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
         "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY")

# The place classes this build keeps, by the Census Bureau's own LSAD code, with the label the interface shows
# and the suffix the published name carries. Villages and boroughs are incorporated places too; leaving them out
# would silently drop 7,431 conterminous places.
PLACE_CLASSES = {"25": ("city", "city"), "43": ("town", "town"), "47": ("village", "village"),
                 "21": ("borough", "borough"), "57": ("cdp", "CDP")}
# Consolidated city-county governments are incorporated places too, and they carry the household names a person
# actually types (Nashville, Louisville, Indianapolis, Lexington, Juneau-style "city and borough" forms, and the
# Pennsylvania municipalities). By LSAD, with the class this build gives them and the suffix rule below.
CONSOLIDATED_CLASSES = {"00": "city", "UG": "city", "CG": "city", "UC": "city", "MG": "city", "CN": "municipality",
                        "37": "municipality"}
# The tail of a consolidated government's published name is the *county's* half of it, or a word describing the
# legal form. A person types the city, so a documented reduction is applied and the Census GEOID stays as the
# source id. "Carson City" is deliberately untouched: "City" is part of that city's own name.
CONSOLIDATED_TAILS = (" metropolitan government", " metro government", " unified government",
                      " consolidated government", " urban county", " municipality", " corporation")

STATE_FIPS = {"01": "AL", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
              "12": "FL", "13": "GA", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
              "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO",
              "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC",
              "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
              "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
              "56": "WY", "72": "PR"}
STATE_NAMES = {"AL": "Alabama", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
               "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida",
               "GA": "Georgia", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
               "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts",
               "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
               "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
               "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
               "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
               "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
               "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
               "PR": "Puerto Rico", "AK": "Alaska", "HI": "Hawaii"}

# Named federal areas worth searching for by name. The source also carries generic polygons ("Land"), military
# installations and Indian reservations; those are deliberately not part of a *place-name* search in this build.
FEDERAL_FEATURES = {
    "National Park": "national-park", "National Monument": "national-monument",
    "National Historic Park": "national-historic-park", "National Historic Site": "national-historic-site",
    "National Battlefield": "national-battlefield", "National Battlefield Park": "national-battlefield",
    "National Military Park": "national-military-park", "National Memorial": "national-memorial",
    "National Seashore": "national-seashore", "National Lakeshore": "national-lakeshore",
    "National Recreation Area": "national-recreation-area", "National Preserve": "national-preserve",
    "National Parkway": "national-parkway", "National Scenic Trail": "national-scenic-trail",
    "Wild and Scenic River": "wild-and-scenic-river", "National Scenic River": "national-scenic-river",
    "National Forest": "national-forest", "National Grassland": "national-grassland",
    "National Wilderness Area": "national-wilderness", "National Conservation Area": "national-conservation-area",
    "National Wildlife Refuge": "national-wildlife-refuge",
    "Wildlife Management Area": "wildlife-management-area",
    "Waterfowl Production Area": "waterfowl-production-area", "Research Natural Area": "research-natural-area",
    "Coordinated Area": "coordinated-area",
}


GAZ = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer"

# Every source, pinned by digest. A build that cannot verify a source refuses to run rather than publishing a
# gazetteer nobody can reproduce.
SOURCES = {
    "places": {"agency": "U.S. Census Bureau", "dataset": "2025 Gazetteer Files - Places (national)",
               "vintage": "2025", "url": f"{GAZ}/2025_Gaz_place_national.zip",
               "bytes": 1214053, "sha256": "49644173a453469d9bd77fb7a493b027f87567e209edaf2078aac7543ac2ee29",
               "member": "2025_Gaz_place_national.txt", "memberBytes": 3288984,
               "memberSha256": "15f4977a010cc42308f4d5ddc5e19f26ef63fc035f20745333a14b78aa08d3fa",
               "publicationDate": "2025-09-10", "rows": 32350, "updateCadence": "annual",
               "license": "Public domain (U.S. Government work)",
               "documentationUrl": "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html",
               "usage": "incorporated places and census-designated places: name, class, interior point"},
    "counties": {"agency": "U.S. Census Bureau", "dataset": "2025 Gazetteer Files - Counties (national)",
                 "vintage": "2025", "url": f"{GAZ}/2025_Gaz_counties_national.zip",
                 "bytes": 138993, "sha256": "4c90d0f805779923b5958ab13d0c1e9b99fe4932b786bfcf75dd739bb2dcb4ea",
                 "member": "2025_Gaz_counties_national.txt", "memberBytes": 332830,
                 "memberSha256": "1914f0d83243362de83b8ddd298c213b1768d63d62d19464743289abd8bb35b1",
                 "publicationDate": "2025-09-10", "rows": 3222, "updateCadence": "annual",
                 "license": "Public domain (U.S. Government work)",
                 "documentationUrl": "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html",
                 "usage": "counties and parishes: name, state, interior point"},
    "zcta": {"agency": "U.S. Census Bureau",
             "dataset": "2025 Gazetteer Files - ZIP Code Tabulation Areas (national)", "vintage": "2025",
             "url": f"{GAZ}/2025_Gaz_zcta_national.zip",
             "bytes": 952026, "sha256": "51516a4283bab5cd2376eec75609ddc4b363a18297e8adeeaac7b03cf7c84dbe",
             "member": "2025_Gaz_zcta_national.txt", "memberBytes": 2369685,
             "memberSha256": "100e70311af1655406d939a930f183559c902b57e1f20e714b43ef4776f6ac3d",
             "publicationDate": "2025-09-10", "rows": 33791, "updateCadence": "annual",
             "license": "Public domain (U.S. Government work)",
             "documentationUrl": "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html",
             "usage": "ZIP Code Tabulation Areas: five-digit code and interior point"},
    "zctaCounty": {"agency": "U.S. Census Bureau",
                   "dataset": "2020 ZCTA to County relationship (national)", "vintage": "2020",
                   "url": "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
                   "bytes": 6821287, "sha256": "3ed41278d637dc249e0323306f68be8a6c234e3090f4de88ef328dee71aeaaaf",
                   "member": None, "publicationDate": "2023-01-01", "rows": 47864, "updateCadence": "decennial",
                   "license": "Public domain (U.S. Government work)",
                   "documentationUrl": "https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.html",
                   "usage": "the state and county each ZCTA falls in, so a postal code can be disambiguated"},

    "placePopulation": {"agency": "U.S. Census Bureau",
                        "dataset": "City and Town Population Totals: 2020-2024 (sub-est2024)", "vintage": "2024",
                        "url": "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv",
                        "bytes": 7087080, "sha256": "af9cd4835c93552a2161fc88bf4d7aa31e81b4f16f7457980b95295cf91e49e9",
                        "member": None, "publicationDate": "2025-05-15", "rows": 81334, "updateCadence": "annual",
                        "license": "Public domain (U.S. Government work)",
                        "documentationUrl": "https://www.census.gov/data/tables/time-series/demo/popest/2020s-total-cities-and-towns.html",
                        "usage": "2024 population estimates for populated places: the prominence signal ranking uses"},
    "countyPopulation": {"agency": "U.S. Census Bureau",
                         "dataset": "County Population Totals: 2020-2024 (co-est2024-alldata)", "vintage": "2024",
                         "url": "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv",
                         "bytes": 1769182, "sha256": "abcc8720d669e793bbfdcd440eeec37a78db3b452adbe4ccd1eadf7c72b522b9",
                         "member": None, "publicationDate": "2025-05-15", "rows": 3194, "updateCadence": "annual",
                         "license": "Public domain (U.S. Government work)",
                         "documentationUrl": "https://www.census.gov/data/tables/time-series/demo/popest/2020s-counties-total.html",
                         "usage": "2024 population estimates for counties: the prominence signal ranking uses"},
    "federalLands": {"agency": "U.S. Geological Survey",
                     "dataset": "Federal Lands of the United States, 1:1,000,000 (fedlanp010g)", "vintage": "1:1M",
                     "url": "https://prd-tnm.s3.amazonaws.com/StagedProducts/Small-scale/data/Boundaries/fedlanp010g.shp_nt00966.tar.gz",
                     "cacheName": "fedlanp010g.tar.gz",
                     "bytes": 42936235, "sha256": "24cac91767920465b331ee8c9fd8a04bbae5114971dd97dd31e725e0419b449a",
                     "member": "fedlanp010g.shp", "memberBytes": 58055408,
                     "memberSha256": "a727b9c81c714ddaf113d5967cf94b88e4804257e54a3d01716984d8c84b9c63",
                     "companionMember": "fedlanp010g.dbf", "companionBytes": 11409154,
                     "companionSha256": "6258ff253c6505ac0f934f2d4bcc3d60f412b4d3c3038e5d76b017a2eb0cd8d7",
                     "publicationDate": "2025-11-01", "rows": 6656, "updateCadence": "irregular",
                     "license": "Public domain (U.S. Government work)",
                     "documentationUrl": "https://prd-tnm.s3.amazonaws.com/index.html?prefix=StagedProducts/Small-scale/data/Boundaries/",
                     "usage": "named national parks, forests, grasslands, refuges, wilderness and similar areas"},
    "gnis": {"agency": "U.S. Geological Survey",
             "dataset": "Geographic Names Information System - Domestic Names (national)", "vintage": "2026-09-29",
             "url": "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_National_Text.zip",
             "bytes": 45985727, "sha256": "180651b9fba01e65fc65182fb61de5be73bf6f42082a1b9b82cca2f74d3c16e9",
             "member": "Text/DomesticNames_National.txt", "memberBytes": 147541961,
             "memberSha256": "933d1c59d5533a371b9d7fafc9ec623288f9cf899579b8ae7e519be571d359c7",
             "publicationDate": "2026-09-29", "rows": 981708, "updateCadence": "continuous",
             "license": "Public domain (U.S. Government work)",
             "documentationUrl": "https://www.usgs.gov/tools/geographic-names-information-system-gnis",
             "usage": "populated places a Census place file does not carry, with their county"},
}


# ---------------------------------------------------------------- source access

def sha256_bytes(payload):
    return hashlib.sha256(payload).hexdigest()


def source_path(key):
    source = SOURCES[key]
    return BUILD / (source.get("cacheName") or Path(source["url"]).name)


def source_bytes(key, download=False):
    """The pinned source's bytes, verified against the digest, or a refusal. Never a guess at a vintage."""
    source = SOURCES[key]
    path = source_path(key)
    if not path.exists():
        if not download:
            raise SystemExit(f"missing source {path}; run with --download")
        BUILD.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(source["url"], path)
    payload = path.read_bytes()
    if len(payload) != source["bytes"] or sha256_bytes(payload) != source["sha256"]:
        raise SystemExit(f"{path} is not the pinned {key} source (digest mismatch)")
    return payload


def zip_member(key, download=False):
    source = SOURCES[key]
    with zipfile.ZipFile(io.BytesIO(source_bytes(key, download))) as archive:
        member = archive.read(source["member"])
    if len(member) != source["memberBytes"] or sha256_bytes(member) != source["memberSha256"]:
        raise SystemExit(f"{key}: {source['member']} is not the pinned member (digest mismatch)")
    return member


def delimited(payload, delimiter, encoding="utf-8-sig"):
    text = payload.decode(encoding, "replace")
    lines = [line.rstrip("\r") for line in text.split("\n") if line.strip()]
    header = lines[0].split(delimiter)
    return [dict(zip(header, line.split(delimiter))) for line in lines[1:]]


def rounded(value, places=5):
    return round(float(value), places)


# ---------------------------------------------------------------- readers

def reduced_consolidated_name(name):
    """"Nashville-Davidson metropolitan government (balance)" is Nashville. Deterministic, and documented: drop
    the balance marker, drop one legal-form tail, drop a trailing class word *only* when the name carried that
    balance marker, then take the part before "/", "," or "-". "Carson City" has no marker, so its own name
    survives untouched."""
    trimmed = name.strip()
    balanced = trimmed.endswith(" (balance)")
    if balanced:
        trimmed = trimmed[: -len(" (balance)")].rstrip()
    lowered = trimmed.lower()
    for tail in CONSOLIDATED_TAILS:
        if lowered.endswith(tail):
            trimmed = trimmed[: -len(tail)].rstrip()
            break
    if balanced:
        for word in (" city", " town", " village", " borough"):
            if trimmed.lower().endswith(word):
                trimmed = trimmed[: -len(word)].rstrip()
                break
    for separator in ("/", ","):
        if separator in trimmed:
            return trimmed.split(separator)[0].strip()
    return trimmed.split("-")[0].strip() if "-" in trimmed else trimmed


def read_places(download):
    """Populated places: incorporated places, census-designated places and consolidated city-county governments,
    with the published class suffix removed. A row whose name does not carry the suffix its own LSAD implies, or
    whose functional status contradicts its class, is skipped rather than guessed at."""
    out, skipped = [], Counter()
    for row in delimited(zip_member("places", download), "|"):
        state, lsad, name = row["USPS"].strip(), row["LSAD"].strip(), row["NAME"].strip()
        if state not in CONUS:
            skipped["outside"] += 1
            continue
        status = row["FUNCSTAT"].strip()
        if lsad in PLACE_CLASSES:
            if status != ("S" if lsad == "57" else "A"):
                skipped["status"] += 1
                continue
            kind, suffix = PLACE_CLASSES[lsad]
            if not name.lower().endswith(" " + suffix.lower()):
                skipped["suffix"] += 1
                continue
            display = name[: -(len(suffix) + 1)].strip()
        elif lsad in CONSOLIDATED_CLASSES:
            if status not in ("A", "F"):
                skipped["status"] += 1
                continue
            kind, display = CONSOLIDATED_CLASSES[lsad], reduced_consolidated_name(name)
        else:
            skipped["class"] += 1
            continue
        if not display:
            skipped["name"] += 1
            continue
        out.append({"id": f"P:{row['GEOID'].strip()}", "name": display, "state": state, "type": kind,
                    "lat": rounded(row["INTPTLAT"]), "lon": rounded(row["INTPTLONG"]),
                    "sourceId": row["GEOID"].strip()})
    return out, skipped


def read_populations(download):
    """2024 population estimates for populated places, and the county each place lies in.

    The file lists a place once per county part it occupies (SUMLEV 157), with the county code, and once again
    with no county at all (SUMLEV 162). Only the 157 rows are used: they carry the county, and summing them gives
    the place's own total without counting it twice. The county a place is *named* with is the one holding its
    largest part, chosen deterministically. Census-designated places are not in this file at all and keep no
    county."""
    parts = defaultdict(list)
    for row in delimited(source_bytes("placePopulation", download), ",", "cp1252"):
        if row["SUMLEV"] != "157":
            continue
        state = STATE_FIPS.get(row["STATE"].strip())
        if state is None or state not in CONUS:
            continue
        try:
            value = int(row["POPESTIMATE2024"])
        except (TypeError, ValueError):
            value = 0
        parts[(state, row["PLACE"].strip())].append((f"{row['STATE'].strip()}{row['COUNTY'].strip()}", value))
    out = {}
    for key, entries in parts.items():
        primary, value = max(entries, key=lambda item: (item[1], item[0]))
        out[key] = {"population": sum(part for _county, part in entries), "county": primary, "largestPart": value}
    return out


def read_county_populations(download):
    out = {}
    for row in delimited(source_bytes("countyPopulation", download), ",", "cp1252"):
        if row["SUMLEV"] != "050":
            continue
        try:
            out[f"{row['STATE'].strip()}{row['COUNTY'].strip()}"] = int(row["POPESTIMATE2024"])
        except (TypeError, ValueError):
            continue
    return out
def read_counties(download):
    out = []
    for row in delimited(zip_member("counties", download), "|"):
        state = row["USPS"].strip()
        if state not in CONUS:
            continue
        out.append({"id": f"C:{row['GEOID'].strip()}", "name": row["NAME"].strip(), "state": state, "type": "county",
                    "lat": rounded(row["INTPTLAT"]), "lon": rounded(row["INTPTLONG"]), "sourceId": row["GEOID"].strip()})
    return out


def read_zctas(download):
    """ZIP Code Tabulation Areas, each with the state and county it falls in, from the Census relationship file.
    The relationship file gives one row per ZCTA/county overlap, so the county holding the largest land part is
    the one the interface names - a deterministic choice, not a guess."""
    centroids = {row["GEOID"].strip(): (rounded(row["INTPTLAT"]), rounded(row["INTPTLONG"]))
                 for row in delimited(zip_member("zcta", download), "|")}
    largest = {}
    for row in delimited(source_bytes("zctaCounty", download), "|"):
        code = (row.get("GEOID_ZCTA5_20") or "").strip()
        county = (row.get("GEOID_COUNTY_20") or "").strip()
        if not code or not county:
            continue
        try:
            part = int(row.get("AREALAND_PART") or 0)
        except ValueError:
            part = 0
        if code not in largest or part > largest[code][1]:
            largest[code] = (county, part, (row.get("NAMELSAD_COUNTY_20") or "").strip() or None)
    out = []
    for code, (county, _part, county_name) in largest.items():
        state = STATE_FIPS.get(county[:2])
        if state not in CONUS or code not in centroids:
            continue
        lat, lon = centroids[code]
        out.append({"id": f"Z:{code}", "name": code, "state": state, "type": "zip", "county": county_name,
                    "lat": lat, "lon": lon, "sourceId": code})
    return out


def read_federal_lands(download):
    """Named federal areas, with a representative point inside each one (never a bounding-box centre, which can
    land in the middle of a lake or outside a crescent-shaped park) and its published acreage for prominence."""
    import tarfile
    import shapefile  # pyshp
    from shapely.geometry import shape as shapely_shape

    source = SOURCES["federalLands"]
    payload = source_bytes("federalLands", download)
    targets = {"shp": (source["member"], source["memberBytes"], source["memberSha256"]),
               "dbf": (source["companionMember"], source["companionBytes"], source["companionSha256"])}
    (BUILD / "fedlan").mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        members = {Path(item.name).name: item for item in archive.getmembers()}
        for _key, (name, size, digest) in targets.items():
            data = archive.extractfile(members[name]).read()
            if len(data) != size or sha256_bytes(data) != digest:
                raise SystemExit(f"federalLands: {name} is not the pinned member (digest mismatch)")
            (BUILD / "fedlan" / name).write_bytes(data)

    reader = shapefile.Reader(str(BUILD / "fedlan" / "fedlanp010g.shp"), encoding="cp1252", encodingErrors="replace")
    # A named area can be several polygons (a wilderness area managed in two forests, a refuge in three pieces).
    # They are one place, so they are collapsed to the largest polygon: the one whose representative point best
    # describes the area a person means, and the one with the acreage that ranks it.
    candidates, skipped = {}, Counter()
    for record, geometry in zip(reader.records(), reader.shapes()):
        row = record.as_dict()
        feature = (row.get("FEATURE1") or "").strip()
        kind = FEDERAL_FEATURES.get(feature)
        name = (row.get("GNIS_Name1") or "").strip()
        if kind is None or not name:
            skipped[feature or "unnamed"] += 1
            continue
        state = (row.get("STATE") or "").strip().split("-")[0]
        if state not in CONUS:
            skipped["outside"] += 1
            continue
        try:
            acres = float(row.get("GIS_ACRES") or 0)
        except (TypeError, ValueError):
            acres = 0.0
        key = (normalize_name(name), state)
        previous = candidates.get(key)
        if previous and previous["acres"] >= acres:
            skipped["smaller-part"] += 1
            continue
        try:
            point = shapely_shape(geometry.__geo_interface__).representative_point()
        except Exception:
            skipped["geometry"] += 1
            continue
        candidates[key] = {"id": f"F:{hashlib.sha1(f'{name}|{state}'.encode()).hexdigest()[:10]}", "name": name,
                           "state": state, "type": kind, "lat": rounded(point.y), "lon": rounded(point.x),
                           "acres": round(acres, 1), "sourceId": (row.get("GNIS_ID1") or "").strip() or None}
    return list(candidates.values()), skipped

# ------------------------------------------------ normalization (mirrored exactly by the browser)

# The only rewrites, and they are data, not heuristics: the two abbreviations that appear in the sources' own
# names, plus `ft`. Directional abbreviations are deliberately NOT folded - "n" already matches "north" by
# prefix, and folding a single letter would merge names that are not the same.
PAIRED_ABBREVIATIONS = {"st": "saint", "mt": "mount", "ft": "fort"}

NORMALIZATION_FIXTURE = [
    "St. Louis", "st louis", "SAINT LOUIS", "Ft. Worth", "Fort Worth", "Mt. Vernon", "Mount Vernon",
    "O'ahu", "O’ahu", "Coeur d'Alene", "Winston-Salem", "Wilkes Barre", "Wilkes-Barre", "Truth or Consequences",
    "  Santa   Fe  ", "Cañon City", "San José", "Añasco", "Havre de Grace", "Bay St. Louis",
    "Prince George's County", "District of Columbia", "St. Mary's", "N. Little Rock", "E. St. Louis",
    "Portland", "PORTLAND", "portland,", "New York City", "jefferson county", "47715", "00601", "",
    "É", "ﬁshing bridge", "Natchitoches", "La Cañada Flintridge", "St. John's", "Coos Bay",
]


def normalize_name(value):
    """One text normalization, applied identically to a query and to every stored name: Unicode NFKD with
    combining marks removed, case folded, periods, apostrophes, hyphens and slashes treated as separators,
    remaining punctuation dropped, whitespace collapsed, and the documented abbreviations folded."""
    if not isinstance(value, str):
        return ""
    stripped = "".join(ch for ch in unicodedata.normalize("NFKD", value) if not unicodedata.combining(ch))
    folded = stripped.lower()
    for character in ".'’`":
        folded = folded.replace(character, " ")
    for character in "-–—_/":
        folded = folded.replace(character, " ")
    cleaned = "".join(ch if (ch.isascii() and (ch.isalnum() or ch == " ")) else " " for ch in folded)
    return " ".join(PAIRED_ABBREVIATIONS.get(word, word) for word in cleaned.split())


STATE_BY_NAME = {name: abbrev for abbrev, name in STATE_NAMES.items()}


def gnis_rows(download):
    """Stream the GNIS national file. The container digest is the pinned integrity check (SOURCES['gnis']);
    the member digest is recorded as provenance, and a 147 MB member is streamed rather than held twice."""
    source = SOURCES["gnis"]
    payload = source_bytes("gnis", download)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        with archive.open(source["member"]) as handle:
            header = None
            for raw in io.TextIOWrapper(handle, encoding="utf-8-sig", errors="replace"):
                if header is None:
                    header = raw.rstrip("\r\n").split("|")
                    continue
                if not raw.strip():
                    continue
                yield dict(zip(header, raw.rstrip("\r\n").split("|")))


def read_gnis_communities(download, known):
    """GNIS populated places the Census place file does not carry, deduplicated deterministically: a feature
    whose normalized name and state already describe a Census place is the same real place and is dropped, and
    two GNIS features that agree on name, state and county are the same community."""
    out, skipped, seen = [], Counter(), set()
    for row in gnis_rows(download):
        if (row.get("feature_class") or "").strip() != "Populated Place":
            continue
        name = (row.get("feature_name") or "").strip()
        if "(historical)" in name:
            skipped["historical"] += 1
            continue
        state = STATE_BY_NAME.get((row.get("state_name") or "").strip())
        if state is None or state not in CONUS:
            skipped["outside"] += 1
            continue
        normalized = normalize_name(name)
        if (normalized, state) in known:
            skipped["deduplicated-against-census"] += 1
            continue
        county = (row.get("county_name") or "").strip() or None
        if county and not re.search(r"(County|Parish|City|Borough)$", county):
            county = f"{county} County"
        if (normalized, state, county) in seen:
            skipped["duplicate-feature"] += 1
            continue
        seen.add((normalized, state, county))
        try:
            lat, lon = rounded(row["prim_lat_dec"]), rounded(row["prim_long_dec"])
        except (KeyError, TypeError, ValueError):
            skipped["no-coordinate"] += 1
            continue
        out.append({"id": f"G:{row['feature_id'].strip()}", "name": name, "state": state, "type": "community",
                    "county": county, "lat": lat, "lon": lon, "sourceId": row["feature_id"].strip()})
    return out, skipped


# ---------------------------------------------------------------- assembly and encoding

def dictionaries(core, extended):
    """The dictionaries both tiers share, so an extended row's indices mean the same thing whether the extended
    artifact is read alone or merged into an already-loaded core tier."""
    rows = list(core) + list(extended)
    states = sorted({row["state"] for row in rows})
    counties = sorted({row["county"] for row in rows if row["county"]})
    return {"states": states, "stateNames": [STATE_NAMES[state] for state in states],
            "types": sorted({row["type"] for row in rows}), "sources": sorted({row["source"] for row in rows}),
            "counties": counties}


def encode(rows, tables, scope, sources):
    state_index = {name: index for index, name in enumerate(tables["states"])}
    type_index = {name: index for index, name in enumerate(tables["types"])}
    source_index = {name: index for index, name in enumerate(tables["sources"])}
    county_index = {name: index for index, name in enumerate(tables["counties"])}
    ordered = sorted(rows, key=lambda row: (normalize_name(row["name"]), row["state"], row["type"], row["id"]))
    seen = set()
    for row in ordered:
        if row["id"] in seen:
            raise SystemExit(f"a duplicate place id reached the artifact: {row['id']} ({row['name']}, {row['state']})")
        seen.add(row["id"])
        if len(row["name"]) > MAX_NAME_LENGTH or any(character < " " for character in row["name"]):
            raise SystemExit(f"a place name is outside the schema's bounds: {row['id']} {row['name']!r}")
    encoded = [[row["id"], row["name"], state_index[row["state"]], county_index.get(row["county"], -1), row["lat"],
                row["lon"], type_index[row["type"]],
                -1 if row["population"] is None else row["population"], row["prominence"],
                source_index[row["source"]]] for row in ordered]
    document = {"kind": KIND, "schemaVersion": SCHEMA_VERSION, "artifactVersion": ARTIFACT_VERSION,
                "columns": list(COLUMNS), "dictionaries": tables, "sources": sources, "scope": scope, "rows": encoded}
    return document, ordered


def render(document):
    return (json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def build(download=False):
    """Read every source and assemble the two tiers. Deterministic: the same pinned sources and this code always
    produce the same bytes, because every ordering here is total and every choice is stated."""
    places, place_skipped = read_places(download)
    populations = read_populations(download)
    county_populations = read_county_populations(download)
    counties = read_counties(download)
    federal, federal_skipped = read_federal_lands(download)
    zctas = read_zctas(download)

    core, known = [], set()
    county_names = {row["sourceId"]: row["name"] for row in counties}
    for place in places:
        geoid = place["sourceId"]
        entry = populations.get((place["state"], geoid[2:]))
        population = entry["population"] if entry else None
        core.append({**place, "county": county_names.get(entry["county"]) if entry and entry["county"] else None,
                     "population": population, "prominence": population or 0, "source": "census-place"})
        known.add((normalize_name(place["name"]), place["state"]))
    for county in counties:
        population = county_populations.get(county["sourceId"])
        core.append({**county, "county": county["sourceId"], "population": population,
                     "prominence": population or 0, "source": "census-county"})
    for area in federal:
        core.append({"id": area["id"], "name": area["name"], "state": area["state"], "county": None,
                     "lat": area["lat"], "lon": area["lon"], "type": area["type"], "population": None,
                     "prominence": int(round(area["acres"] / 1000.0)), "source": "usgs-federal-lands"})

    communities, gnis_skipped = read_gnis_communities(download, known)
    community_rows = [{**row, "population": None, "prominence": 0, "source": "gnis-populated-place"}
                      for row in communities]
    zip_rows = [{"id": row["id"], "name": row["name"], "state": row["state"], "county": row["county"],
                 "lat": row["lat"], "lon": row["lon"], "type": row["type"], "population": None, "prominence": 0,
                 "source": "census-zcta"} for row in zctas]

    tables = dictionaries(core, community_rows + zip_rows)
    # Which pinned sources each tier was actually built from: the provenance a reader can check against the
    # digests above, rather than a claim that every source contributed to every artifact.
    provenance = {"core": ("places", "counties", "placePopulation", "countyPopulation", "federalLands"),
                  "postal": ("zcta", "zctaCounty"), "community": ("gnis",)}
    coverage = {"coverage": "conterminous United States including the District of Columbia",
                "bounds": [-124.848974, 24.396308, -66.885444, 49.384479],
                "note": "A place outside this coverage could not return a corridor at any radius, because the "
                        "national derived corridor-metrics plane covers exactly the conterminous states."}
    core_document, core_ordered = encode(core, tables, {**coverage, "tier": "core",
                                       "counts": dict(Counter(row["type"] for row in core))},
                                       {key: SOURCES[key] for key in provenance["core"]})
    zip_document, zip_ordered = encode(zip_rows, tables, {**coverage, "tier": "postal",
                                     "counts": dict(Counter(row["type"] for row in zip_rows))},
                                     {key: SOURCES[key] for key in provenance["postal"]})
    community_document, community_ordered = encode(community_rows, tables,
                                                  {**coverage, "tier": "community",
                                                   "counts": dict(Counter(row["type"] for row in community_rows))},
                                                  {key: SOURCES[key] for key in provenance["community"]})
    tallies = {"places": len(places), "communities": len(communities), "counties": len(counties),
               "federalAreas": len(federal), "zctas": len(zctas), "core": len(core_ordered),
               "zip": len(zip_ordered), "community": len(community_ordered),
               "skipped": {"places": dict(place_skipped), "federal": dict(federal_skipped),
                           "gnis": dict(gnis_skipped)}}
    return core_document, zip_document, community_document, tables, tallies


# ---------------------------------------------------------------- reporting and verification

def fixture_document():
    return {"kind": "road-discovery-place-normalization-fixture", "schemaVersion": 1,
            "note": "The one text normalization, written down once in both languages. "
                    "src/discovery/place-gazetteer.js must produce the same normalized form for every input "
                    "here, and tests/place-gazetteer.test.js asserts it against the committed artifact.",
            "cases": [[text, normalize_name(text)] for text in NORMALIZATION_FIXTURE]}


def artifact_entry(payload, path, rows):
    return {"path": str(path.relative_to(ROOT)), "bytes": len(payload), "sha256": sha256_bytes(payload),
            "gzipBytes": len(gzip.compress(payload, 9)), "jsonRows": rows,
            "compressionNote": "Cloudflare serves this asset compressed; gzipBytes is the measured floor."}


def report_document(payloads, fixture_bytes, tables, tallies):
    return {"kind": "road-discovery-national-place-gazetteer-build", "pipelineVersion": PIPELINE_VERSION,
            "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "artifactVersion": ARTIFACT_VERSION, "schemaVersion": SCHEMA_VERSION, "columns": list(COLUMNS),
            "artifacts": {"core": artifact_entry(payloads["core"], CORE_PATH, tallies["core"]),
                          "postalCode": artifact_entry(payloads["zip"], ZIP_PATH, tallies["zip"]),
                          "community": artifact_entry(payloads["community"], COMMUNITY_PATH, tallies["community"]),
                          "normalizationFixture": artifact_entry(fixture_bytes, FIXTURE_PATH,
                                                                 len(NORMALIZATION_FIXTURE))},
            "dictionaries": {key: len(value) for key, value in tables.items()},
            "extraction": {key: tallies[key] for key in ("places", "counties", "federalAreas", "zctas", "communities")},
            "skipped": tallies["skipped"],
            "deduplication": {key: tallies["skipped"]["gnis"].get(key, 0) for key in
                              ("deduplicated-against-census", "duplicate-feature", "historical", "outside")},
            "sources": SOURCES}


def decode_rows(document):
    tables = document["dictionaries"]
    return [{"id": row[0], "name": row[1], "state": tables["states"][row[2]],
             "county": tables["counties"][row[3]] if row[3] >= 0 else None, "lat": row[4], "lon": row[5],
             "type": tables["types"][row[6]], "population": row[7], "prominence": row[8],
             "source": tables["sources"][row[9]]} for row in document["rows"]]


def find(rows, name, state, kind=None):
    for row in rows:
        if row["name"] == name and row["state"] == state and (kind is None or row["type"] == kind):
            return row
    return None



def verify_artifacts():
    """Offline check of the committed artifacts against the report that describes them, and against the places
    the product and its tests actually name."""
    problems = []
    paths = {"core": CORE_PATH, "postalCode": ZIP_PATH, "community": COMMUNITY_PATH}
    missing = [path for path in paths.values() if not path.exists()]
    if missing or not REPORT_PATH.exists():
        print("FAIL: the committed gazetteer artifacts or their report are missing")
        return 1
    report = json.loads(REPORT_PATH.read_text())
    documents = {key: json.loads(path.read_text()) for key, path in paths.items()}
    for key, document in documents.items():
        payload = paths[key].read_bytes()
        expected = report["artifacts"][key]
        if len(payload) != expected["bytes"] or sha256_bytes(payload) != expected["sha256"]:
            problems.append(f"{key}: the committed artifact does not match the report's bytes and digest")
        if document["kind"] != KIND or document["schemaVersion"] != SCHEMA_VERSION:
            problems.append(f"{key}: not a {KIND} document at schema {SCHEMA_VERSION}")
        if document["columns"] != list(COLUMNS):
            problems.append(f"{key}: the column order is not the declared one")
        tables = document["dictionaries"]
        if len(tables["states"]) != len(tables["stateNames"]):
            problems.append(f"{key}: the state dictionary and its names disagree")
        ids = set()
        for row in document["rows"]:
            if len(row) != len(COLUMNS):
                problems.append(f"{key}: a row does not have {len(COLUMNS)} values")
                break
            if row[0] in ids:
                problems.append(f"{key}: a duplicate place id: {row[0]}")
                break
            ids.add(row[0])
            if not (0 <= row[2] < len(tables["states"]) and -1 <= row[3] < len(tables["counties"])
                    and 0 <= row[6] < len(tables["types"]) and 0 <= row[9] < len(tables["sources"])):
                problems.append(f"{key}: a row has an out-of-range dictionary index")
                break
    core_rows = decode_rows(documents["core"])
    zip_rows = decode_rows(documents["postalCode"])
    # Reference places, with the interior point the pinned Census source publishes (within 0.01 degrees, about a
    # kilometre) and the county from the Census population file: a wrong row cannot satisfy name, state, type,
    # coordinate and county at once.
    for name, state, kind, lon, lat, county in (
            ("Princeton", "IN", "city", -87.579508, 38.354473, "Gibson County"),
            ("Evansville", "IN", "city", -87.534705, 37.987737, "Vanderburgh County"),
            ("Nashville", "TN", "city", -86.785002, 36.1718, "Davidson County"),
            ("Cookeville", "TN", "city", -85.512653, 36.146926, "Putnam County"),
            ("Portland", "OR", "city", -122.649971, 45.536951, "Multnomah County"),
            ("Boston", "MA", "city", -71.018253, 42.338551, "Suffolk County"),
            ("Miami", "FL", "city", -80.208615, 25.775163, "Miami-Dade County"),
            ("Minneapolis", "MN", "city", -93.26832, 44.963324, "Hennepin County"),
            ("Omaha", "NE", "city", -96.053475, 41.262705, "Douglas County"),
            ("Phoenix", "AZ", "city", -112.090132, 33.572154, "Maricopa County"),
            ("Moab", "UT", "city", -109.547811, 38.570083, "Grand County"),
            ("Duluth", "MN", "city", -92.134135, 46.774458, "St. Louis County")):
        row = find(core_rows, name, state, kind)
        if row is None:
            problems.append(f"{name}, {state} ({kind}) is missing from the core tier")
            continue
        if abs(row["lon"] - lon) > 0.01 or abs(row["lat"] - lat) > 0.01:
            problems.append(f"{name}, {state} is at {row['lat']},{row['lon']}, not near {lat},{lon}")
        if county and row["county"] != county:
            problems.append(f"{name}, {state} names county {row['county']}, not {county}")
    for name, state, kind in (("Louisville", "KY", "city"), ("Carson City", "NV", "city"),
                              ("Indianapolis", "IN", "city")):
        if find(core_rows, name, state, kind) is None:
            problems.append(f"{name}, {state} (a consolidated government) is missing from the core tier")
    if find(core_rows, "Gibson County", "IN", "county") is None:
        problems.append("Gibson County, Indiana is missing from the core tier")
    for name, state in (("Great Smoky Mountains National Park", "TN"), ("Yellowstone National Park", "WY"),
                        ("Yosemite National Park", "CA")):
        if find(core_rows, name, state) is None:
            problems.append(f"{name} is missing from the core tier")
    if find(zip_rows, "47715", "IN", "zip") is None:
        problems.append("ZIP 47715 is missing from the postal-code tier")
    fixture = json.loads(FIXTURE_PATH.read_text())
    if fixture["kind"] != "road-discovery-place-normalization-fixture" or len(fixture["cases"]) < 30:
        problems.append("the normalization fixture is missing or too small")
    for key, path in paths.items():
        entry = report["artifacts"][key]
        print(f"{key:10s} {entry['jsonRows']:>8,} rows  {entry['bytes']:>11,} bytes  gzip {entry['gzipBytes']:>10,}")
    print(f"dictionaries: {report['dictionaries']}")
    print(f"extraction: {report['extraction']}")
    print(f"deduplication: {report['deduplication']}")
    if problems:
        print("FAIL:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("OK: the committed artifacts are the ones their report describes, and carry the expected places")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--download", action="store_true", help="fetch the pinned sources before building")
    parser.add_argument("--measure", action="store_true", help="build in memory and print sizes and counts only")
    parser.add_argument("--check", action="store_true", help="re-derive and compare with the committed artifacts")
    parser.add_argument("--verify-artifacts", action="store_true", help="offline check of the committed artifacts")
    args = parser.parse_args()
    if args.verify_artifacts:
        return verify_artifacts()

    started = time.monotonic()
    core_document, zip_document, community_document, tables, tallies = build(args.download)
    payloads = {"core": render(core_document), "zip": render(zip_document), "community": render(community_document)}
    fixture_bytes = render(fixture_document())
    elapsed = time.monotonic() - started
    for key, payload in payloads.items():
        print(f"{key:10s} {tallies[key]:>8,} rows  {len(payload):>11,} bytes  gzip {len(gzip.compress(payload, 9)):>10,}")
    print(f"build took {elapsed:.1f}s")
    print("extraction " + json.dumps({key: tallies[key] for key in
          ("places", "counties", "federalAreas", "zctas", "communities")}))
    print("skipped " + json.dumps(tallies["skipped"]))

    if args.measure:
        return 0
    committed = ((CORE_PATH, payloads["core"]), (ZIP_PATH, payloads["zip"]),
                 (COMMUNITY_PATH, payloads["community"]), (FIXTURE_PATH, fixture_bytes))
    if args.check:
        ok = True
        for path, payload in committed:
            if not path.exists():
                print(f"CHECK FAILED: {path.relative_to(ROOT)} is missing")
                ok = False
            elif path.read_bytes() == payload:
                print(f"CHECK OK: {path.name} is exactly what the pinned sources and this code produce")
            else:
                print(f"CHECK FAILED: {path.name} is stale ({path.stat().st_size:,} committed vs {len(payload):,} derived)")
                ok = False
        return 0 if ok else 1

    CORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    for path, payload in committed:
        path.write_bytes(payload)
    REPORT_PATH.write_text(json.dumps(report_document(payloads, fixture_bytes, tables, tallies), indent=2) + "\n")
    print("wrote " + ", ".join(str(path.relative_to(ROOT)) for path in
                               (CORE_PATH, ZIP_PATH, COMMUNITY_PATH, FIXTURE_PATH, REPORT_PATH)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
