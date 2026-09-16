"""
Push data/boards_config.json into the Supabase `boards` table.

The registry in the JSON file is the source of truth; this copies it into Postgres so digest_log
and subscriber_boards can reference a board by id. Run it whenever the registry changes — after
adding a board, or after a board's portal or status is corrected.

    python backend/seed_boards.py            # upsert every board
    python backend/seed_boards.py --dry-run  # show what would change

Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, read from .env.local (or the
environment). The `boards` table has to exist already: run backend/schema.sql once first.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from boards import BOARDS
from common import PROJECT_ROOT, log


def read_env_file(path: Path) -> dict[str, str]:
    """Minimal .env reader: KEY=value, quotes stripped, # comments and blanks skipped."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    return env


def credentials() -> tuple[str, str]:
    env = {**read_env_file(PROJECT_ROOT / ".env.local"), **os.environ}
    url = (env.get("NEXT_PUBLIC_SUPABASE_URL") or "").strip().rstrip("/")
    key = (env.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        raise SystemExit(
            "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env.local or the environment)."
        )
    return url, key


def rows() -> list[dict]:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return [
        {
            "slug": board.slug,
            "name": board.name,
            "short_name": board.short_name,
            "region": board.region,
            "board_type": board.board_type,
            "province": "ON",
            "website": board.website,
            "agenda_portal": board.agenda_portal,
            "platform": board.platform,
            "status": board.status,
            "is_active": True,
            "updated_at": now,
        }
        for board in BOARDS
    ]


def upsert(url: str, key: str, payload: list[dict]) -> int:
    request = urllib.request.Request(
        f"{url}/rest/v1/boards?on_conflict=slug",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # merge-duplicates so an existing board keeps its id, which digest_log references.
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return len(json.loads(response.read()))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        if exc.code in (404, 400) and "boards" in detail:
            raise SystemExit(
                "The boards table doesn't exist yet. Run backend/schema.sql in the Supabase SQL Editor first."
            ) from exc
        raise SystemExit(f"Seeding failed: HTTP {exc.code} {detail}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Copy data/boards_config.json into the Supabase boards table.")
    parser.add_argument("--dry-run", action="store_true", help="print what would be sent and stop")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    payload = rows()
    by_status: dict[str, int] = {}
    for row in payload:
        by_status[row["status"]] = by_status.get(row["status"], 0) + 1
    log.info("%d boards in the registry: %s", len(payload), by_status)

    if args.dry_run:
        for row in payload[:5]:
            log.info("  %s | %s | %s | %s", row["slug"], row["platform"], row["status"], row["agenda_portal"])
        log.info("  ... (--dry-run, nothing sent)")
        return 0

    url, key = credentials()
    count = upsert(url, key, payload)
    log.info("Upserted %d board row(s) into %s", count, url.split("//")[-1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
