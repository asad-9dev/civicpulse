"""
eSCRIBE meeting portals, in both the layouts eSCRIBE ships.

**Classic** (calendar.ddsb.ca, events.kprschools.ca, calendar.publicboard.ca): the server sends
a table of meetings, and the Agenda column links straight to the agenda PDF.

**Modern** (pub-*.escribemeetings.com): a client-rendered app. Its /meetings page is a shell
whose lists start empty, so the meetings live at MeetingsCalendarView.aspx and arrive as
`.calendar-item` nodes after the scripts run — nothing is in the initial HTML. Each item links
to a Meeting.aspx page carrying that meeting's agenda.

Which layout a board uses is detected rather than configured, so a board that gets upgraded
keeps working without its registry entry changing.
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

READ_MEETING_ROWS_JS = """
() => {
  const agendaHeader = [...document.querySelectorAll('th')]
    .find((th) => th.innerText.trim().toLowerCase() === 'agenda');
  return [...document.querySelectorAll('td[headers="c1"]')].map((dateCell) => {
    const row = dateCell.closest('tr');
    const meeting = row.querySelector('td[headers="c2"] a[href]');
    const agenda =
      (agendaHeader && row.querySelector(`td[headers="${agendaHeader.id}"] a[href]`)) ||
      row.querySelector('a[aria-label^="View Agenda"]');
    return {
      when: dateCell.innerText.trim(),
      title: meeting ? meeting.innerText.trim() : '',
      meetingUrl: meeting ? meeting.href : null,
      agendaUrl: agenda ? agenda.href : null,
    };
  });
}
"""


def wait_for_calendar(page: Page) -> None:
    """
    Block until the meeting table has rendered: its "Meeting Date" header and at least one row.
    (Waiting for network idle doesn't work here; the page keeps a connection open.)
    """
    try:
        page.wait_for_selector("th#c1", state="attached", timeout=RENDER_TIMEOUT_MS)
        page.wait_for_selector("td[headers='c1']", state="attached", timeout=RENDER_TIMEOUT_MS)
    except PlaywrightTimeoutError as exc:
        raise PipelineError(f"The meeting calendar did not render within {RENDER_TIMEOUT_MS // 1000}s ({page.url}).") from exc


def open_calendar(page: Page, url: str, attempts: int = 3) -> None:
    """Load a calendar page and wait for its meeting table, retrying slow or failed loads."""
    for attempt in range(1, attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
            wait_for_calendar(page)
            return
        except (PipelineError, PlaywrightError) as exc:
            reason = str(exc).strip().splitlines()[0]
            if attempt == attempts:
                # Say what the page actually showed: a block or challenge page reads very
                # differently from a slow one.
                try:
                    seen = f'title "{page.title()}", text "{" ".join(page.inner_text("body").split())[:160]}"'
                except PlaywrightError:
                    seen = "page content unavailable"
                raise PipelineError(f"The meeting calendar didn't load after {attempts} tries ({url}): {reason}; {seen}") from exc
            log.warning("Calendar didn't load (try %d of %d): %s; retrying", attempt, attempts, reason)
            page.wait_for_timeout(10_000 * attempt)


def discover_escribe(context: BrowserContext, board: Board, months_back: int, limit: int = 10) -> list[AgendaSource]:
    """
    Read an eSCRIBE meeting list, whichever layout the board is on.

    The classic layout is tried first because its table is in the server's HTML and costs one
    request; when that table never appears, the portal is the client-rendered kind.
    """
    page = context.new_page()
    try:
        try:
            open_calendar(page, board.agenda_portal)
        except PipelineError:
            page.close()
            log.info("%s has no server-rendered meeting table; reading it as a client-rendered portal", board.short_name)
            return discover_escribe_modern(context, board, limit)
        # The listing runs from the start of the current month onward. Each "‹" link moves
        # the start back one month (its URL carries a StartDate and a per-page token).
        for _ in range(months_back):
            # Not every eSCRIBE calendar has a previous-month control. Asking a locator that
            # matches nothing for an attribute blocks for the full timeout, so check first and
            # stop paging when there is nothing to page to.
            previous_link = page.locator("table a", has_text="‹").first
            try:
                if previous_link.count() == 0:
                    break
                previous = previous_link.get_attribute("href", timeout=DOCUMENT_TIMEOUT_MS)
            except PlaywrightError:
                log.info("%s calendar has no previous-month link; using the current listing", board.short_name)
                break
            if not previous:
                break
            open_calendar(page, urljoin(page.url, previous))
        rows = page.evaluate(READ_MEETING_ROWS_JS)
    finally:
        page.close()

    log.info("%s calendar lists %d meeting(s)", board.short_name, len(rows))
    return [
        AgendaSource(
            board=board,
            page_url=row["meetingUrl"] or row["agendaUrl"],
            committee_name=guess_committee(row["title"], default=row["title"]),
            meeting_date=parse_meeting_date(row["when"]),
            pdf_url=row["agendaUrl"],
        )
        for row in rows
        if row["agendaUrl"]
    ]


# --------------------------------------------------------------------------------------------
# Modern eSCRIBE: client-rendered
# --------------------------------------------------------------------------------------------

# The modern portal keeps its meeting list at MeetingsCalendarView.aspx; /meetings is a shell.
CALENDAR_VIEW = "MeetingsCalendarView.aspx"
# One meeting on the rendered calendar.
MODERN_ITEM = ".calendar-item"
# The agenda document on a meeting's own page. eSCRIBE serves documents through FileStream.ashx.
MODERN_AGENDA_LINK = 'a[href*="FileStream"]'

READ_MODERN_ITEMS_JS = """
() => [...document.querySelectorAll('.calendar-item')].map((item) => {
  const link = item.querySelector('a[href*="Meeting.aspx?Id="]');
  const title = item.querySelector('.meeting-title, .meeting-title-heading');
  return {
    title: (title ? title.innerText : '').trim(),
    // The date sits in the item's text, e.g. "Wednesday, September 23, 2026 @ 10:00 AM".
    when: (item.innerText || '').replace(/\\s+/g, ' ').trim(),
    meetingUrl: link ? link.href : null,
  };
});
"""

# On a meeting page the agenda is either a FileStream document link or rendered agenda text.
READ_MODERN_AGENDA_JS = """
() => {
  const doc = [...document.querySelectorAll('a[href*="FileStream"]')]
    .find((a) => /agenda/i.test((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '')));
  return doc ? doc.href : null;
}
"""


def calendar_view_url(seed: str) -> str:
    """The modern portal's meeting list, derived from whatever seed the registry holds."""
    root = seed.split("?")[0].rstrip("/")
    if root.lower().endswith(CALENDAR_VIEW.lower()):
        return seed
    # .../meetings -> .../MeetingsCalendarView.aspx
    base = root.rsplit("/", 1)[0] if root.lower().endswith("/meetings") else root
    return f"{base}/{CALENDAR_VIEW}"


def looks_modern(page: Page) -> bool:
    """A rendered calendar item means the client-side app, not the server-rendered table."""
    return page.locator(MODERN_ITEM).count() > 0


def discover_escribe_modern(context: BrowserContext, board: Board, limit: int) -> list[AgendaSource]:
    """
    Read a client-rendered eSCRIBE portal.

    Nothing here exists in the initial HTML, so every read waits for the nodes the app creates
    rather than parsing what the server sent.
    """
    page = context.new_page()
    try:
        url = calendar_view_url(board.agenda_portal)
        page.goto(url, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
        try:
            page.wait_for_selector(MODERN_ITEM, state="attached", timeout=RENDER_TIMEOUT_MS)
        except PlaywrightTimeoutError:
            # An empty calendar is a real answer: the board has published no meetings here.
            log.info("%s calendar rendered no meetings (%s)", board.short_name, url)
            return []
        rows = page.evaluate(READ_MODERN_ITEMS_JS)
        log.info("%s calendar lists %d meeting(s)", board.short_name, len(rows))

        listed: list[AgendaSource] = []
        for row in rows:
            title = (row["title"] or "").strip()
            if not title or not row["meetingUrl"]:
                continue
            date = parse_meeting_date(row["when"] or "")
            if not date:
                continue
            listed.append(
                AgendaSource(
                    board=board,
                    page_url=row["meetingUrl"],
                    committee_name=guess_committee(title, default=title),
                    meeting_date=date,
                    pdf_url=None,
                )
            )
        listed.sort(key=lambda s: s.meeting_date or "", reverse=True)

        found: list[AgendaSource] = []
        for source in listed:
            if len(found) >= limit:
                break
            try:
                page.goto(source.page_url, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
                try:
                    page.wait_for_selector(MODERN_AGENDA_LINK, state="attached", timeout=DOCUMENT_TIMEOUT_MS)
                except PlaywrightTimeoutError:
                    # Agendas appear a few days before a meeting; upcoming ones often have none.
                    log.info("No agenda posted yet for %s (%s)", source.committee_name, source.meeting_date)
                    continue
                agenda_url = page.evaluate(READ_MODERN_AGENDA_JS)
            except PlaywrightError as exc:
                log.warning("Couldn't open %s (%s): %s", source.committee_name, source.meeting_date, exc)
                continue
            if agenda_url:
                found.append(replace(source, pdf_url=agenda_url))
        return found
    finally:
        page.close()
