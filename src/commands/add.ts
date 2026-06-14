import { existsSync, statSync } from "node:fs";
import { dbPath, EMBED_MODEL, resolveVault } from "../config.ts";
import { chunkText, getEngine } from "../embedding/index.ts";
import { MemlError } from "../errors.ts";
import { formatResult, type OutputFormat } from "../output.ts";
import { toSourceId } from "../paths.ts";
import { pluginForPath } from "../plugins/index.ts";
import { openDb } from "../storage/db.ts";
import { type ChunkInput, upsertMemory } from "../storage/repo.ts";

export interface AddOptions {
  path: string;
  title?: string;
  dryRun: boolean;
  vault?: string;
  format: OutputFormat;
}

export async function cmdAdd(opts: AddOptions): Promise<void> {
  const sourceId = toSourceId(opts.path);
  if (!existsSync(sourceId)) {
    throw new MemlError("FILE_NOT_FOUND", `file not found: ${opts.path}`);
  }
  if (!statSync(sourceId).isFile()) {
    throw new MemlError("INVALID_PATH", `not a regular file: ${opts.path}`);
  }

  const plugin = pluginForPath(sourceId);
  if (!plugin) {
    throw new MemlError(
      "UNSUPPORTED_FILE",
      `unsupported file type: ${opts.path}`,
      "Phase 0 supports Markdown (.md / .markdown) only.",
    );
  }

  const { memory, titleSource } = await plugin.ingest(sourceId, { title: opts.title });
  if (titleSource === "filename") {
    process.stderr.write(
      JSON.stringify({
        warning: {
          code: "TITLE_FALLBACK",
          message: `no --title and no leading H1 in ${opts.path}; using filename as title`,
          hint: "Pass --title or add a `# Heading` to the file for a meaningful title.",
        },
      }) + "\n",
    );
  }

  const chunks = chunkText(memory.content);
  if (chunks.length === 0) {
    process.stderr.write(
      JSON.stringify({
        warning: {
          code: "NO_CHUNKS",
          message: `${opts.path} has no embeddable content; it will be stored but not findable via semantic search`,
          hint: "Structured queries (title / metadata) still work; add body text to make it searchable.",
        },
      }) + "\n",
    );
  }
  const sourcedAtIso = memory.sourcedAtMs !== null ? new Date(memory.sourcedAtMs).toISOString() : null;

  if (opts.dryRun) {
    const reachable = await getEngine().health();
    process.stdout.write(
      formatResult(
        {
          dry_run: true,
          source_id: sourceId,
          title: memory.title,
          title_source: titleSource,
          sourced_at: sourcedAtIso,
          chunks: chunks.length,
          embedding_server_reachable: reachable,
        },
        opts.format,
      ) + "\n",
    );
    return;
  }

  const vault = resolveVault(opts.vault);
  if (!existsSync(dbPath(vault))) {
    throw new MemlError("NOT_INITIALIZED", `vault not initialized at ${vault}`, "Run `meml init` first.");
  }

  // Embed before opening the write transaction so a server failure leaves the DB untouched.
  const embeddings = chunks.length > 0 ? await getEngine().embed(chunks) : [];
  const chunkInputs: ChunkInput[] = chunks.map((content, index) => ({
    index,
    content,
    embedding: embeddings[index]!,
    model: EMBED_MODEL,
  }));

  const db = await openDb(vault, "read-write");
  try {
    const existing = await db.conn.runAndReadAll(
      "SELECT 1 FROM memory WHERE source = $1 AND source_id = $2",
      { 1: memory.source, 2: sourceId },
    );
    const action = existing.getRowObjectsJson().length > 0 ? "updated" : "created";

    await db.conn.run("BEGIN TRANSACTION");
    let id: string;
    try {
      id = await upsertMemory(db.conn, memory, chunkInputs, Date.now());
      await db.conn.run("COMMIT");
    } catch (e) {
      await db.conn.run("ROLLBACK").catch(() => {});
      throw e;
    }

    process.stdout.write(
      formatResult(
        { id, source_id: sourceId, title: memory.title, title_source: titleSource, action, chunks: chunks.length },
        opts.format,
      ) + "\n",
    );
  } finally {
    db.close();
  }
}
