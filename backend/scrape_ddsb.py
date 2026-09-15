"""
DDSB CivicPulse: agenda scraper and summarizer (prototype scaffold).

Pipeline
    1. discover  - open the DDSB meeting calendar (calendar.ddsb.ca) in headless Chromium
                   with Playwright, wait for the meeting table to render, and read each
                   meeting's direct agenda PDF link.
    2. download  - save those PDFs to backend/agendas/ through the same browser context.
    3. extract   - pull each PDF's text with pdfplumber (or simulate it with --offline).
    4. summarize - turn 100+ pages of agenda text into the CivicPulse JSON shape,
                   with Claude (--summarizer claude) or a keyword-based dummy.
    5. publish   - write the records; --write-public upserts them into
                   public/data/meetings.json, which the Next.js app reads on every request.

Setup (once)
    pip install -r backend/requirements.txt
    python -m playwright install chromium

Examples
    python backend/scrape_ddsb.py --offline                 # no network, dummy summaries
    python backend/scrape_ddsb.py --limit 3                 # live calendar, dummy summaries
    python backend/scrape_ddsb.py --months-back 3 --summarizer claude --write-public
    python backend/scrape_ddsb.py --pdf backend/agendas/<file>.pdf --summarizer claude
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

from dotenv import load_dotenv
from playwright.sync_api import BrowserContext, Page, sync_playwright
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

CALENDAR_URL = "https://calendar.ddsb.ca/meetings"
# Public landing page; the source link for offline demo records.
BOARD_MEETINGS_URL = "https://www.ddsb.ca/about-ddsb/board-of-trustees/board-meetings/"
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
PUBLIC_MEETINGS_JSON = PROJECT_ROOT / "public" / "data" / "meetings.json"
OUTPUT_DIR = BACKEND_DIR / "output"
AGENDAS_DIR = BACKEND_DIR / "agendas"

USER_AGENT = "CivicPulse/0.1 (independent civic prototype; summarizes public DDSB agendas)"
RENDER_TIMEOUT_MS = 30_000
DOWNLOAD_TIMEOUT_MS = 120_000

# The municipalities DDSB serves. The web app's filter chips cover the first five.
DDSB_TOWNS = ["Ajax", "Pickering", "Whitby", "Oshawa", "Uxbridge", "Brock", "Scugog"]
CATEGORIES = ["Boundary Review", "Transport", "Policy", "Budget"]

CLAUDE_MODEL = "claude-opus-5"

# Gemini models to try in order (override with GEMINI_MODELS="a,b"). Each model has its own
# free-tier quota, so when the first is used up for the day the next one takes over.
GEMINI_MODELS = [
    m.strip()
    for m in os.environ.get("GEMINI_MODELS", "gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",")
    if m.strip()
]
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GEMINI_PAUSE_SECONDS = 5  # between agendas, to stay under free-tier requests-per-minute

log = logging.getLogger("civicpulse")


class PipelineError(Exception):
    """A step failed in a way the operator should hear about."""


@dataclass
class AgendaSource:
    """One meeting's agenda, as listed on the DDSB meeting calendar."""

    page_url: str  # the meeting's page on the calendar (or the local PDF path)
    committee_name: str
    meeting_date: str | None  # ISO yyyy-mm-dd when we can parse it
    pdf_url: str | None = None  # direct link from the calendar's Agenda column


# --------------------------------------------------------------------------- #
# 1. Discover
# --------------------------------------------------------------------------- #

MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"
DATE_PATTERNS = [
    (re.compile(r"(20\d{2})-(\d{2})-(\d{2})"), lambda m: f"{m[1]}-{m[2]}-{m[3]}"),
    (
        re.compile(rf"({MONTHS})\.?\s+(\d{{1,2}}),?\s+(20\d{{2}})", re.IGNORECASE),
        lambda m: datetime.strptime(f"{m[1]} {m[2]} {m[3]}", "%B %d %Y").strftime("%Y-%m-%d"),
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


# Runs inside the rendered calendar. Each meeting row has its date in td[headers="c1"] and
# its page link in td[headers="c2"]; attachment columns (Agenda, Minutes, Live Stream) are
# keyed to a <th> id, so the Agenda column is located by its header text, not its position.
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


def discover_agendas(context: BrowserContext, months_back: int, limit: int) -> list[AgendaSource]:
    """List meetings on the rendered calendar and return those with a published agenda, newest first."""
    page = context.new_page()
    try:
        open_calendar(page, CALENDAR_URL)
        # The listing runs from the start of the current month onward. Each "‹" link moves
        # the start back one month (its URL carries a StartDate and a per-page token).
        for _ in range(months_back):
            previous = page.locator("table a", has_text="‹").first.get_attribute("href")
            if not previous:
                break
            open_calendar(page, urljoin(page.url, previous))
        rows = page.evaluate(READ_MEETING_ROWS_JS)
    finally:
        page.close()

    sources = [
        AgendaSource(
            page_url=row["meetingUrl"] or row["agendaUrl"],
            committee_name=guess_committee(row["title"], default=row["title"]),
            meeting_date=parse_meeting_date(row["when"]),
            pdf_url=row["agendaUrl"],
        )
        for row in rows
        if row["agendaUrl"]
    ]
    unique = {s.pdf_url: s for s in sources}
    ordered = sorted(unique.values(), key=lambda s: s.meeting_date or "", reverse=True)
    log.info(
        "Calendar lists %d meeting(s), %d with a published agenda; keeping %d",
        len(rows), len(ordered), min(limit, len(ordered)),
    )
    return ordered[:limit]


# --------------------------------------------------------------------------- #
# 2. Download and extract
# --------------------------------------------------------------------------- #

def agenda_filename(source: AgendaSource) -> str:
    """e.g. 2026-09-09-committee-of-the-whole-standing-1b62b947.pdf.

    The suffix is the start of the calendar's document id, so a revised agenda that the
    board reposts under a new id is downloaded again instead of served from the cache.
    """
    doc_id = urlparse(source.pdf_url or "").path.rstrip("/").split("/")[-1]
    return f"{source.meeting_date or 'undated'}-{slugify(source.committee_name, 40)}-{slugify(doc_id, 8)}.pdf"


def download_agenda_pdf(context: BrowserContext, source: AgendaSource) -> Path:
    """Save one agenda PDF to backend/agendas/, reusing the file if it's already there."""
    AGENDAS_DIR.mkdir(parents=True, exist_ok=True)
    destination = AGENDAS_DIR / agenda_filename(source)
    if destination.exists() and destination.stat().st_size > 0:
        log.info("Using cached %s", destination.name)
        return destination

    # The Agenda link responds with the PDF itself (the browser treats it as a download),
    # so fetch it with the browser context's HTTP client: same cookies and user agent.
    response = context.request.get(source.pdf_url, timeout=DOWNLOAD_TIMEOUT_MS)
    if not response.ok:
        raise PipelineError(f"agenda download failed with HTTP {response.status}")
    body = response.body()
    if not body.startswith(b"%PDF-"):
        raise PipelineError(f"expected a PDF but got {response.headers.get('content-type', 'unknown content')}")
    destination.write_bytes(body)
    log.info("Downloaded %s (%.1f MB)", destination.name, len(body) / 1e6)
    return destination


def extract_text_with_pdfplumber(pdf_path: Path) -> str:
    """Pull the text layer out of every page, keeping page markers so summaries can cite pages."""
    import pdfplumber  # imported lazily: only needed when a real PDF is processed

    pages: list[str] = []
    with pdfplumber.open(pdf_path) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            pages.append(f"--- page {number} ---\n{page.extract_text() or ''}")
    text = "\n\n".join(pages)
    if len(text.strip()) < 200:
        log.warning("%s has almost no text layer; it may be scanned and need OCR", pdf_path.name)
    return text


def simulate_pdfplumber_extraction(source: AgendaSource) -> str:
    """
    Dummy stand-in for extract_text_with_pdfplumber(): returns agenda-shaped text so
    the rest of the pipeline can run with --offline (no browser, no network).
    """
    date = source.meeting_date or "2026-09-08"
    return f"""--- page 1 ---
DURHAM DISTRICT SCHOOL BOARD
{source.committee_name.upper()} - AGENDA
{date} 7:00 p.m. Boardroom, Education Centre, Whitby

1. Call to Order
2. Land Acknowledgement
3. Declarations of Interest
4. Approval of Agenda
--- page 47 ---
7. Staff Reports
7.3 Draft Attendance Boundaries: Seaton Elementary School (opening September 2027)
Staff recommend new elementary attendance boundaries for the Seaton community in north
Pickering. Approximately 640 students currently attending three schools in Pickering and
Ajax would be redirected. A public consultation survey is open until October 9, with a
final vote expected at the October 20 Regular Board Meeting. Students currently in Grade 7
may remain at their current school through Grade 8 (grandparenting).
--- page 63 ---
7.4 2026-27 Student Transportation Update
Route consolidation continues in Uxbridge; bell times at selected schools in Whitby and
Oshawa are under review with the transportation consortium.
--- page 88 ---
8. Policy and Procedure Review
8.1 Procedure: Personal Mobile Devices, no changes proposed at this meeting.
9. Information Items
10. Adjournment
"""


# --------------------------------------------------------------------------- #
# 3. Summarize
# --------------------------------------------------------------------------- #

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Headline under 90 characters about the item that matters most to families."},
        "urgencyScore": {"type": "integer", "description": "1 = informational ... 5 = families must act soon."},
        "townsAffected": {"type": "array", "items": {"type": "string", "enum": DDSB_TOWNS}},
        "category": {"type": "string", "enum": CATEGORIES},
        "executiveSummary": {"type": "array", "items": {"type": "string"}, "description": "1 to 3 one-sentence bullets."},
        "studentParentImpact": {"type": "string"},
        "policyChanges": {"type": "string"},
    },
    "required": [
        "title",
        "urgencyScore",
        "townsAffected",
        "category",
        "executiveSummary",
        "studentParentImpact",
        "policyChanges",
    ],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You turn Durham District School Board (DDSB) trustee meeting agendas into short, \
plain-language briefings for students and parents in Durham Region, Ontario.

Write for a busy parent or a Grade 9 student: short sentences, no board jargon, no acronyms \
without explanation. Be concrete about dates, deadlines, grades and neighbourhoods when the \
agenda states them, and never add facts that are not in the agenda. Focus on the single agenda \
item with the biggest consequence for families; mention others only if they share a deadline.

An agenda is published before the meeting: it says what trustees will discuss or vote on, not \
what they decided. Never state an outcome the agenda doesn't contain. Procedural items (call to \
order, land acknowledgement, approving minutes, adjournment) aren't news; skip them.

Mention a way to take part (attending, a consultation, a deadline) only if the agenda text itself \
gives it. Don't mention livestreams, websites, phone numbers or other details the agenda doesn't \
include."""


def summary_prompt(agenda_text: str, source: AgendaSource) -> str:
    """The user message shared by the Claude and Gemini summarizers."""
    today = datetime.now().strftime("%Y-%m-%d")
    if not source.meeting_date:
        timing = "The meeting date is unknown; describe what is on the agenda without saying when."
    elif source.meeting_date < today:
        timing = (
            f"This meeting already took place on {source.meeting_date} (today is {today}). Write in the past "
            "tense about what was on the agenda (\"Trustees were set to vote on...\"). The outcome isn't in the "
            "agenda, so don't state one, and don't invite readers to attend."
        )
    else:
        timing = (
            f"This meeting is on {source.meeting_date} (today is {today}). Describe what's coming up "
            "(\"Trustees will vote on...\")."
        )
    return f"""Committee: {source.committee_name}
Meeting date: {source.meeting_date or "unknown"}
Source: {source.pdf_url or source.page_url}
{timing}

Summarize the agenda below into:
- title: a headline under 90 characters about the item that matters most to families
- urgencyScore: 1 (informational) to 5 (families must act soon, e.g. an open consultation or a vote on where students attend school)
- townsAffected: which of {", ".join(DDSB_TOWNS)} are affected (list all of them for board-wide items)
- category: the closest of {", ".join(CATEGORIES)}
- executiveSummary: up to 3 bullets, one sentence each, under 25 words; fewer if the agenda has fewer substantive items
- studentParentImpact: one paragraph of 60-120 words on what this could change for students and parents, and what they can do if the agenda gives a way (for example attend the public session, or respond to a consultation it mentions)
- policyChanges: one or two sentences naming any policy or procedure up for creation, revision or rescinding, or saying none is on this agenda

<agenda>
{agenda_text}
</agenda>"""


def summarize_with_claude(agenda_text: str, source: AgendaSource) -> dict:
    """Summarize one agenda with Claude, constrained to SUMMARY_SCHEMA via structured outputs."""
    import anthropic

    # Anthropic() resolves credentials itself: ANTHROPIC_API_KEY (e.g. from backend/.env) or an `ant auth login` profile.
    client = anthropic.Anthropic()
    prompt = summary_prompt(agenda_text, source)

    try:
        # Streaming keeps long agendas (100+ pages) clear of HTTP timeouts. The server-side
        # fallback retries on another model if this one declines the request.
        with client.beta.messages.stream(
            model=CLAUDE_MODEL,
            max_tokens=32000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
            output_config={"format": {"type": "json_schema", "schema": SUMMARY_SCHEMA}},
        ) as stream:
            message = stream.get_final_message()
    except anthropic.AuthenticationError as exc:
        raise PipelineError("Claude rejected the credentials. Set ANTHROPIC_API_KEY in backend/.env or run `ant auth login`.") from exc
    except anthropic.RateLimitError as exc:
        raise PipelineError("Rate limited by the Claude API; wait a minute and re-run.") from exc
    except anthropic.APIStatusError as exc:
        raise PipelineError(f"Claude API error {exc.status_code}: {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise PipelineError("Could not reach the Claude API. Check your network connection.") from exc

    if message.stop_reason == "refusal":
        raise PipelineError(f"Claude declined to summarize {source.page_url}.")
    if message.stop_reason == "max_tokens":
        raise PipelineError(f"Summary for {source.page_url} was cut off (max_tokens).")

    text = next((block.text for block in message.content if block.type == "text"), None)
    if text is None:
        raise PipelineError(f"Claude returned no text for {source.page_url}.")
    return json.loads(text)


class GeminiUnavailable(Exception):
    """Gemini couldn't produce a summary (no key, quota used up, outage); the caller falls back."""


def _gemini_retry_delay(error_body: str) -> float | None:
    """Seconds Google asks us to wait on a 429, or None when it's a daily quota (no point waiting)."""
    try:
        details = json.loads(error_body).get("error", {}).get("details", [])
    except ValueError:
        return None
    for detail in details:
        for violation in detail.get("violations", []):
            if "PerDay" in violation.get("quotaId", ""):
                return None
    for detail in details:
        delay = detail.get("retryDelay")  # e.g. "37s"
        if isinstance(delay, str) and delay.endswith("s"):
            try:
                return float(delay[:-1])
            except ValueError:
                pass
    return 20.0


def _gemini_text(response: dict) -> tuple[str | None, str]:
    """The model's answer text (skipping any thought parts), and why there's none if so."""
    candidates = response.get("candidates") or []
    if not candidates:
        return None, f"no candidates (prompt feedback: {response.get('promptFeedback')})"
    candidate = candidates[0]
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    return (text or None), f"finishReason={candidate.get('finishReason')}"


def summarize_with_gemini(agenda_text: str, source: AgendaSource) -> dict:
    """
    Summarize one agenda with Google's Gemini API (free tier works), as JSON matching SUMMARY_SCHEMA.

    Per-minute rate limits (HTTP 429 with a retry delay) are waited out and retried; a used-up
    daily quota moves on to the next model in GEMINI_MODELS. If every model fails, raises
    GeminiUnavailable so the caller can fall back to the built-in summarizer.
    """
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise GeminiUnavailable("GEMINI_API_KEY is not set")

    payload = json.dumps({
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": summary_prompt(agenda_text, source)}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
            "responseJsonSchema": SUMMARY_SCHEMA,
        },
    }).encode("utf-8")

    problems = []
    for model in GEMINI_MODELS:
        for attempt in range(3):
            request = urllib.request.Request(
                GEMINI_ENDPOINT.format(model=model),
                data=payload,
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    body = json.loads(response.read())
            except urllib.error.HTTPError as exc:
                error_body = exc.read().decode("utf-8", errors="replace")
                if exc.code == 429:
                    delay = _gemini_retry_delay(error_body)
                    if delay is not None and delay <= 60 and attempt < 2:
                        log.info("Gemini %s rate-limited; retrying in %.0fs", model, delay)
                        time.sleep(delay + 1)
                        continue
                    problems.append(f"{model}: quota used up (429)")
                elif exc.code in (500, 502, 503, 504) and attempt < 2:
                    time.sleep(10 * (attempt + 1))
                    continue
                else:
                    message = error_body[:300].replace(key, "<key>")
                    problems.append(f"{model}: HTTP {exc.code} {message}")
                break
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < 2:
                    time.sleep(10)
                    continue
                problems.append(f"{model}: {exc}")
                break

            text, why = _gemini_text(body)
            if text is None:
                problems.append(f"{model}: empty answer ({why})")
                break
            try:
                summary = json.loads(text)
            except ValueError:
                problems.append(f"{model}: answer wasn't valid JSON ({why})")
                break
            log.info("Summarized with %s", model)
            return summary
        if problems:
            log.info("Gemini %s skipped: %s", model, problems[-1].splitlines()[0][:200])
    raise GeminiUnavailable("; ".join(problems) or "no Gemini models configured")


KEYWORDS = {
    "Boundary Review": ("boundary", "boundaries", "attendance area", "accommodation", "new school"),
    "Transport": ("transportation", "bus", "route", "bell time"),
    "Budget": ("budget", "estimates", "financial", "funding", "deficit"),
    "Policy": ("policy", "procedure", "code of conduct"),
}


# Sub-items in the order of business: "7.3 Title", or as DDSB agendas print them,
# "(a) Title" (board and committee meetings) and "• Title" (SEAC).
AGENDA_ITEM = re.compile(r"^\s*(?:\d+\.\d+|\([a-z]\)|•)\s+(.+)$", re.MULTILINE)
PROCEDURAL_ITEMS = ("minutes", "call to order", "adjournment", "land acknowledgement", "approve agenda")


def agenda_outline(agenda_text: str) -> str:
    """The order of business: everything up to "N. Adjournment", before attached reports begin."""
    end = re.search(r"^\s*\d+\.\s+Adjournment", agenda_text, re.IGNORECASE | re.MULTILINE)
    return agenda_text[: end.end()] if end else agenda_text


def clean_item_title(raw: str) -> str:
    """"2627:02, Audit Committee Trustee Member Vacancy 6" -> "Audit Committee Trustee Member Vacancy"."""
    title = re.sub(r"^\d{4}:\d{2},\s*", "", raw.strip())  # memo numbers
    return re.sub(r"(?:\s+(?:Verbal|Presentation|\d+(?:-\d+)?))+$", "", title).strip()  # format labels, page refs


def agenda_items(agenda_text: str) -> list[tuple[str, str]]:
    """(title, section text) for each substantive item in the order of business."""
    outline = agenda_outline(agenda_text)
    matches = list(AGENDA_ITEM.finditer(outline))
    items = []
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(outline)
        title = clean_item_title(match[1])
        if title and not any(p in title.lower() for p in PROCEDURAL_ITEMS):
            items.append((title, outline[match.start():end]))
    return items


def summarize_dummy(agenda_text: str, source: AgendaSource) -> dict:
    """Keyword-based placeholder with the same output shape as summarize_with_claude()."""
    items = agenda_items(agenda_text)
    # Judge category, towns and urgency from the first substantive item's section only;
    # the whole agenda mentions every town (e.g. the boardroom address in Whitby).
    headline, focus = items[0] if items else (f"{source.committee_name} agenda", agenda_outline(agenda_text))
    focus = focus.lower()

    scores = {c: sum(focus.count(k) for k in KEYWORDS[c]) for c in CATEGORIES}
    category = max(scores, key=scores.get) if any(scores.values()) else "Policy"
    # "(?! island)": the land acknowledgement names the Mississaugas of Scugog Island First Nation.
    towns = [t for t in DDSB_TOWNS if re.search(rf"\b{t.lower()}\b(?! island)", focus)] or DDSB_TOWNS[:5]

    urgency = 2
    if any(k in focus for k in ("consultation", "survey", "deadline", "public feedback")):
        urgency += 2
    if any(k in focus for k in ("vote", "motion", "approve", "recommend")):
        urgency += 1

    # Only real items: a short agenda gets fewer bullets rather than repeated filler.
    bullets = [f"Agenda item: {title.rstrip('.')}." for title, _ in items[:3]]
    if not bullets:
        bullets = ["See the original agenda for this meeting's items."]

    return {
        "title": headline[:90],
        "urgencyScore": min(urgency, 5),
        "townsAffected": towns,
        "category": category,
        "executiveSummary": bullets,
        # Shown to visitors on the live site, so written for parents rather than developers.
        "studentParentImpact": (
            "This entry lists the agenda's main items; a plain-language explanation of what they mean "
            "for students and parents isn't available yet. Open the original agenda for the full details."
        ),
        "policyChanges": "Not reviewed yet. Check the original agenda for any policy or procedure changes.",
    }


# --------------------------------------------------------------------------- #
# 4. Publish
# --------------------------------------------------------------------------- #

def slugify(text: str, max_length: int = 48) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:max_length].rstrip("-")


