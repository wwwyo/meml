import { MemlError } from "../errors.ts";
import { dollarQuoteEnd } from "./scan.ts";

export interface EmbedParam {
  name: string;
  text: string;
}

export interface PreprocessResult {
  sql: string;
  params: EmbedParam[];
}

// Rewrite `meml_embed('literal')` occurrences into `$qvec_N` named params, returning the
// literals to embed once on the CLI side. This keeps embedding to a single HTTP call per
// distinct literal and avoids per-row UDF evaluation / read-only-connection conflicts.
// Only string-literal arguments are supported (column args are out of scope by design).
// `namePrefix` names the generated params (`<prefix>_<n>`); callers pass a per-invocation
// unique prefix so a user-written `$qvec_1` can't collide with a generated bind param.
export function preprocessEmbed(sql: string, namePrefix = "qvec"): PreprocessResult {
  let out = "";
  let i = 0;
  const n = sql.length;
  let counter = 0;
  const byText = new Map<string, string>();
  const params: EmbedParam[] = [];

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // copy comments verbatim
    if (c === "-" && c2 === "-") {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += sql.slice(start, i);
      continue;
    }
    if (c === "/" && c2 === "*") {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += sql.slice(start, Math.min(i, n));
      continue;
    }
    // copy string / quoted-identifier literals verbatim (so meml_embed inside them is ignored)
    if (c === "'" || c === '"') {
      const lit = readQuoted(sql, i, c);
      out += sql.slice(i, lit.end);
      i = lit.end;
      continue;
    }
    // copy dollar-quoted strings verbatim (DuckDB $$...$$ / $tag$...$tag$)
    if (c === "$") {
      const dq = dollarQuoteEnd(sql, i);
      if (dq !== null) {
        out += sql.slice(i, dq);
        i = dq;
        continue;
      }
    }

    // match meml_embed( ... ) as a whole identifier
    if ((c === "m" || c === "M") && matchesKeyword(sql, i, "meml_embed")) {
      const callEnd = i + "meml_embed".length;
      let j = callEnd;
      while (j < n && /\s/.test(sql[j]!)) j++;
      if (sql[j] === "(") {
        j++;
        while (j < n && /\s/.test(sql[j]!)) j++;
        if (sql[j] !== "'") {
          throw new MemlError(
            "SQL_ERROR",
            "meml_embed() requires a single-quoted string literal argument",
            "Example: meml_embed('react server components'). Column arguments are not supported.",
          );
        }
        const lit = readQuoted(sql, j, "'");
        let k = lit.end;
        while (k < n && /\s/.test(sql[k]!)) k++;
        if (sql[k] !== ")") {
          throw new MemlError("SQL_ERROR", "malformed meml_embed() call (expected closing parenthesis)");
        }
        k++;
        const text = lit.value;
        let name = byText.get(text);
        if (!name) {
          counter++;
          name = `${namePrefix}_${counter}`;
          byText.set(text, name);
          params.push({ name, text });
        }
        out += `$${name}`;
        i = k;
        continue;
      }
    }

    out += c;
    i++;
  }

  return { sql: out, params };
}

// Read a quoted run starting at index `i` (sql[i] === quote). Handles doubled-quote escapes.
// Returns the unescaped inner value and the index just past the closing quote.
function readQuoted(sql: string, i: number, quote: string): { value: string; end: number } {
  const n = sql.length;
  let value = "";
  let j = i + 1;
  while (j < n) {
    if (sql[j] === quote && sql[j + 1] === quote) {
      value += quote;
      j += 2;
      continue;
    }
    if (sql[j] === quote) {
      j++;
      return { value, end: j };
    }
    value += sql[j];
    j++;
  }
  // unterminated literal: return what we have
  return { value, end: n };
}

function matchesKeyword(sql: string, i: number, kw: string): boolean {
  if (sql.slice(i, i + kw.length).toLowerCase() !== kw) return false;
  const before = sql[i - 1];
  const after = sql[i + kw.length];
  const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  return !isWord(before) && !isWord(after);
}
