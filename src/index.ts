#!/usr/bin/env bun
import { parseArgs, type ParseArgsConfig } from "node:util";
import { cmdAdd } from "./commands/add.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdRemove } from "./commands/remove.ts";
import { cmdSchema } from "./commands/schema.ts";
import { cmdSql } from "./commands/sql.ts";
import { MemlError } from "./errors.ts";
import { type OutputFormat, resolveFormat } from "./output.ts";

const HELP = `meml — personal memory CLI

Usage:
  meml init [--vault PATH]
  meml add <path> [--title TITLE] [--dry-run] [--vault PATH]
  meml remove <path> [--vault PATH]
  meml sql "<query>" [--json|--csv|--table] [--vault PATH]   (use - to read SQL from stdin)
  meml schema [--json] [--vault PATH]

Output: defaults to JSON when piped, table on a TTY. Override with --json/--csv/--table or MEML_OUTPUT.
Embedding: requires a running llama-server (see README); override URL with MEML_EMBED_URL.
`;

const FORMAT_OPTS = {
  json: { type: "boolean" },
  csv: { type: "boolean" },
  table: { type: "boolean" },
} as const;

function pickFormat(v: Record<string, unknown>): OutputFormat | undefined {
  if (v.json) return "json";
  if (v.csv) return "csv";
  if (v.table) return "table";
  return undefined;
}

function parse(args: string[], options: ParseArgsConfig["options"], allowPositionals: boolean) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (e) {
    throw new MemlError("INVALID_ARGS", (e as Error).message, "Run `meml --help` for usage.");
  }
}

function requirePath(positionals: string[], usage: string): string {
  if (positionals.length === 0) throw new MemlError("INVALID_ARGS", "missing <path>", usage);
  if (positionals.length > 1) {
    throw new MemlError("INVALID_ARGS", `unexpected extra arguments: ${positionals.slice(1).join(" ")}`, usage);
  }
  return positionals[0]!;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(HELP);
    return;
  }

  switch (sub) {
    case "init": {
      const { values } = parse(rest, { vault: { type: "string" }, ...FORMAT_OPTS }, false);
      await cmdInit({ vault: values.vault as string | undefined, format: resolveFormat(pickFormat(values)) });
      return;
    }
    case "add": {
      const { values, positionals } = parse(
        rest,
        { title: { type: "string" }, "dry-run": { type: "boolean" }, vault: { type: "string" }, ...FORMAT_OPTS },
        true,
      );
      const path = requirePath(positionals, "Usage: meml add <path> [--title TITLE] [--dry-run]");
      await cmdAdd({
        path,
        title: values.title as string | undefined,
        dryRun: !!values["dry-run"],
        vault: values.vault as string | undefined,
        format: resolveFormat(pickFormat(values)),
      });
      return;
    }
    case "remove": {
      const { values, positionals } = parse(rest, { vault: { type: "string" }, ...FORMAT_OPTS }, true);
      const path = requirePath(positionals, "Usage: meml remove <path>");
      await cmdRemove({ path, vault: values.vault as string | undefined, format: resolveFormat(pickFormat(values)) });
      return;
    }
    case "sql": {
      const { values, positionals } = parse(rest, { vault: { type: "string" }, ...FORMAT_OPTS }, true);
      const query = requirePath(positionals, 'Usage: meml sql "<query>" (or - for stdin)');
      await cmdSql({ query, vault: values.vault as string | undefined, format: resolveFormat(pickFormat(values)) });
      return;
    }
    case "schema": {
      const { values } = parse(rest, { vault: { type: "string" }, json: { type: "boolean" } }, false);
      await cmdSchema({ vault: values.vault as string | undefined, json: !!values.json });
      return;
    }
    default:
      throw new MemlError("INVALID_ARGS", `unknown command: ${sub}`, "Run `meml --help` for usage.");
  }
}

// Use process.exitCode (not process.exit) so buffered stdout flushes before the process exits.
// process.exit() can truncate large piped output at the OS pipe-buffer boundary.
main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    const envelope =
      err instanceof MemlError
        ? err.toEnvelope()
        : { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } };
    process.stderr.write(JSON.stringify(envelope) + "\n");
    process.exitCode = 1;
  });
