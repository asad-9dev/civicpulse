"""
Embed decoded agendas so they can be searched by meaning, not just by keyword.

The pipeline already extracts an agenda's full text on its way to a three-point summary. That
text is otherwise thrown away, so this keeps it: the agenda becomes a row in `documents`, split
into passages in `document_chunks`, each with a 768-dimensional embedding that
app/api/search/route.ts searches with the match_document_chunks function.

Storing is optional and never fatal. When Supabase or the Gemini key is missing, or the tables
haven't been created yet (backend/migrations/enable_pgvector.sql), the run says so and carries
on — a board's summaries reaching the site matters more than its search index.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from boards import Board
from common import PROJECT_ROOT, log

# gemini-embedding-001 is what this project's key can reach; text-embedding-004 returns 404.
# It defaults to 3072 dimensions and supports asking for fewer, so 768 is requested to match
# the vector(768) columns in enable_pgvector.sql.
EMBEDDING_MODEL = os.environ.get("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
EMBEDDING_DIMENSIONS = 768
EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent"

# Roughly 500 tokens per chunk. Agenda text is prose and item titles, where a token averages a
# little under four characters, so words are a steadier unit than characters here.
WORDS_PER_CHUNK = 380
# A little overlap so a passage split mid-item is still findable from either side.
WORDS_OVERLAP = 60
# Per-agenda ceiling: a 100-page agenda would otherwise be hundreds of embedding calls.
MAX_CHUNKS = 40

PAGE_MARKER = re.compile(r"^--- page \d+ ---$", re.MULTILINE)


class EmbeddingUnavailable(Exception):
    """Embeddings couldn't be produced or stored; the caller carries on without them."""


def chunk_text(text: str) -> list[str]:
    """
    Split an agenda into overlapping passages of about 500 tokens.

    Page markers from the PDF extractor are dropped: they carry no meaning and would otherwise
    be embedded as if they did.
    """
    cleaned = PAGE_MARKER.sub(" ", text)
    words = cleaned.split()
    if not words:
        return []

    chunks: list[str] = []
    step = max(1, WORDS_PER_CHUNK - WORDS_OVERLAP)
    for start in range(0, len(words), step):
        piece = " ".join(words[start : start + WORDS_PER_CHUNK]).strip()
        # A trailing sliver repeats what the previous chunk already covered.
        if len(piece.split()) < 40 and chunks:
            break
        if piece:
            chunks.append(piece)
        if len(chunks) >= MAX_CHUNKS:
            log.info("Agenda is long; embedding the first %d passages only", MAX_CHUNKS)
            break
    return chunks


def normalize(vector: list[float]) -> list[float]:
    """
    Scale to unit length.

    gemini-embedding-001 only returns normalized vectors at its full 3072 dimensions; a
    truncated 768 is not unit length, and cosine distance in Postgres assumes it is.
    """
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector] if length else vector


def embed(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list[float]:
    """One 768-dimensional embedding, normalized. Raises EmbeddingUnavailable on failure."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise EmbeddingUnavailable("GEMINI_API_KEY is not set")

    payload = json.dumps({
        "model": f"models/{EMBEDDING_MODEL}",
        "content": {"parts": [{"text": text}]},
        "outputDimensionality": EMBEDDING_DIMENSIONS,
        "taskType": task_type,
    }).encode("utf-8")
    request = urllib.request.Request(
        EMBEDDING_ENDPOINT.format(model=EMBEDDING_MODEL),
        data=payload,
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )

    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = json.loads(response.read())
            values = (body.get("embedding") or {}).get("values") or []
            if len(values) != EMBEDDING_DIMENSIONS:
                raise EmbeddingUnavailable(f"expected {EMBEDDING_DIMENSIONS} dimensions, got {len(values)}")
            return normalize(values)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:200].replace(key, "<key>")
            # 429 is the free tier's per-minute limit; waiting clears it.
            if exc.code == 429 and attempt < 2:
                time.sleep(20 * (attempt + 1))
                continue
            raise EmbeddingUnavailable(f"HTTP {exc.code} {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt < 2:
                time.sleep(10)
                continue
            raise EmbeddingUnavailable(str(exc)) from exc
    raise EmbeddingUnavailable("embedding failed after 3 attempts")


# ----------------------------------------------------------------------------------------------
# Storing
# ----------------------------------------------------------------------------------------------

def _supabase() -> tuple[str, str]:
    # Imported here so the scraper doesn't need Supabase settings unless embeddings are on.
    from seed_boards import credentials

    return credentials()


def _post(url: str, key: str, path: str, rows: list[dict], prefer: str) -> None:
    request = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        data=json.dumps(rows).encode("utf-8"),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=120).read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        if exc.code in (404, 400) and ("document" in detail or "schema cache" in detail):
            raise EmbeddingUnavailable(
                "the documents tables don't exist yet; run backend/migrations/enable_pgvector.py"
            ) from exc
        raise EmbeddingUnavailable(f"HTTP {exc.code} {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise EmbeddingUnavailable(str(exc)) from exc


def _delete(url: str, key: str, path: str) -> None:
    request = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        method="DELETE",
    )
    try:
        urllib.request.urlopen(request, timeout=60).read()
    except urllib.error.HTTPError as exc:
        if exc.code not in (404, 406):
            raise EmbeddingUnavailable(f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise EmbeddingUnavailable(str(exc)) from exc


def board_row_id(board: Board) -> int:
    """The board's numeric id in Supabase, which documents and document_chunks reference."""
    url, key = _supabase()
    request = urllib.request.Request(
        f"{url}/rest/v1/boards?select=id&slug=eq.{urllib.parse.quote(board.slug)}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            rows = json.loads(response.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        raise EmbeddingUnavailable(f"could not look up the board id: {exc}") from exc
    if not rows:
        raise EmbeddingUnavailable(f"{board.slug} has no row in the boards table; run backend/seed_boards.py")
    return int(rows[0]["id"])


def store_document(board: Board, board_id: int, record: dict, agenda_text: str) -> int:
    """
    Save one agenda's text and embeddings, replacing anything stored for it before.

    Returns how many passages were stored. Raises EmbeddingUnavailable if anything goes wrong,
    which the caller logs and moves past.
    """
    chunks = chunk_text(agenda_text)
    if not chunks:
        raise EmbeddingUnavailable("agenda had no text to embed")

    url, key = _supabase()
    document_id = record["id"]

    _post(url, key, "documents?on_conflict=id", [{
        "id": document_id,
        "board_id": board_id,
        "title": record["title"],
        "meeting_date": record["meetingDate"],
        "url": record.get("originalPdfUrl"),
    }], prefer="resolution=merge-duplicates,return=minimal")

    # Re-summarising a meeting re-chunks it, so old passages go before new ones land.
    _delete(url, key, f"document_chunks?document_id=eq.{urllib.parse.quote(document_id)}")

    rows = []
    for index, chunk in enumerate(chunks):
        rows.append({
            "document_id": document_id,
            "board_id": board_id,
            "chunk_index": index,
            "content": chunk,
            "embedding": embed(chunk),
        })
    _post(url, key, "document_chunks", rows, prefer="return=minimal")
    log.info("Embedded %d passage(s) of %s", len(rows), document_id)
    return len(rows)

