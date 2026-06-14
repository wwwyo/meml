import { describe, expect, test } from "bun:test";
import { MemlError } from "../src/errors.ts";
import { preprocessEmbed } from "../src/sql/preprocess.ts";

describe("preprocessEmbed", () => {
  test("rewrites a single meml_embed literal to a named param", () => {
    const { sql, params } = preprocessEmbed("SELECT array_cosine_similarity(c.embedding, meml_embed('hello')) FROM x");
    expect(sql).toBe("SELECT array_cosine_similarity(c.embedding, $qvec_1) FROM x");
    expect(params).toEqual([{ name: "qvec_1", text: "hello" }]);
  });

  test("dedupes identical literals to one param", () => {
    const { sql, params } = preprocessEmbed(
      "SELECT meml_embed('a'), meml_embed('a'), meml_embed('b')",
    );
    expect(params).toEqual([
      { name: "qvec_1", text: "a" },
      { name: "qvec_2", text: "b" },
    ]);
    expect(sql).toBe("SELECT $qvec_1, $qvec_1, $qvec_2");
  });

  test("handles doubled-quote escapes in the literal", () => {
    const { params } = preprocessEmbed("SELECT meml_embed('it''s ok')");
    expect(params[0]!.text).toBe("it's ok");
  });

  test("ignores meml_embed inside a string literal", () => {
    const { sql, params } = preprocessEmbed("SELECT 'meml_embed(''x'')' AS lit");
    expect(params).toEqual([]);
    expect(sql).toBe("SELECT 'meml_embed(''x'')' AS lit");
  });

  test("ignores meml_embed inside a dollar-quoted string", () => {
    const { sql, params } = preprocessEmbed("SELECT $$ meml_embed('x') $$ AS lit");
    expect(params).toEqual([]);
    expect(sql).toBe("SELECT $$ meml_embed('x') $$ AS lit");
  });

  test("honors a custom param name prefix (collision avoidance)", () => {
    const { sql, params } = preprocessEmbed("SELECT meml_embed('q')", "qABC123");
    expect(params).toEqual([{ name: "qABC123_1", text: "q" }]);
    expect(sql).toBe("SELECT $qABC123_1");
  });

  test("is case-insensitive and tolerates whitespace", () => {
    const { params } = preprocessEmbed("SELECT MEML_EMBED(  'q'  )");
    expect(params).toEqual([{ name: "qvec_1", text: "q" }]);
  });

  test("throws on a non-literal argument", () => {
    try {
      preprocessEmbed("SELECT meml_embed(content) FROM memory");
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MemlError);
      expect((e as MemlError).code).toBe("SQL_ERROR");
    }
  });

  test("does not match a longer identifier containing meml_embed", () => {
    const { params } = preprocessEmbed("SELECT meml_embedding FROM x");
    expect(params).toEqual([]);
  });
});
