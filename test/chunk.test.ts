import { describe, expect, test } from "bun:test";
import { chunkText } from "../src/embedding/chunk.ts";

describe("chunkText", () => {
  test("returns empty for whitespace-only input", () => {
    expect(chunkText("   \n  \t ")).toEqual([]);
    expect(chunkText("")).toEqual([]);
  });

  test("returns a single chunk when under the limit", () => {
    expect(chunkText("short note")).toEqual(["short note"]);
  });

  test("splits long text into multiple overlapping chunks", () => {
    const text = "word ".repeat(1000); // 5000 chars
    const chunks = chunkText(text, 1500, 150);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500);
    // reassembled (ignoring overlap) covers the whole text
    expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length);
  });

  test("prefers breaking at paragraph boundaries", () => {
    const para = "a".repeat(800);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkText(text, 1000, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // first chunk should end at a paragraph boundary, not mid-run
    expect(chunks[0]!.endsWith("\n\n") || chunks[0] === para).toBeTruthy();
  });
});
