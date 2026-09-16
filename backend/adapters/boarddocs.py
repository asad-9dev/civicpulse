"""
BoardDocs meeting portals (go.boarddocs.com).

BoardDocs publishes no agenda PDF: the agenda is HTML inside a JavaScript app. Two endpoints,
both observed live against go.boarddocs.com/can/ucdsb:

    GET  <base>/BD-GETMeetingsListForSEO?open
         -> [{"Name": ..., "Description": ..., "Unique": "<meeting id>", "Date": "...Z"}]
         The whole meeting list as plain JSON, no session or committee id needed.

    <base>/goto?open&id=<Unique>
         The meeting's public page. The agenda is fetched by the page's own script
         (BD-GetAgenda), so it is read from the rendered DOM rather than requested directly —
         that POST needs a committee id the page holds internally.

`base` is the Board.nsf path from the board's seed_url, e.g.
https://go.boarddocs.com/can/ucdsb/Board.nsf
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from playwright.sync_api import BrowserContext

from boards import Board
from common import AgendaSource, PipelineError, log, parse_meeting_date, guess_committee

# BoardDocs answers 403 to anything that doesn't look like a browser, so this one request
# uses a browser User-Agent rather than the project's own.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

MEETINGS_ENDPOINT = "{base}/BD-GETMeetingsListForSEO?open"
MEETING_PAGE = "{base}/goto?open&id={meeting_id}"

# Private sessions publish no public agenda; the name says so.
PRIVATE = re.compile(r"private session|in[- ]camera|closed session", re.I)


def board_nsf_base(board: Board) -> str:
    """https://go.boarddocs.com/can/ucdsb/Board.nsf, whatever deeper link the registry holds."""
    seed = board.agenda_portal or ""
    match = re.match(r"(https?://[^/]+/[^/]+/[^/]+/Board\.nsf)", seed, re.I)
    if not match:
        raise PipelineError(f"{board.short_name}: seed_url {seed!r} is not a BoardDocs Board.nsf URL")
    return match.group(1)


def fetch_meetings(base: str) -> list[dict]:
    url = MEETINGS_ENDPOINT.format(base=base)
    request = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "application/json,*/*"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError) as exc:
        raise PipelineError(f"BoardDocs meeting list failed ({url}): {exc}") from exc
    try:
        meetings = json.loads(body)
    except ValueError as exc:
        raise PipelineError(f"BoardDocs meeting list wasn't JSON ({url})") from exc
    if not isinstance(meetings, list):
        raise PipelineError(f"BoardDocs meeting list wasn't a list ({url})")
    return meetings


def discover_boarddocs(context: BrowserContext, board: Board, limit: int) -> list[AgendaSource]:
    """
    List a BoardDocs board's public meetings, newest first.

    Unlike the PDF portals there is nothing to check per meeting: the list says which meetings
    exist, and the agenda is read later from the meeting page. So no page is opened here, and
    `limit` is applied to the list directly.
    """
    base = board_nsf_base(board)
    meetings = fetch_meetings(base)
    log.info("%s BoardDocs lists %d meeting(s)", board.short_name, len(meetings))

    sources: list[AgendaSource] = []
    for meeting in meetings:
        name = str(meeting.get("Name") or "").strip()
        meeting_id = str(meeting.get("Unique") or "").strip()
        if not name or not meeting_id or PRIVATE.search(name):
            continue
        # "2025-08-13T00:00:00Z" -> 2025-08-13; fall back to a date in the name.
        date = parse_meeting_date(str(meeting.get("Date") or "")) or parse_meeting_date(name)
        if not date:
            continue
        sources.append(
            AgendaSource(
                board=board,
                page_url=MEETING_PAGE.format(base=base, meeting_id=meeting_id),
                committee_name=guess_committee(name, default=name),
                meeting_date=date,
                pdf_url=None,
                content_type="html",
            )
        )

    sources.sort(key=lambda s: s.meeting_date or "", reverse=True)
    return sources[:limit]
