"""
Fallback for boards with no meeting-portal software.

Plenty of boards just post agenda PDFs on an ordinary page. This renders that page, collects the
PDF links that look like agendas, and reads each one's date out of the link text or filename.

It is deliberately the last resort: the portals give structured meeting records, while this can
only guess from wording, so a board is only put on `generic_pdf` when no portal was found.
"""

from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from playwright.sync_api import BrowserContext
from playwright.sync_api import Error as PlaywrightError

from boards import Board
from common import RENDER_TIMEOUT_MS, AgendaSource, PipelineError, guess_committee, log, parse_meeting_date

# Every PDF link the rendered page shows, with the text around it.
READ_PDF_LINKS_JS = """
() => [...document.querySelectorAll('a[href]')]
  .filter((a) => /\\.pdf(\\?|$)/i.test(a.getAttribute('href') || ''))
  .map((a) => ({
    url: a.href,
    text: (a.innerText || '').trim().slice(0, 200),
    context: (a.closest('li, tr, article, section, div')?.innerText || '').trim().slice(0, 300),
  }));
"""

AGENDA_WORD = re.compile(r"agenda", re.I)
# Minutes and policy attachments are not agendas.
NOT_AGENDA = re.compile(r"minutes|policy|budget book|report card|newsletter|calendar of events", re.I)


def discover_generic_pdf(context: BrowserContext, board: Board, limit: int) -> list[AgendaSource]:
    """Agenda PDFs linked from the board's meetings page, newest first."""
    seed = board.agenda_portal
    if not seed:
        raise PipelineError(f"{board.short_name} has no seed_url to crawl")

    page = context.new_page()
    try:
        try:
            page.goto(seed, wait_until="domcontentloaded", timeout=RENDER_TIMEOUT_MS)
            page.wait_for_timeout(1500)  # let client-rendered lists appear
            links = page.evaluate(READ_PDF_LINKS_JS)
        except PlaywrightError as exc:
            raise PipelineError(f"{board.short_name}: could not load {seed}: {str(exc).splitlines()[0]}") from exc
    finally:
        page.close()

    log.info("%s meetings page links %d PDF(s)", board.short_name, len(links))

    sources: list[AgendaSource] = []
    for link in links:
        url = link["url"]
        label = " ".join(filter(None, [link["text"], link["context"]]))
        filename = urlparse(url).path.rsplit("/", 1)[-1]
        haystack = f"{label} {filename}"
        if not AGENDA_WORD.search(haystack) or NOT_AGENDA.search(link["text"] or filename):
            continue
        date = parse_meeting_date(haystack) or parse_meeting_date(filename)
        if not date:
            continue
        sources.append(
            AgendaSource(
                board=board,
                page_url=seed,
                committee_name=guess_committee(label, default=board.short_name + " Board Meeting"),
                meeting_date=date,
                pdf_url=urljoin(seed, url),
                content_type="pdf",
            )
        )

    sources.sort(key=lambda s: s.meeting_date or "", reverse=True)
    if not sources:
        log.warning("%s: no dated agenda PDFs found on %s", board.short_name, seed)
    return sources[:limit]
