"""
The Ontario school boards CivicPulse covers.

Mirrors lib/boards.ts, which is the source of truth for the website. Keep the two in step: the
site reads a meeting's boardSlug and looks up the name and towns here, so a slug that exists in
one file and not the other produces records the site can't label.

`platform` picks the discovery adapter in scrape_agendas.py:
    escribe   eSCRIBE meeting portal (calendar.ddsb.ca and most escribemeetings.com sites)
    civicweb  CivicWeb portal (yrdsb.civicweb.net and other *.civicweb.net sites)
    manual    no adapter; the board publishes agendas somewhere bespoke, or not at all
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Board:
    slug: str
    name: str
    short_name: str
    region: str
    board_type: str
    website: str
    agenda_portal: str | None
    platform: str
    status: str
    municipalities: list[str] = field(default_factory=list)
    status_note: str = ""

    @property
    def scrapable(self) -> bool:
        return self.platform in ("escribe", "civicweb") and bool(self.agenda_portal)


BOARDS: list[Board] = [
    Board(
        slug="ddsb",
        name="Durham District School Board",
        short_name="DDSB",
        region="Durham Region",
        board_type="public",
        website="https://www.ddsb.ca/about-ddsb/board-of-trustees/board-meetings/",
        agenda_portal="https://calendar.ddsb.ca/meetings",
        platform="escribe",
        status="live",
        municipalities=["Ajax", "Pickering", "Whitby", "Oshawa", "Uxbridge", "Brock", "Scugog"],
    ),
    Board(
        slug="yrdsb",
        name="York Region District School Board",
        short_name="YRDSB",
        region="York Region",
        board_type="public",
        website="https://www2.yrdsb.ca/about-us/board-trustees/committee-meeting-dates",
        agenda_portal="https://yrdsb.civicweb.net/Portal/MeetingSchedule.aspx",
        platform="civicweb",
        status="live",
        municipalities=[
            "Markham",
            "Vaughan",
            "Richmond Hill",
            "Newmarket",
            "Aurora",
            "Whitchurch-Stouffville",
            "King",
            "East Gwillimbury",
            "Georgina",
        ],
    ),
    Board(
        slug="tdsb",
        name="Toronto District School Board",
        short_name="TDSB",
        region="Toronto",
        board_type="public",
        website="https://www.tdsb.on.ca/Leadership/Agendas-Minutes-Decisions",
        agenda_portal=None,
        platform="manual",
        status="supervised",
        municipalities=["Toronto", "Etobicoke", "North York", "Scarborough", "York", "East York"],
        status_note=(
            "The province appointed a supervisor to the TDSB in 2025. Trustee meetings are "
            "suspended, so there are no agendas to decode."
        ),
    ),
    Board(
        slug="pdsb",
        name="Peel District School Board",
        short_name="PDSB",
        region="Peel Region",
        board_type="public",
        website="https://www.peelschools.org/agenda-and-minutes",
        agenda_portal=None,
        platform="manual",
        status="supervised",
        municipalities=["Mississauga", "Brampton", "Caledon"],
        status_note=(
            "Peel's agenda page says regular Board of Trustees meetings are paused until further "
            "notice under direction from the Ministry of Education."
        ),
    ),
]

BOARDS_BY_SLUG = {board.slug: board for board in BOARDS}
SLUGS = [board.slug for board in BOARDS]
SCRAPABLE_SLUGS = [board.slug for board in BOARDS if board.scrapable]


def get_board(slug: str) -> Board:
    """The board with this slug, or a clear error naming the ones that exist."""
    try:
        return BOARDS_BY_SLUG[slug]
    except KeyError:
        raise SystemExit(f"Unknown board {slug!r}. Known boards: {', '.join(SLUGS)}") from None
