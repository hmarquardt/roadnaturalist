"""Resolve the large-build workspace, so the factories never assume the boot volume.

The national factories write tens of gigabytes of sources, extractions, fragments and cell artifacts. That
material belongs on a dedicated build volume when one exists: `ROADNATURALIST_BUILD_VOLUME` names its root, and
`/Volumes/Lexar/roadnaturalist` is the default when that volume is mounted. Every tool still accepts `--work`,
which always wins. If no build volume is present the repository-local path is used, which is what a small
local run or a test wants.

ExFAT, which is how the current build volume is formatted, introduces one behaviour the factories must respect:
macOS writes an AppleDouble sidecar (`._name`) beside a file that carries extended attributes. A sidecar is not
a data file, so every directory scan filters names that start with a dot; without that filter a scan can pick up
`._checkpoint.json` as if it were a checkpoint, or count `._x.gdb` as a second file geodatabase.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VOLUME = "/Volumes/Lexar/roadnaturalist"


def volume_root():
    configured = os.environ.get("ROADNATURALIST_BUILD_VOLUME")
    if configured and Path(configured).is_dir():
        return Path(configured)
    if Path(DEFAULT_VOLUME).is_dir():
        return Path(DEFAULT_VOLUME)
    return None


def work_dir(plane, fallback):
    """`work/nhd` or `work/nwi` on the build volume, else the repository-local fallback."""
    root = volume_root()
    return (root / "work" / plane) if root else fallback


def cells_dir(plane, fallback):
    root = volume_root()
    return (root / "cells" / plane) if root else fallback


def is_data_file(path):
    """True for a real data file: never an AppleDouble sidecar or any other hidden entry."""
    return not path.name.startswith(".")