def record_id(source: AgendaSource) -> str:
    """One record per meeting: date + committee, e.g. 2026-09-09-committee-of-the-whole-standing.

    Deliberately not built from summary text, so re-running the pipeline updates a meeting's
    record instead of adding a duplicate next to it.
    """
    return f"{source.meeting_date or 'undated'}-{slugify(source.committee_name, 40)}"


def source_link(source: AgendaSource) -> str:
    return source.pdf_url or source.page_url or BOARD_MEETINGS_URL


def to_meeting_record(source: AgendaSource, summary: dict, summary_source: str) -> dict:
    """
    Merge discovery metadata with a summary into the public/data/meetings.json shape.

    Validates the summary as it goes (an AI answer can be malformed): raises PipelineError on
    anything unusable so the caller can fall back to the built-in summarizer.
    """
    try:
        bullets = list(dict.fromkeys(str(b).strip() for b in summary["executiveSummary"] if str(b).strip()))[:3]
        title = str(summary["title"]).strip()
        impact = str(summary["studentParentImpact"]).strip()
        policy = str(summary["policyChanges"]).strip()
        urgency = max(1, min(5, int(summary["urgencyScore"])))
        towns = [t for t in dict.fromkeys(summary["townsAffected"]) if t in DDSB_TOWNS] or DDSB_TOWNS[:5]
    except (KeyError, TypeError, ValueError) as exc:
        raise PipelineError(f"Unusable summary for {source.page_url}: {exc!r}") from exc
    if not bullets or not title:
        raise PipelineError(f"Summary for {source.page_url} has no title or bullets.")

    return {
        "id": record_id(source),
        "meetingDate": source.meeting_date or datetime.now().strftime("%Y-%m-%d"),
        "committeeName": source.committee_name,
        "title": title,
        "urgencyScore": urgency,
        "townsAffected": towns,
        "category": summary.get("category") if summary.get("category") in CATEGORIES else "Policy",
        "executiveSummary": bullets,
        "studentParentImpact": impact,
        "policyChanges": policy,
        "originalPdfUrl": source_link(source),
        # Which summarizer wrote this: "gemini", "claude" or "built-in". A built-in record is
        # upgraded automatically the next time an AI summarizer runs.
        "summarySource": summary_source,
    }


