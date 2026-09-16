/**
 * Turning a search phrase into the same kind of vector the agendas were stored as.
 *
 * Must stay in step with backend/embeddings.py: the same model, the same 768 dimensions and the
 * same normalisation, or a query lands nowhere near the passages it should match. The only
 * difference is the task type — Gemini embeds a question differently from a document, which is
 * what makes a short query find a long passage.
 */

const MODEL = process.env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001";
const DIMENSIONS = 768;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;

export type EmbeddingResult = { embedding: number[] } | { problem: string };

/** gemini-embedding-001 only returns unit-length vectors at its full size; 768 has to be scaled. */
function normalize(values: number[]): number[] {
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return length ? values.map((value) => value / length) : values;
}

/**
 * Embed a search phrase. Reports what's wrong instead of throwing, so the route can answer with
 * a clear message rather than a stack trace.
 */
export async function embedQuery(text: string, signal?: AbortSignal): Promise<EmbeddingResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return { problem: "GEMINI_API_KEY is not set" };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: `models/${MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: DIMENSIONS,
        // RETRIEVAL_QUERY, not RETRIEVAL_DOCUMENT: this is the asking side of the pair.
        taskType: "RETRIEVAL_QUERY",
      }),
      signal,
    });
  } catch (error) {
    return { problem: `could not reach Gemini: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    return { problem: `Gemini returned HTTP ${response.status} ${detail}` };
  }

  const body = (await response.json().catch(() => null)) as { embedding?: { values?: number[] } } | null;
  const values = body?.embedding?.values;
  if (!Array.isArray(values) || values.length !== DIMENSIONS) {
    return { problem: `expected ${DIMENSIONS} dimensions, got ${values?.length ?? 0}` };
  }
  return { embedding: normalize(values) };
}
