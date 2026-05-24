// If sql[i] starts a DuckDB dollar-quoted string (`$$...$$` or `$tag$...$tag$`), return the
// index just past the closing delimiter (or end-of-string if unterminated). Otherwise null —
// this distinguishes dollar quotes from named params like `$qvec_1` / `$1`, where the opening
// run of identifier chars is NOT followed by a second `$`.
export function dollarQuoteEnd(sql: string, i: number): number | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
  if (sql[j] !== "$") return null;
  const delim = sql.slice(i, j + 1);
  const close = sql.indexOf(delim, j + 1);
  return close === -1 ? sql.length : close + delim.length;
}
