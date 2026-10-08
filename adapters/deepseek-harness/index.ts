/**
 * Legacy entry pointer — the plugin lives in `src/` (see src/index.ts for the
 * real implementation). Kept so older references to `adapters/deepseek-harness/
 * index.ts` still resolve to the plugin's `name` / `inject` / `apply`.
 */
export { name, inject, apply } from './src/index.ts';
