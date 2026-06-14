import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const EMBED_DIM = 1024;
export const EMBED_MODEL = "bge-m3";

// Chunker (char-based, boundary-aware). Tunable; see decision.log.
export const CHUNK_MAX_CHARS = 1500;
export const CHUNK_OVERLAP_CHARS = 150;

export function defaultVault(): string {
  const env = process.env.MEML_VAULT;
  if (env && env.trim() !== "") return expandHome(env.trim());
  return join(homedir(), ".meml");
}

export function resolveVault(vaultArg?: string): string {
  const v = vaultArg && vaultArg.trim() !== "" ? expandHome(vaultArg.trim()) : defaultVault();
  return isAbsolute(v) ? v : resolve(process.cwd(), v);
}

export function dbPath(vault: string): string {
  return join(vault, "meml.duckdb");
}

export function embedServerUrl(): string {
  const env = process.env.MEML_EMBED_URL;
  return env && env.trim() !== "" ? env.trim().replace(/\/+$/, "") : "http://localhost:8080";
}

// Author for push-type sources (md): the user themselves.
export function authorIdentity(): string {
  const env = process.env.MEML_AUTHOR;
  if (env && env.trim() !== "") return env.trim();
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
