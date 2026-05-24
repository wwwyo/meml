import { describe, expect, test } from "bun:test";
import { MemlError } from "../src/errors.ts";
import { assertReadOnlySql } from "../src/sql/guard.ts";

const allowed = [
  "SELECT * FROM memory",
  "  select 1",
  "WITH x AS (SELECT 1 AS n) SELECT * FROM x",
  "SELECT * FROM memory; ", // trailing semicolon + whitespace
  "SELECT 'how to DROP a table' AS note", // keyword inside string literal
  "SELECT * -- a comment mentioning DELETE\nFROM memory",
  "SELECT \"updated\" FROM memory", // keyword-ish quoted identifier neutralized
];

const denied = [
  ["INSERT INTO memory VALUES (1)", "SQL_FORBIDDEN"],
  ["UPDATE memory SET title = 'x'", "SQL_FORBIDDEN"],
  ["DELETE FROM memory", "SQL_FORBIDDEN"],
  ["DROP TABLE memory", "SQL_FORBIDDEN"],
  ["CREATE TABLE t (x INT)", "SQL_FORBIDDEN"],
  ["SELECT 1; DROP TABLE memory", "SQL_FORBIDDEN"], // multiple statements
  ["SELECT * FROM memory; COPY memory TO '/tmp/x.csv'", "SQL_FORBIDDEN"],
  ["ATTACH 'other.db'", "SQL_FORBIDDEN"],
  ["INSTALL vss", "SQL_FORBIDDEN"],
  ["LOAD vss", "SQL_FORBIDDEN"],
  ["PRAGMA database_list", "SQL_FORBIDDEN"],
  ["CALL pragma_version()", "SQL_FORBIDDEN"],
  ["", "SQL_ERROR"],
  ["   ", "SQL_ERROR"],
] as const;

describe("assertReadOnlySql", () => {
  for (const sql of allowed) {
    test(`allows: ${sql.slice(0, 40)}`, () => {
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    });
  }

  for (const [sql, code] of denied) {
    test(`denies (${code}): ${sql.slice(0, 40)}`, () => {
      try {
        assertReadOnlySql(sql);
        throw new Error("expected to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(MemlError);
        expect((e as MemlError).code).toBe(code);
      }
    });
  }
});
