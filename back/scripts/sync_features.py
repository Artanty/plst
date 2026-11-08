#!/usr/bin/env python3
"""Vendor the py builds of the shared server features from the feat project.

feat (/Users/artyomantoshkin/server/feat) is the CANONICAL home: specs in feat/back/spec/,
implementations in feat/back/features/<feature>/v1/py/, contract tests in feat/back/test/.
Never edit the vendored copies in place — edit feat, then re-run
`python3 scripts/sync_features.py` (or `.venv/bin/python -m scripts.sync_features`).

Set FEAT_DIR to point at a different feat checkout.
"""
import os
import shutil
from pathlib import Path

FEAT_DIR = Path(os.environ.get("FEAT_DIR") or Path(__file__).resolve().parents[3] / "feat")
FEATURES = FEAT_DIR / "back" / "features"
DEST = Path(__file__).resolve().parent.parent / "lib"

# feature name -> [source file, destination filename]  (index.py is feat's router entry, NOT vendored)
VENDOR = {
    "logging": [
        ("logger.py", "logger.py"),
        ("ext_log.py", "ext_log.py"),
        ("__init__.py", "__init__.py"),
    ],
    "db-diag": [
        ("db_diag.py", "db_diag.py"),
    ],
}


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    # lib is a package: the vendored ext_log uses `from .logger import Logger`.
    init = DEST / "__init__.py"
    if not init.exists():
        init.write_text('"""Vendored from the feat project — edit THERE, then re-run sync_features."""\n')
    for feature, files in VENDOR.items():
        src = FEATURES / feature / "v1" / "py"
        for from_name, to_name in files:
            shutil.copyfile(src / from_name, DEST / to_name)
            print(f"vendored {feature}/{from_name} -> lib/{to_name}")
    print("done — run the backend suite to verify")


if __name__ == "__main__":
    main()
