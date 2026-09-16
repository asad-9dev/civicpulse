"""
Batch runner: scrape several boards in one go, a few at a time, and remember what happened.

Each board is scraped by running scrape_agendas.py as its own process. That keeps one board's
crash, hung browser or bad PDF from touching the others, and means the single-board path stays
the one that's actually exercised.

Examples
    python backend/run_all.py --all                      # every live board, 2 at a time
    python backend/run_all.py --board yrdsb              # one board, for testing
    python backend/run_all.py --portal escribe --write-public
    python backend/run_all.py --all --retry-failed       # only the boards that failed last time

State lives in data/ingest_status.json: a run that dies partway through can be resumed with
--resume instead of starting over, and --retry-failed picks up just the boards that broke.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from boards import BOARDS, SLUGS, Board, boards_for, summary as boards_summary
from common import DATA_DIR, log

SCRIPT = Path(__file__).resolve().parent / "scrape_agendas.py"
STATUS_PATH = DATA_DIR / "ingest_status.json"

# Gemini's free tier is per-minute as well as per-day, and each board's run makes several calls.
# Two boards at a time keeps a batch inside it without the run taking all morning.
DEFAULT_CONCURRENCY = 2
# A board that hangs shouldn't hold the batch open forever.
BOARD_TIMEOUT_SECONDS = 1800


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_status() -> dict:
    if not STATUS_PATH.exists():
        return {"boards": {}}
    try:
        return json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except ValueError:
        log.warning("%s was unreadable; starting a fresh status file", STATUS_PATH.name)
        return {"boards": {}}


def save_status(status: dict) -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATUS_PATH.write_text(json.dumps(status, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def scrape_one(board: Board, args: argparse.Namespace) -> dict:
    """Run scrape_agendas.py for one board and turn the outcome into a status entry."""
    command = [
        sys.executable, str(SCRIPT),
        "--board", board.slug,
        "--months-back", str(args.months_back),
        "--limit", str(args.limit),
        "--summarizer", args.summarizer,
    ]
    if args.write_public:
        command.append("--write-public")
    if args.refresh:
        command.append("--refresh")
    if args.embed:
        command.append("--embed")

    started = time.monotonic()
    log.info("-> %s (%s)", board.short_name, board.platform)
    try:
        finished = subprocess.run(
            command, capture_output=True, text=True, timeout=BOARD_TIMEOUT_SECONDS, cwd=str(SCRIPT.parent)
        )
        ok = finished.returncode == 0
        # The scraper logs to stderr; keep the tail, which is where the reason lives.
        tail = (finished.stderr or finished.stdout or "").strip().splitlines()
        detail = " | ".join(line.strip() for line in tail[-3:])[:500]
    except subprocess.TimeoutExpired:
        ok, detail = False, f"timed out after {BOARD_TIMEOUT_SECONDS}s"

    elapsed = round(time.monotonic() - started, 1)
    log.info("%s %s in %ss", "OK  " if ok else "FAIL", board.short_name, elapsed)
    return {
        "slug": board.slug,
        "short_name": board.short_name,
        "platform": board.platform,
        "ok": ok,
        "last_run": now(),
        "seconds": elapsed,
        "detail": detail,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scrape many Ontario school boards in one batch.",
        epilog=boards_summary(),
    )
    picker = parser.add_mutually_exclusive_group(required=True)
    picker.add_argument("--board", choices=SLUGS, metavar="SLUG", help="just this board")
    picker.add_argument("--portal", choices=["escribe", "civicweb", "boarddocs", "generic_pdf"], help="every live board on this portal type")
    picker.add_argument("--all", action="store_true", help="every live board")
    picker.add_argument("--status", action="store_true", help="print the last run's results and exit")

    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help=f"boards at a time (default {DEFAULT_CONCURRENCY})")
    parser.add_argument("--resume", action="store_true", help="skip boards that already succeeded in the recorded run")
    parser.add_argument("--retry-failed", action="store_true", help="only boards that failed in the recorded run")
    parser.add_argument("--summarizer", choices=["dummy", "gemini", "claude"], default="gemini")
    parser.add_argument("--limit", type=int, default=10, help="max agendas per board (default 10)")
    parser.add_argument("--months-back", type=int, default=1)
    parser.add_argument("--write-public", action="store_true", help="publish into public/data/boards/<board>.json")
    parser.add_argument("--refresh", action="store_true", help="re-summarize agendas already published")
    parser.add_argument("--embed", action="store_true", help="also store agenda text and embeddings for semantic search")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


def print_status(status: dict) -> None:
    entries = status.get("boards", {})
    if not entries:
        print(f"No runs recorded yet ({STATUS_PATH}).")
        return
    print(f"Last batch: {status.get('last_batch', 'unknown')}  ({STATUS_PATH})")
    ok = [e for e in entries.values() if e.get("ok")]
    bad = [e for e in entries.values() if not e.get("ok")]
    print(f"  {len(ok)} succeeded, {len(bad)} failed")
    for entry in sorted(entries.values(), key=lambda e: (e.get("ok", False), e["slug"])):
        mark = "OK  " if entry.get("ok") else "FAIL"
        print(f"  {mark} {entry['slug']:16} {entry.get('platform', ''):10} {entry.get('seconds', '?')}s  {entry.get('detail', '')[:90]}")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    import logging

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")

    status = load_status()
    if args.status:
        print_status(status)
        return 0

    selected = boards_for(board_slug=args.board, portal=args.portal, every=args.all)
    if not selected:
        log.error("Nothing to do: no live boards matched. %s", boards_summary())
        return 1

    previous = status.get("boards", {})
    if args.retry_failed:
        selected = [b for b in selected if not previous.get(b.slug, {}).get("ok")]
        log.info("Retrying %d board(s) that failed last time", len(selected))
    elif args.resume:
        selected = [b for b in selected if not previous.get(b.slug, {}).get("ok")]
        log.info("Resuming: %d board(s) left to do", len(selected))
    if not selected:
        log.info("Nothing left to do.")
        return 0

    log.info("Scraping %d board(s), %d at a time, with %s", len(selected), args.concurrency, args.summarizer)
    started = time.monotonic()
    results = []
    # Each board finishing writes the status file, so killing the batch loses at most the boards
    # still in flight.
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        for result in pool.map(lambda b: scrape_one(b, args), selected):
            results.append(result)
            status.setdefault("boards", {})[result["slug"]] = result
            status["last_batch"] = now()
            save_status(status)

    ok = [r for r in results if r["ok"]]
    failed = [r for r in results if not r["ok"]]
    log.info(
        "Batch done in %ss: %d succeeded, %d failed",
        round(time.monotonic() - started, 1), len(ok), len(failed),
    )
    for result in failed:
        log.error("  %s: %s", result["slug"], result["detail"])
    if failed:
        log.info("Re-run just those with: python backend/run_all.py --all --retry-failed")
    return 1 if failed and not ok else 0


if __name__ == "__main__":
    sys.exit(main())
