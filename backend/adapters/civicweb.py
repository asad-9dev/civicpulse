"""
CivicWeb meeting portals (*.civicweb.net).

The schedule page lists several months at once; each meeting's own page carries the agenda
document, added by the page's own script a moment after load.
"""

from __future__ import annotations

import re
from dataclasses import replace
from urllib.parse import urljoin

from playwright.sync_api import BrowserContext, Page
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from boards import Board
from common import (
    AgendaSource,
    DOCUMENT_TIMEOUT_MS,
    PipelineError,
    RENDER_TIMEOUT_MS,
    guess_committee,
    log,
    parse_meeting_date,
)

# Runs inside a rendered CivicWeb schedule page. Every meeting on the calendar is a link to
# MeetingInformation.aspx whose text ends with the date ("Board Meeting - Public Session -
# 15 Sep 2026"); the same meeting is linked several times (calendar cell plus the side lists),
# so the caller dedupes by meeting id.
READ_CIVICWEB_MEETINGS_JS = """
() => {
  const links = [...document.querySelectorAll('a[href*="MeetingInformation.aspx"]')];
  return links.map((link) => ({ title: link.innerText.trim(), meetingUrl: link.href }));
}
"""

# On a CivicWeb meeting page the agenda is one or two links: "Agenda Package" is the full
# document set (what DDSB's eSCRIBE Agenda link gives), "Agenda" is the order of business alone.
# textContent rather than innerText, which is empty for a link the page hasn't laid out yet.
# a.href (not the attribute) keeps the query string that makes the response a PDF.
READ_CIVICWEB_AGENDA_JS = """
() => {
  const find = (label) =>
    [...document.querySelectorAll('a[href*="/document/"]')]
      .find((a) => (a.textContent || '').trim().toLowerCase() === label);
  const link = find('agenda package') || find('agenda');
  return link ? link.href : null;
}
"""

# The meeting page ships with an unlabelled /document/ link and grows the labelled "Agenda" and
# "Agenda Package" ones a moment later, so waiting for any /document/ link returns too early.
# This waits for a labelled one, and times out on meetings whose agenda isn't posted yet.
AWAIT_CIVICWEB_AGENDA_JS = """
() => [...document.querySelectorAll('a[href*="/document/"]')]
        .some((a) => ['agenda', 'agenda package'].includes((a.textContent || '').trim().toLowerCase()))
"""

# ".../MeetingInformation.aspx?Org=Cal&Id=2610" -> "2610"; the query key's case varies by link.
CIVICWEB_MEETING_ID = re.compile(r"[?&]id=(\d+)", re.IGNORECASE)
# "Board Meeting - Public Session - 15 Sep 2026" -> drop the trailing date.
CIVICWEB_TRAILING_DATE = re.compile(r"\s*-\s*\d{1,2}\s+\w+\s+20\d{2}\s*$")


def wait_for_civicweb(page: Page) -> None:
    """Block until the CivicWeb schedule has rendered at least one meeting link."""
    try:
        page.wait_for_selector('a[href*="MeetingInformation.aspx"]', state="attached", timeout=RENDER_TIMEOUT_MS)
    except PlaywrightTimeoutError as exc:
        raise PipelineError(f"The meeting schedule did not render within {RENDER_TIMEOUT_MS // 1000}s ({page.url}).") from exc


def open_civicweb_schedule(page: Page, url: str, attempts: int = 3) -> None:
    """Load a CivicWeb schedule page and wait for its meeting links, retrying slow loads."""
    for attempt in range(1, attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
            wait_for_civicweb(page)
            return
        except (PipelineError, PlaywrightError) as exc:
            reason = str(exc).strip().splitlines()[0]
            if attempt == attempts:
                try:
                    seen = f'title "{page.title()}"'
                except PlaywrightError:
                    seen = "page content unavailable"
                raise PipelineError(f"The meeting schedule didn't load after {attempts} tries ({url}): {reason}; {seen}") from exc
            log.warning("Schedule didn't load (try %d of %d): %s; retrying", attempt, attempts, reason)
            page.wait_for_timeout(10_000 * attempt)


def discover_civicweb(context: BrowserContext, board: Board, limit: int) -> list[AgendaSource]:
    """
    Read a CivicWeb portal (yrdsb.civicweb.net and other *.civicweb.net sites).

    The schedule page lists several months at once, so there's no month-by-month paging to do.
    Each meeting's own page has to be opened to find its agenda document, which is the slow
    part, so only the newest `limit` meetings are visited.
    """
    page = context.new_page()
    try:
        open_civicweb_schedule(page, board.agenda_portal)
        rows = page.evaluate(READ_CIVICWEB_MEETINGS_JS)

        listed: dict[str, AgendaSource] = {}
        for row in rows:
            title = (row["title"] or "").strip()
            meeting_id = CIVICWEB_MEETING_ID.search(row["meetingUrl"] or "")
            # Private sessions publish no agenda, so they're dropped before any page is opened.
            if not title or not meeting_id or "private session" in title.lower():
                continue
            date = parse_meeting_date(title)
            if not date:
                continue
            committee = CIVICWEB_TRAILING_DATE.sub("", title).strip()
            listed.setdefault(
                meeting_id[1],
                AgendaSource(
                    board=board,
                    page_url=row["meetingUrl"],
                    committee_name=guess_committee(committee, default=committee),
                    meeting_date=date,
                    pdf_url=None,
                ),
            )
        log.info("%s schedule lists %d public meeting(s)", board.short_name, len(listed))

        found: list[AgendaSource] = []
        for source in sorted(listed.values(), key=lambda s: s.meeting_date or "", reverse=True):
            if len(found) >= limit:
                break
            try:
                page.goto(source.page_url, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
                page.wait_for_function(AWAIT_CIVICWEB_AGENDA_JS, timeout=DOCUMENT_TIMEOUT_MS)
                agenda_url = page.evaluate(READ_CIVICWEB_AGENDA_JS)
            except PlaywrightTimeoutError:
                # Agendas are posted a few days before the meeting; older meetings keep only
                # their minutes. Either way there's nothing here to summarize.
                log.info("No agenda posted for %s (%s)", source.committee_name, source.meeting_date)
                continue
            except PlaywrightError as exc:
                log.warning("Couldn't open %s (%s): %s", source.committee_name, source.meeting_date, exc)
                continue
            if agenda_url:
                found.append(replace(source, pdf_url=agenda_url))
        return found
    finally:
        page.close()
