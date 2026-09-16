"""
The Ontario school boards CivicPulse knows about.

Reads data/boards_config.json, the same file lib/boards.ts reads, so the website and the pipeline
can't disagree about 72 boards. The names, regions, types and websites come from the Ontario
Ministry of Education's board contact list; portal_type and seed_url were found by crawling each
board's own site.

`platform` picks the discovery adapter in scrape_agendas.py:
    escribe      eSCRIBE portal (escribemeetings.com, or a board's own vanity domain)
    civicweb     CivicWeb portal (*.civicweb.net)
    boarddocs    BoardDocs portal (go.boarddocs.com)
    generic_pdf  no portal: crawl the board's meetings page for linked PDFs
    unknown      nothing found yet; not scraped
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / "data" / "boards_config.json"

# Portal types an adapter can actually read.
SCRAPABLE_PLATFORMS = {"escribe", "civicweb", "boarddocs", "generic_pdf"}


@dataclass(frozen=True)
class Board:
    slug: str
    name: str
    short_name: str
    region: str
    board_type: str
    language: str
    website: str
    agenda_portal: str | None
    platform: str
    status: str
    municipalities: list[str] = field(default_factory=list)
    status_note: str = ""

    @property
    def scrapable(self) -> bool:
        return self.platform in SCRAPABLE_PLATFORMS and bool(self.agenda_portal)


def _load() -> tuple[list[Board], dict]:
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    boards = [
        Board(
            slug=b["slug"],
            name=b["name"],
            short_name=b["short_name"],
            region=b["region"],
            board_type=b["board_type"],
            language=b["language"],
            website=b["website"],
            agenda_portal=b.get("seed_url"),
            platform=b.get("portal_type") or "unknown",
            status=b.get("status", "planned"),
            municipalities=list(b.get("municipalities") or []),
            status_note=b.get("status_note", ""),
        )
        for b in raw["boards"]
    ]
    return boards, raw


BOARDS, CONFIG = _load()
BOARDS_BY_SLUG = {board.slug: board for board in BOARDS}
SLUGS = [board.slug for board in BOARDS]
SCRAPABLE_SLUGS = [board.slug for board in BOARDS if board.scrapable]


def get_board(slug: str) -> Board:
    """The board with this slug, or a clear error pointing at the registry."""
    try:
        return BOARDS_BY_SLUG[slug]
    except KeyError:
        raise SystemExit(
            f"Unknown board {slug!r}. {len(SLUGS)} boards are registered in data/boards_config.json; "
            f"{len(SCRAPABLE_SLUGS)} can be scraped. Run with --list to see them."
        ) from None


def boards_for(board_slug: str | None = None, portal: str | None = None, every: bool = False) -> list[Board]:
    """
    The boards a run should cover.

    --board picks one (even if it isn't scrapable, so the run can say why).
    --portal picks every scrapable board on one portal type.
    --all picks every scrapable board.
    """
    if board_slug:
        return [get_board(board_slug)]
    # A supervised board can have a portal and still hold no meetings, so batch runs skip it;
    # naming it with --board still works, and says why.
    if portal:
        return [b for b in BOARDS if b.scrapable and b.status == "live" and b.platform == portal]
    if every:
        return [b for b in BOARDS if b.scrapable and b.status == "live"]
    return []


def summary() -> str:
    """One line per portal type, for --list and log headers."""
    counts: dict[str, int] = {}
    for board in BOARDS:
        counts[board.platform] = counts.get(board.platform, 0) + 1
    parts = ", ".join(f"{n} {platform}" for platform, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    return f"{len(BOARDS)} boards registered ({parts}); {len(SCRAPABLE_SLUGS)} scrapable"
