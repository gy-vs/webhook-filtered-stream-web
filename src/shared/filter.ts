// Observation-scope filters shared by the server and the browser.
//
// A filter is a *view*: capture keeps recording every event and every event
// keeps its workspace-wide (epoch, seq) identity; a filter only narrows what a
// snapshot/stream connection delivers. An empty filter preserves the original
// unfiltered behaviour byte for byte.

export type VerificationFilter = 'valid' | 'invalid';

export type Filter = {
  path?: string;
  verification?: VerificationFilter;
};

export function emptyFilter(): Filter {
  return {};
}

/**
 * Canonicalise a request path typed by the user. Stored event paths always
 * begin with '/'; let users type "orders" and mean "/orders".
 */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 0 && !trimmed.startsWith('/') ? '/' + trimmed : trimmed;
}

export function matchesFilter(
  event: {path: string; verification: {valid: boolean}},
  filter: Filter,
): boolean {
  if (filter.path !== undefined && normalizePath(event.path) !== normalizePath(filter.path)) return false;
  if (filter.verification !== undefined) {
    const wantValid = filter.verification === 'valid';
    if (event.verification.valid !== wantValid) return false;
  }
  return true;
}

/** Stable query suffix ('?path=...&verification=...' or ''), identical for snapshot and SSE. */
export function filterQuery(filter: Filter): string {
  const params = new URLSearchParams();
  if (filter.path) params.set('path', filter.path);
  if (filter.verification) params.set('verification', filter.verification);
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

/**
 * Stable identity of a scope. Reconnects that merely re-run an effect must not
 * tear down a connection when the condition itself did not change.
 */
export function filterKey(filter: Filter): string {
  return (filter.path ?? '') + '|' + (filter.verification ?? '');
}

export function describeFilter(filter: Filter): string {
  const parts: string[] = [];
  if (filter.path) parts.push('路径 ' + filter.path);
  if (filter.verification) parts.push(filter.verification === 'valid' ? '校验通过' : '校验失败');
  return parts.join(' · ');
}
