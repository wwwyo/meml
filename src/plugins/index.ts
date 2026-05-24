import { mdPlugin } from "./md.ts";
import type { SourcePlugin } from "./types.ts";

// Phase 0: md only. Adding PDF/image plugins later means appending here; `meml add`
// dispatches by extension via supports().
const PLUGINS: SourcePlugin[] = [mdPlugin];

export function pluginForPath(absPath: string): SourcePlugin | null {
  return PLUGINS.find((p) => p.supports(absPath)) ?? null;
}
