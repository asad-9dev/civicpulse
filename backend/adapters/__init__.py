"""
Discovery adapters, one per meeting-portal family.

Each adapter answers the same question — which meetings has this board published an agenda for —
and returns AgendaSource records the rest of the pipeline treats identically. Which one runs is
decided by the board's `platform` in data/boards_config.json.

    escribe      eSCRIBE portals, including boards that host eSCRIBE on their own domain
    civicweb     CivicWeb portals (*.civicweb.net)
    boarddocs    BoardDocs portals (go.boarddocs.com); agendas are HTML, not PDF
    generic_pdf  no portal software: crawl the board's meetings page for linked agenda PDFs
"""

from __future__ import annotations

from playwright.sync_api import BrowserContext

from boards import Board
from common import AgendaSource, PipelineError, log

from .boarddocs import discover_boarddocs
from .civicweb import discover_civicweb
from .escribe import discover_escribe
from .generic_pdf import discover_generic_pdf

__all__ = [
    "discover_agendas",
    "discover_boarddocs",
    "discover_civicweb",
    "discover_escribe",
    "discover_generic_pdf",
]


def discover_agendas(context: BrowserContext, board: Board, months_back: int, limit: int) -> list[AgendaSource]:
    """Meetings with a published agenda for one board, newest first."""
    if board.platform == "escribe":
        sources = discover_escribe(context, board, months_back, limit)
    elif board.platform == "civicweb":
        sources = discover_civicweb(context, board, limit)
    elif board.platform == "boarddocs":
        sources = discover_boarddocs(context, board, limit)
    elif board.platform == "generic_pdf":
        sources = discover_generic_pdf(context, board, limit)
    else:
        raise PipelineError(
            f"{board.short_name} has no agenda adapter (platform {board.platform!r}). "
            + (board.status_note or "Add an adapter in backend/adapters/ to cover this board.")
        )

    # A meeting linked twice on a calendar must not be summarized twice.
    unique = {s.pdf_url or s.page_url: s for s in sources if (s.pdf_url or s.page_url)}
    ordered = sorted(unique.values(), key=lambda s: s.meeting_date or "", reverse=True)
    log.info("%d meeting(s) with a published agenda; keeping %d", len(ordered), min(limit, len(ordered)))
    return ordered[:limit]
