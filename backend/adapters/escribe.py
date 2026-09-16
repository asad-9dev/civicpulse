"""
eSCRIBE meeting portals.

Used by boards on escribemeetings.com and by boards that put eSCRIBE on their own
domain (DDSB publishes at calendar.ddsb.ca). The meeting list is a table whose Agenda
column links straight to the agenda PDF.
"""

from __future__ import annotations

import re
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


def discover_escribe(context: BrowserContext, board: Board, months_back: int) -> list[AgendaSource]:
    """Read an eSCRIBE meeting list (calendar.ddsb.ca and most escribemeetings.com sites)."""
    page = context.new_page()
    try:
        open_calendar(page, board.agenda_portal)
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