def write_json(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_public_meetings() -> dict[str, dict]:
    """Published records by id."""
    if not PUBLIC_MEETINGS_JSON.exists():
        return {}
    return {m["id"]: m for m in json.loads(PUBLIC_MEETINGS_JSON.read_text(encoding="utf-8"))}


def upsert_public_meetings(records: list[dict]) -> int:
    """Replace records with the same id, keep the rest, newest first."""
    merged = read_public_meetings()
    merged.update({r["id"]: r for r in records})
    ordered = sorted(merged.values(), key=lambda m: m["meetingDate"], reverse=True)
    write_json(PUBLIC_MEETINGS_JSON, ordered)
    return len(ordered)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape and summarize DDSB trustee meeting agendas.")
    parser.add_argument("--offline", action="store_true", help="skip the network and use a simulated agenda")
    parser.add_argument("--pdf", action="append", type=Path, default=[], help="summarize a local agenda PDF (repeatable)")
    parser.add_argument(
        "--summarizer", choices=["dummy", "gemini", "claude"], default="dummy",
        help="dummy = built-in (free, offline); gemini = Google Gemini, free tier, falls back to built-in; claude = paid",
    )
    parser.add_argument("--limit", type=int, default=3, help="max agendas to process from the live calendar (default 3)")
    parser.add_argument(
        "--months-back", type=int, default=1,
        help="start the calendar listing this many months before the current month (default 1)",
    )
    parser.add_argument("--headed", action="store_true", help="show the browser window (for debugging selectors)")
    parser.add_argument("--out", type=Path, default=OUTPUT_DIR / "meetings.generated.json", help="where to write results")
    parser.add_argument("--write-public", action="store_true", help="also upsert results into public/data/meetings.json")
    parser.add_argument(
        "--refresh", action="store_true",
        help="with --write-public, re-summarize agendas that are already published unchanged",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args(argv)


def collect_agendas(args: argparse.Namespace) -> list[tuple[AgendaSource, str]]:
    """Return (source, agenda text) pairs from local PDFs, the simulator, or the live site."""
    if args.pdf:
        pairs = []
        for pdf_path in args.pdf:
            source = AgendaSource(str(pdf_path), guess_committee(pdf_path.stem), parse_meeting_date(pdf_path.stem))
            pairs.append((source, extract_text_with_pdfplumber(pdf_path)))
        return pairs

    if args.offline:
        source = AgendaSource(BOARD_MEETINGS_URL, "Committee of the Whole - Standing", "2026-09-08")
        return [(source, simulate_pdfplumber_extraction(source))]

    pairs = []
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch(headless=not args.headed)
        except PlaywrightError as exc:
            reason = str(exc).strip().splitlines()[0]
            raise PipelineError(f"Could not start Chromium ({reason}). Run `python -m playwright install chromium` once.") from exc
        try:
            context = browser.new_context(user_agent=USER_AGENT)
            for source in discover_agendas(context, args.months_back, args.limit):
                try:
                    pdf_path = download_agenda_pdf(context, source)
                except (PipelineError, PlaywrightError) as exc:
                    log.warning("Skipping %s (%s): %s", source.committee_name, source.meeting_date, exc)
                    continue
                pairs.append((source, extract_text_with_pdfplumber(pdf_path)))
        finally:
            browser.close()

    if not pairs:
        log.warning("No agenda PDFs found. Agendas are posted a few days before each meeting; try --months-back 2.")
    return pairs


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")
    load_dotenv(BACKEND_DIR / ".env")

    ai_summarizer = args.summarizer in ("gemini", "claude")
    # Scheduled runs overlap (--months-back 1, daily): don't re-summarize an agenda that is
    # already published. Exceptions: a revised agenda (new document link) is redone, and when an
    # AI summarizer is running, a record written by the built-in summarizer is upgraded.
    published = read_public_meetings() if args.write_public and not args.refresh else {}
    gemini_calls = 0
    try:
        records = []
        for source, text in collect_agendas(args):
            prior = published.get(record_id(source))
            if prior and prior.get("originalPdfUrl") == source_link(source):
                upgradable = ai_summarizer and prior.get("summarySource", "built-in") == "built-in"
                if not upgradable:
                    log.info("Already published, skipping %s (%s)", source.committee_name, source.meeting_date)
                    continue
            log.info("Summarizing %s (%s, %s chars) with %s", source.committee_name, source.meeting_date, f"{len(text):,}", args.summarizer)

            if args.summarizer == "claude":
                records.append(to_meeting_record(source, summarize_with_claude(text, source), "claude"))
            elif args.summarizer == "gemini":
                if gemini_calls:
                    time.sleep(GEMINI_PAUSE_SECONDS)
                gemini_calls += 1
                try:
                    records.append(to_meeting_record(source, summarize_with_gemini(text, source), "gemini"))
                except (GeminiUnavailable, PipelineError) as exc:
                    # Never let Gemini trouble take the site down: publish the built-in summary
                    # now; tomorrow's run upgrades it once Gemini is available again.
                    warning = f"Gemini unavailable for {source.committee_name} ({source.meeting_date}); used the built-in summary. {exc}"
                    log.warning(warning)
                    if os.environ.get("GITHUB_ACTIONS"):
                        print(f"::warning title=Gemini fallback::{warning}")
                    records.append(to_meeting_record(source, summarize_dummy(text, source), "built-in"))
            else:
                records.append(to_meeting_record(source, summarize_dummy(text, source), "built-in"))
    except (PipelineError, PlaywrightError) as exc:
        log.error("%s", exc)
        if os.environ.get("GITHUB_ACTIONS"):
            # Shows on the run's summary page (and in the public API), not only in the raw log.
            message = " ".join(str(exc).split())[:900]
            print(f"::error title=Scrape failed::{message}")
        return 1

    write_json(args.out, records)
    log.info("Wrote %d record(s) to %s", len(records), args.out)
    if args.write_public and records:
        total = upsert_public_meetings(records)
        log.info("Updated %s (%d meetings total)", PUBLIC_MEETINGS_JSON.relative_to(PROJECT_ROOT), total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
