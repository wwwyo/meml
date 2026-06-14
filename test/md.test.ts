import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mdPlugin } from "../src/plugins/md.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "meml-md-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("mdPlugin", () => {
  test("supports .md and .markdown only", () => {
    expect(mdPlugin.supports("/x/a.md")).toBe(true);
    expect(mdPlugin.supports("/x/a.markdown")).toBe(true);
    expect(mdPlugin.supports("/x/a.MD")).toBe(true);
    expect(mdPlugin.supports("/x/a.txt")).toBe(false);
  });

  test("title: --title takes precedence", async () => {
    const p = write("a.md", "# Heading\n\nbody");
    const r = await mdPlugin.ingest(p, { title: "Explicit" });
    expect(r.titleSource).toBe("arg");
    expect(r.memory.title).toBe("Explicit");
  });

  test("title: first H1 fallback", async () => {
    const p = write("b.md", "intro\n# Real Heading\nmore");
    const r = await mdPlugin.ingest(p, {});
    expect(r.titleSource).toBe("h1");
    expect(r.memory.title).toBe("Real Heading");
  });

  test("title: filename fallback when no H1", async () => {
    const p = write("my-note.md", "no heading here\njust text");
    const r = await mdPlugin.ingest(p, {});
    expect(r.titleSource).toBe("filename");
    expect(r.memory.title).toBe("my-note");
  });

  test("ignores '#' inside fenced code blocks for H1", async () => {
    const p = write("c.md", "```\n# not a title\n```\n# Actual Title");
    const r = await mdPlugin.ingest(p, {});
    expect(r.memory.title).toBe("Actual Title");
  });

  test("stores raw content and file metadata", async () => {
    const content = "# T\n\nsome body";
    const p = write("d.md", content);
    const r = await mdPlugin.ingest(p, {});
    expect(r.memory.content).toBe(content);
    expect(r.memory.source).toBe("md");
    expect(r.memory.tags).toBeNull();
    expect(r.memory.url).toBeNull();
    expect(r.memory.sourcedAtMs).toBeGreaterThan(0);
    expect((r.memory.metadata as { mime_type: string }).mime_type).toBe("text/markdown");
  });
});
