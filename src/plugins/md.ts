import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { authorIdentity } from "../config.ts";
import { MemlError } from "../errors.ts";
import type { IngestOptions, IngestResult, SourcePlugin } from "./types.ts";

const EXTENSIONS = new Set([".md", ".markdown"]);

export const mdPlugin: SourcePlugin = {
  source: "md",

  supports(absPath: string): boolean {
    return EXTENSIONS.has(extname(absPath).toLowerCase());
  },

  async ingest(absPath: string, opts: IngestOptions): Promise<IngestResult> {
    let content: string;
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(absPath);
      content = await Bun.file(absPath).text();
    } catch (e) {
      throw new MemlError("IO_ERROR", `failed to read ${absPath}: ${(e as Error).message}`);
    }

    const argTitle = opts.title?.trim();
    let title: string;
    let titleSource: IngestResult["titleSource"];
    if (argTitle) {
      title = argTitle;
      titleSource = "arg";
    } else {
      const h1 = firstH1(content);
      if (h1) {
        title = h1;
        titleSource = "h1";
      } else {
        title = basename(absPath, extname(absPath));
        titleSource = "filename";
      }
    }

    return {
      titleSource,
      memory: {
        source: "md",
        sourceId: absPath,
        url: null,
        title,
        content,
        author: authorIdentity(),
        tags: null,
        sourcedAtMs: st.mtimeMs,
        metadata: {
          file_path: absPath,
          mime_type: "text/markdown",
          size_bytes: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          ctime: new Date(st.ctimeMs).toISOString(),
        },
      },
    };
  },
};

// First ATX H1 (`# heading`), skipping fenced code blocks. Not frontmatter/markdown parsing —
// just reading the first heading line as a title fallback.
function firstH1(content: string): string | null {
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#[ \t]+(\S.*?)\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}
