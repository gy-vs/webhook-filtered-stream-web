import {describe, expect, it} from 'vitest';
import {
  describeFilter,
  emptyFilter,
  filterKey,
  filterQuery,
  matchesFilter,
  normalizePath,
} from '../src/shared/filter';
import type {EventRow} from '../src/client/eventLog';

function event(path: string, valid = true): EventRow {
  return {
    epoch: 'A',
    seq: 1,
    method: 'POST',
    path,
    body: {},
    verification: {valid, reason: valid ? 'valid' : 'missing'},
  };
}

describe('observation scope filter', () => {
  it('empty filter matches everything and leaves the query untouched', () => {
    expect(matchesFilter(event('/orders'), emptyFilter())).toBe(true);
    expect(filterQuery(emptyFilter())).toBe('');
    expect(filterKey(emptyFilter())).toBe('|');
  });

  it('matches paths exactly, tolerating a missing leading slash', () => {
    expect(normalizePath('orders')).toBe('/orders');
    expect(normalizePath('/orders')).toBe('/orders');
    expect(matchesFilter(event('/orders'), {path: '/orders'})).toBe(true);
    expect(matchesFilter(event('/orders'), {path: 'orders'})).toBe(true);
    expect(matchesFilter(event('/orders/123'), {path: '/orders'})).toBe(false);
    expect(matchesFilter(event('/payments'), {path: '/orders'})).toBe(false);
  });

  it('filters by verification result and combines with path', () => {
    expect(matchesFilter(event('/x', true), {verification: 'valid'})).toBe(true);
    expect(matchesFilter(event('/x', false), {verification: 'valid'})).toBe(false);
    expect(matchesFilter(event('/x', false), {verification: 'invalid'})).toBe(true);
    expect(matchesFilter(event('/orders', true), {path: '/orders', verification: 'invalid'})).toBe(false);
    expect(matchesFilter(event('/orders', false), {path: '/orders', verification: 'invalid'})).toBe(true);
  });

  it('builds a stable canonical query and identity', () => {
    const query = filterQuery({path: '/orders', verification: 'invalid'});
    const params = new URLSearchParams(query.slice(1));
    expect(params.get('path')).toBe('/orders');
    expect(params.get('verification')).toBe('invalid');
    expect(filterKey({path: '/orders'})).toBe('/orders|');
    expect(filterKey({verification: 'valid'})).toBe('|valid');
    expect(filterKey({path: '/a'})).not.toBe(filterKey({path: '/b'}));
  });

  it('describes an active scope in human terms', () => {
    expect(describeFilter({path: '/orders', verification: 'invalid'})).toContain('/orders');
    expect(describeFilter({verification: 'valid'})).toContain('校验通过');
  });
});
