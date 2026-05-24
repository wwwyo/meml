import { chmodSync, mkdirSync } from "node:fs";
import { dbPath, embedServerUrl, resolveVault } from "../config.ts";
import { getEngine } from "../embedding/index.ts";
import { formatResult, type OutputFormat } from "../output.ts";
import { openDb } from "../storage/db.ts";
import { migrate } from "../storage/migrate.ts";

export interface InitOptions {
  vault?: string;
  format: OutputFormat;
}

// Create vault (0700) + DB + vss + schema (idempotent), then probe the embedding server.
// A down server is reported (with a hint) but does not fail init — `add` enforces it at use.
export async function cmdInit(opts: InitOptions): Promise<void> {
  const vault = resolveVault(opts.vault);
  mkdirSync(vault, { recursive: true, mode: 0o700 });
  try {
    chmodSync(vault, 0o700);
  } catch {
    // best-effort; e.g. on filesystems that ignore mode
  }

  const db = await openDb(vault, "read-write");
  try {
    await migrate(db.conn);
  } finally {
    db.close();
  }

  const reachable = await getEngine().health();
  const result = {
    vault,
    db: dbPath(vault),
    initialized: true,
    embedding_server: { url: embedServerUrl(), reachable },
  };
  process.stdout.write(formatResult(result, opts.format) + "\n");

  if (!reachable) {
    process.stderr.write(
      JSON.stringify({
        warning: {
          code: "EMBED_SERVER_UNAVAILABLE",
          message: `embedding server at ${embedServerUrl()} is not reachable`,
          hint: "Start it before `meml add`: `llama-server --embeddings -hf <bge-m3 GGUF>:Q8_0 --port 8080` (or set MEML_EMBED_URL).",
        },
      }) + "\n",
    );
  }
}
