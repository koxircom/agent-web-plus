import type {SessionFileStats} from './session-stats';
/** Shared presentation contract. null means unknown, never a zero estimate. */
export interface SessionUsageSnapshot {
  contextUsage: {percent:number|null; contextWindow:number; tokens:number|null}|null;
  tokens: SessionFileStats['tokens']|null;
}
export function formatUsageTokens(value:number):string {
  return value>=1_000_000?`${(value/1_000_000).toFixed(1).replace(/\.0$/,'')}M`:value>=1000?`${(value/1000).toFixed(1).replace(/\.0$/,'')}k`:String(value);
}
