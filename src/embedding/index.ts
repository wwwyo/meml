import { EMBED_MODEL } from "../config.ts";
import { LlamaServerEngine } from "./llama-server.ts";

// Thin engine interface so the backend (llama-server / Ollama / OpenAI) is swappable.
// All current/planned backends are HTTP, so swapping means changing the fetch target.
export interface EmbeddingEngine {
  readonly model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
  health(): Promise<boolean>;
}

let engine: EmbeddingEngine | null = null;

export function getEngine(): EmbeddingEngine {
  if (!engine) engine = new LlamaServerEngine(EMBED_MODEL);
  return engine;
}

export { chunkText } from "./chunk.ts";
