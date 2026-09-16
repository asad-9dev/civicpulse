"""
Pieces every part of the pipeline shares: the agenda record passed between steps, the errors,
the paths and timeouts, and the small parsers that read dates and committee names out of the
wording each portal happens to use.

Kept separate from scrape_agendas.py so the adapters in backend/adapters/ can import it without
importing the pipeline that imports them.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from boards import Board

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
PUBLIC_BOARDS_DIR = PROJECT_ROOT / "public" / "data" / "boards"
OUTPUT_DIR = BACKEND_DIR / "output"
AGENDAS_DIR = BACKEND_DIR / "agendas"

# Portals refuse a project-specific User-Agent: BoardDocs answers 403 to "CivicPulse/...", and
# DDSB's WAF does the same, for pages they publish to the public. The scraper drives a real
# desktop Chromium, so it reports itself as one and says who it is in a header alongside, rather
# than pretending to be a browser it isn't. Playwright's own string says "HeadlessChrome", which
# several portals serve a degraded page to.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
CONTACT_HEADER = {"X-Civic-Contact": "CivicPulse - independent civic project summarizing public school board agendas"}
RENDER_TIMEOUT_MS = 30_000
# How long to wait for a meeting page's document links. Short: a meeting with no agenda posted
# yet never grows them, and a discovery run visits many such pages.
DOCUMENT_TIMEOUT_MS = 10_000
DOWNLOAD_TIMEOUT_MS = 120_000

CATEGORIES = ["Boundary Review", "Transport", "Policy", "Budget"]

log = logging.getLogger("civicpulse")


class PipelineError(Exception):
    """A step failed in a way the operator should hear about."""


@dataclass
class AgendaSource:
    """One meeting's agenda, as listed on a board's meeting calendar."""

    board: Board
    page_url: str  # the meeting's page on the calendar (or the local PDF path)
    committee_name: str
    meeting_date: str | None  # ISO yyyy-mm-dd when we can parse it
    pdf_url: str | None = None  # direct link to the agenda document
    # How the agenda has to be read: "pdf" is downloaded and parsed with pdfplumber, "html" is
    # rendered in the browser and read off the page (BoardDocs publishes no PDF).
    content_type: str = "pdf"


def public_meetings_json(board: Board) -> Path:
    """Where one board's decoded meetings live, e.g. public/data/boards/ddsb.json."""
    return PUBLIC_BOARDS_DIR / f"{board.slug}.json"


def slugify(text: str, max_length: int = 48) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:max_length].rstrip("-")


# Full names and abbreviations alike: eSCRIBE writes "September 9, 2026", CivicWeb writes
# "15 Sep 2026". Matching the first three letters and normalising with %b covers both.
MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"
DATE_PATTERNS = [
    # 2026-09-15
    (re.compile(r"(20\d{2})-(\d{2})-(\d{2})"), lambda m: f"{m[1]}-{m[2]}-{m[3]}"),
    # September 15, 2026 / Sep. 15 2026
    (
        re.compile(rf"\b({MONTHS})[a-z]*\.?\s+(\d{{1,2}}),?\s+(20\d{{2}})", re.IGNORECASE),
        lambda m: datetime.strptime(f"{m[1][:3]} {m[2]} {m[3]}", "%b %d %Y").strftime("%Y-%m-%d"),
    ),
    # 15 Sep 2026 / 15 September 2026
    (
        re.compile(rf"\b(\d{{1,2}})\s+({MONTHS})[a-z]*\.?,?\s+(20\d{{2}})", re.IGNORECASE),
        lambda m: datetime.strptime(f"{m[1]} {m[2][:3]} {m[3]}", "%d %b %Y").strftime("%Y-%m-%d"),
    ),
]


def parse_meeting_date(text: str) -> str | None:
    for pattern, to_iso in DATE_PATTERNS:
        match = pattern.search(text)
        if match:
            try:
                return to_iso(match)
            except ValueError:
                continue
    return None


def guess_committee(text: str, default: str = "Board of Trustees Meeting") -> str:
    """Normalize a calendar title ("Standing Committee Meeting") to the committee names the app shows."""
    t = text.lower().replace("-", " ")
    if "seac" in t or "special education advisory" in t:
        return "Special Education Advisory Committee"
    if "standing" in t or "committee of the whole" in t:
        return "Committee of the Whole - Standing"
    if "special board" in t:
        return "Special Board Meeting"
    if "regular" in t:
        return "Regular Board Meeting"
    return default.strip() or "Board of Trustees Meeting"


def record_id(source: AgendaSource) -> str:
    """
    One record per meeting: board + date + committee, e.g.
    ddsb-2026-09-09-committee-of-the-whole-standing.

    The board prefix keeps two boards apart: several run a "Special Education Advisory
    Committee", and they meet on the same evenings often enough that an unprefixed id would
    collide. Deliberately not built from summary text, so re-running the pipeline updates a
    meeting's record instead of adding a duplicate next to it.
    """
    return f"{source.board.slug}-{source.meeting_date or 'undated'}-{slugify(source.committee_name, 40)}"


def source_link(source: AgendaSource) -> str:
    return source.pdf_url or source.page_url or source.board.website
