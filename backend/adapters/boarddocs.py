"""
BoardDocs meeting portals (go.boarddocs.com).

BoardDocs publishes no agenda PDF, and it serves an empty page to headless Chromium — a browser
gets a blank document with no title and no nodes at all, so there is nothing to click into or
wait for. Its own HTTP endpoints answer perfectly well, so this adapter uses those and never
opens a browser. Three requests, all observed live against go.boarddocs.com/can/ucdsb:

    GET  <base>/BD-GETMeetingsListForSEO?open
         -> [{"Name": ..., "Description": ..., "Unique": "<meeting id>", "Date": "...Z"}]
         The whole meeting list as plain JSON, no session or committee id needed.

    GET  <base>/goto?open&id=<meeting id>
         The meeting's page. Its committee <select> carries every committee's id, which the
         agenda request needs and the meeting list does not include.

    POST <base>/BD-GetAgenda?open   (id=<meeting id>&current_committee_id=<committee id>)
         -> the agenda as HTML: dt.category headings and li.item entries.

`base` is the Board.nsf path from the board's seed_url, e.g.
https://go.boarddocs.com/can/ucdsb/Board.nsf
"""

from __future__ import annotations

import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import BrowserContext

from boards import Board
from common import AgendaSource, PipelineError, guess_committee, log, parse_meeting_date

MEETINGS_ENDPOINT = "{base}/BD-GETMeetingsListForSEO?open"
MEETING_PAGE = "{base}/goto?open&id={meeting_id}"
AGENDA_ENDPOINT = "{base}/BD-GetAgenda?open"

# BoardDocs answers 403 to anything that doesn't look like a browser, so these requests carry a
# standard desktop Chrome User-Agent.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Private sessions publish no public agenda; the name says so.
PRIVATE = re.compile(r"private session|in[- ]camera|closed session", re.I)
# <option value="AA6JND4DF8AD">Main Governing Board</option>
COMMITTEE_OPTION = re.compile(r'<option\s+value="([A-Z0-9]{8,})"\s*(selected)?[^>]*>([^<]*)</option>', re.I)
# One agenda line per category heading and item title.
AGENDA_LINE = re.compile(
    r'<dt[^>]*class="[^"]*category[^"]*"[^>]*>(.*?)</dt>|<span class="order">(.*?)</span>\s*<span class="title">(.*?)</span>',
    re.I | re.S,
)
TAGS = re.compile(r"<[^>]+>")


def board_nsf_base(board: Board) -> str:
    """https://go.boarddocs.com/can/ucdsb/Board.nsf, whatever deeper link the registry holds."""
    seed = board.agenda_portal or ""
    match = re.match(r"(https?://[^/]+/[^/]+/[^/]+/Board\.nsf)", seed, re.I)
    if not match:
        raise PipelineError(f"{board.short_name}: seed_url {seed!r} is not a BoardDocs Board.nsf URL")
    return match.group(1)


def request(url: str, data: bytes | None = None, referer: str | None = None) -> str:
    headers = {"User-Agent": BROWSER_UA, "Accept": "*/*"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        headers["X-Requested-With"] = "XMLHttpRequest"
    if referer:
        headers["Referer"] = referer
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=90) as response:
            return response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError) as exc:
        raise PipelineError(f"BoardDocs request failed ({url}): {exc}") from exc


def fetch_meetings(base: str) -> list[dict]:
    body = request(MEETINGS_ENDPOINT.format(base=base))
    try:
        meetings = json.loads(body)
    except ValueError as exc:
        raise PipelineError(f"BoardDocs meeting list wasn't JSON ({base})") from exc
    if not isinstance(meetings, list):
        raise PipelineError(f"BoardDocs meeting list wasn't a list ({base})")
    return meetings


def committee_ids(base: str, meeting_id: str) -> list[str]:
    """
    Every committee id on the meeting's page, the one the page pre-selects first.

    The agenda request needs a committee id and the meeting list doesn't carry one, so the
    caller tries these in turn until an agenda comes back.
    """
    page = request(MEETING_PAGE.format(base=base, meeting_id=meeting_id))
    options = COMMITTEE_OPTION.findall(page)
    if not options:
        return []
    selected = [value for value, is_selected, _label in options if is_selected]
    rest = [value for value, is_selected, _label in options if not is_selected]
    return selected + rest


def agenda_text(agenda_html: str) -> str:
    """Turn the agenda HTML into the outline the summarizer reads."""
    lines: list[str] = []
    for category, order, title in AGENDA_LINE.findall(agenda_html):
        if category:
            text = TAGS.sub(" ", category)
        else:
            text = f"{TAGS.sub(' ', order)} {TAGS.sub(' ', title)}"
        text = html.unescape(" ".join(text.split())).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def fetch_agenda(source: AgendaSource) -> str:
    """
    The agenda for one meeting, as text.

    Called by the pipeline instead of downloading a PDF, because BoardDocs has no PDF to
    download. Raises PipelineError when the meeting has no published agenda.
    """
    base = board_nsf_base(source.board)
    meeting_id = urllib.parse.parse_qs(urllib.parse.urlparse(source.page_url).query).get("id", [""])[0]
    if not meeting_id:
        raise PipelineError(f"no BoardDocs meeting id in {source.page_url}")

    committees = committee_ids(base, meeting_id)
    if not committees:
        raise PipelineError(f"no committee ids on the BoardDocs page for {meeting_id}")

    # A meeting belongs to one committee and the list doesn't say which, so each is tried until
    # one returns a real agenda. There are only a handful per board.
    for committee in committees:
        body = urllib.parse.urlencode({"id": meeting_id, "current_committee_id": committee}).encode()
        text = agenda_text(request(AGENDA_ENDPOINT.format(base=base), data=body, referer=f"{base}/Public"))
        if len(text) >= 200:
            return text
    raise PipelineError(f"BoardDocs published no agenda for meeting {meeting_id}")


def discover_boarddocs(context: BrowserContext, board: Board, limit: int) -> list[AgendaSource]:
    """
    List a BoardDocs board's public meetings, newest first.

    Unlike the PDF portals there is nothing to check per meeting here: the list says which
    meetings exist, and the agenda is fetched later, so `limit` applies to the list directly.
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
                content_type="boarddocs",
            )
        )

    sources.sort(key=lambda s: s.meeting_date or "", reverse=True)
    return sources[:limit]
