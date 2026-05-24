import { EMBED_DIM, embedServerUrl } from "../config.ts";
import { MemlError } from "../errors.ts";
import type { EmbeddingEngine } from "./index.ts";

const START_HINT =
  "Start the embedding server, e.g. `llama-server --embeddings -hf <bge-m3 GGUF>:Q8_0 --port 8080` (override URL with MEML_EMBED_URL).";

// llama.cpp llama-server, OpenAI-compatible /v1/embeddings. content stays local.
export class LlamaServerEngine implements EmbeddingEngine {
  readonly model: string;
  private readonly baseUrl: string;

  constructor(model: string) {
    this.model = model;
    this.baseUrl = embedServerUrl();
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: texts, model: this.model }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new MemlError(
        "EMBED_SERVER_UNAVAILABLE",
        `cannot reach embedding server at ${this.baseUrl}: ${(e as Error).message}`,
        START_HINT,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MemlError(
        "EMBED_FAILED",
        `embedding server returned ${res.status}: ${body.slice(0, 200)}`,
        START_HINT,
      );
    }
    const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new MemlError("EMBED_FAILED", `unexpected embedding response shape from ${this.baseUrl}`);
    }
    const sorted = [...data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => {
      if (!Array.isArray(d.embedding) || d.embedding.length !== EMBED_DIM) {
        throw new MemlError(
          "EMBED_FAILED",
          `expected ${EMBED_DIM}-dim embedding but got ${d.embedding?.length}`,
          `meml is pinned to ${EMBED_DIM} dims (bge-m3). Ensure the server serves a matching model.`,
        );
      }
      return Float32Array.from(d.embedding);
    });
  }
}
