import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { MemlError } from "./errors.ts";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

// Normalize an input path into a canonical source_id: reject control chars, expand ~, make
// absolute, and resolve symlinks/.. when the file exists. When it doesn't (e.g. removing a
// rename orphan), fall back to the resolved absolute path so the stored id can still be targeted.
export function toSourceId(raw: string): string {
  if (hasControlChar(raw)) {
    throw new MemlError("INVALID_PATH", "path contains control characters");
  }
  const expanded = expandHome(raw);
  const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
