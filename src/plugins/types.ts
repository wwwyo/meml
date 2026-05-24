import type { MemoryInput } from "../storage/repo.ts";

export type TitleSource = "arg" | "h1" | "filename";

export interface IngestResult {
  memory: MemoryInput;
  titleSource: TitleSource;
}

export interface IngestOptions {
  title?: string;
}

// A source plugin owns: file -> memory mapping, title extraction, and common-column
// normalization for its source. The core only guarantees title is always filled.
export interface SourcePlugin {
  readonly source: string;
  supports(absPath: string): boolean;
  ingest(absPath: string, opts: IngestOptions): Promise<IngestResult>;
}
