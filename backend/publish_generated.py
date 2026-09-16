"""
Merge this run's decoded meetings into the published board files.

The scraper writes the meetings it produced to backend/output/<board>.generated.json. This
upserts them into public/data/boards/<board>.json by meeting id, the same merge --write-public
does.

It exists so the daily workflow can publish without text-level git conflicts. The workflow
resets to the latest main — which may already hold newer commits than the run started from —
and then re-applies only what this run produced, merged by id. Two writers touching the same
board file then combine cleanly, where a `git pull --rebase` of the whole file conflicts and
fails.

    python backend/publish_generated.py            # merge every generated file
    python backend/publish_generated.py --board ddsb
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from boards import BOARDS_BY_SLUG
from common import OUTPUT_DIR, log, public_meetings_json


def merge(slug: str) -> int:
    """Upsert one board's generated meetings into its published file. Returns records merged."""
    generated = OUTPUT_DIR / f"{slug}.generated.json"
    if not generated.exists():
        return 0
    records = json.loads(generated.read_text(encoding="utf-8"))
    if not records:
        return 0

    board = BOARDS_BY_SLUG.get(slug)
    if board is None:
        log.warning("Skipping %s: no such board in data/boards_config.json", generated.name)
        return 0

    target = public_meetings_json(board)
    merged = {m["id"]: m for m in json.loads(target.read_text(encoding="utf-8"))} if target.exists() else {}
    merged.update({r["id"]: r for r in records})
    ordered = sorted(merged.values(), key=lambda m: m["meetingDate"], reverse=True)

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log.info("%s: merged %d meeting(s); %d published in total", board.short_name, len(records), len(ordered))
    return len(records)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Merge generated meetings into the published board files.")
    parser.add_argument("--board", help="only this board's generated file")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if args.board:
        slugs = [args.board]
    else:
        slugs = sorted(p.name.removesuffix(".generated.json") for p in OUTPUT_DIR.glob("*.generated.json"))

    total = sum(merge(slug) for slug in slugs)
    log.info("Merged %d meeting(s) from %d generated file(s)", total, len(slugs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
