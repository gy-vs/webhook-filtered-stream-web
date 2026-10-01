// Observation scope shared by the snapshot request and the SSE connection.
// It is plain UI state: capture keeps recording every event server-side, and
// switching back to the unfiltered view re-reads the full workspace log.

export type EventFilter = {
  path: string | null;
  verification: 'all' | 'valid' | 'invalid';
};

export const EMPTY_FILTER: EventFilter = {path: null, verification: 'all'};

export function isFiltered(filter: EventFilter) {
  return filter.path !== null || filter.verification !== 'all';
}

export function filtersEqual(a: EventFilter, b: EventFilter) {
  return a.path === b.path && a.verification === b.verification;
}

/** Normalize a typed path into the exact-match form the server understands. */
export function normalizePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

/** Same query string for snapshot and stream, so both describe one condition. */
export function filterQueryString(filter: EventFilter): string {
  const params = new URLSearchParams();
  if (filter.path !== null) params.set('path', filter.path);
  if (filter.verification !== 'all') params.set('verification', filter.verification);
  return params.toString();
}

export function describeFilter(filter: EventFilter): string {
  if (!isFiltered(filter)) return '';
  const parts: string[] = [];
  if (filter.path !== null) parts.push(`路径 ${filter.path}`);
  if (filter.verification === 'invalid') parts.push('校验失败');
  if (filter.verification === 'valid') parts.push('校验通过');
  return parts.join(' · ');
}
