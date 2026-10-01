import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {createApp, parseEventFilter, eventMatches, EMPTY_FILTER} from '../src/server/index';
import type {EventFilter} from '../src/server/index';

type ServerHandle = {base: string; close: () => Promise<void>};

function startServer(epoch?: string, bufferCapacity?: number): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const server = createApp({epoch, bufferCapacity}).listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      const {port} = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections?.();
            server.close(err => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

async function postEvent(base: string, workspace: string, path = '/hook', signature?: string) {
  const headers: Record<string, string> = {'content-type': 'application/json'};
  if (signature !== undefined) headers['x-signature'] = signature;
  const response = await fetch(`${base}/api/capture/${workspace}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({hello: Math.random()}),
  });
  return (await response.json()) as {epoch: string; seq: number};
}

type ParsedFrame = {event?: string; id?: string; data: string};

function parseFrames(buffer: string): ParsedFrame[] {
  return buffer
    .split('\n\n')
    .filter(chunk => chunk.length > 0)
    .map(chunk => {
      const frame: ParsedFrame = {data: ''};
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      frame.data = dataLines.join('\n');
      return frame;
    });
}

class SseClient {
  private buffer = '';
  frames: ParsedFrame[] = [];
  private waiters: Array<(frames: ParsedFrame[]) => boolean> = [];
  private req: http.ClientRequest;
  responseCode = 0;

  constructor(base: string, workspace: string, opts: {lastEventId?: string; query?: string} = {}) {
    const path = `/api/stream/${workspace}${opts.query ?? ''}`;
    const headers: Record<string, string> = {Accept: 'text/event-stream'};
    if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = opts.lastEventId;
    this.req = http.request({host: '127.0.0.1', port: Number(new URL(base).port), path, headers}, res => {
      this.responseCode = res.statusCode ?? 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        this.buffer += chunk;
        const complete = this.buffer.split('\n\n');
        this.buffer = complete.pop() ?? '';
        for (const raw of complete) {
          const parsed = parseFrames(raw)[0];
          if (!parsed) continue;
          this.frames.push(parsed);
          this.waiters = this.waiters.filter(waiter => waiter(this.frames));
        }
      });
      res.on('end', () => {
        this.waiters = this.waiters.filter(waiter => waiter(this.frames));
      });
    });
    this.req.on('error', () => {
      /* aborts during teardown */
    });
    this.req.end();
  }

  async waitFor(predicate: (frames: ParsedFrame[]) => boolean, timeoutMs = 2000): Promise<ParsedFrame[]> {
    if (predicate(this.frames)) return this.frames;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for SSE frame')), timeoutMs);
      const waiter = (frames: ParsedFrame[]) => {
        if (!predicate(frames)) return true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== waiter);
        resolve(frames);
        return false;
      };
      this.waiters.push(waiter);
    });
  }

  events(): Array<Record<string, unknown>> {
    return this.frames.filter(frame => !frame.event).map(frame => JSON.parse(frame.data));
  }

  gaps(): Array<Record<string, unknown>> {
    return this.frames.filter(frame => frame.event === 'gap').map(frame => JSON.parse(frame.data));
  }

  close() {
    this.req.destroy();
  }
}

const seqs = (events: Array<Record<string, unknown>>) => events.map(event => event.seq as number);
const paths = (events: Array<Record<string, unknown>>) => events.map(event => event.path as string);

describe('filter parsing', () => {
  it('accepts the empty filter and normalizes path input', () => {
    expect(parseEventFilter({})).toEqual(EMPTY_FILTER);
    expect(parseEventFilter({path: 'orders'})).toEqual({path: '/orders', verification: 'all'});
    expect(parseEventFilter({path: '/p', verification: 'invalid'})).toEqual({
      path: '/p',
      verification: 'invalid',
    });
    expect(parseEventFilter({path: '   '})).toEqual(EMPTY_FILTER);
  });

  it('rejects malformed filter input', () => {
    expect(parseEventFilter({verification: 'bogus'})).toBe('invalid');
    expect(parseEventFilter({path: ['/a']})).toBe('invalid');
    expect(parseEventFilter({verification: ['valid']})).toBe('invalid');
    expect(parseEventFilter({path: 1})).toBe('invalid');
  });

  it('matches by path and verification independently', () => {
    const event = {path: '/pay', valid: false};
    expect(eventMatches(EMPTY_FILTER, event)).toBe(true);
    expect(eventMatches({path: '/pay', verification: 'all'}, event)).toBe(true);
    expect(eventMatches({path: '/orders', verification: 'all'}, event)).toBe(false);
    expect(eventMatches({path: null, verification: 'invalid'}, event)).toBe(true);
    expect(eventMatches({path: null, verification: 'valid'}, event)).toBe(false);
    expect(eventMatches({path: '/pay', verification: 'valid'}, event)).toBe(false);
  });
});

describe('filtered snapshot', () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer('test-epoch', 5);
  });
  afterEach(async () => {
    await server.close();
  });

  async function snapshot(query = '') {
    const response = await fetch(`${server.base}/api/events?workspace=default${query}`);
    return (await response.json()) as {
      epoch: string;
      events: Array<Record<string, unknown>>;
    };
  }

  it('returns only the requested path while the unfiltered log keeps everything', async () => {
    await postEvent(server.base, 'default', '/orders', 'sig');
    await postEvent(server.base, 'default', '/payments', 'sig');

    const filtered = await snapshot('&path=/payments');
    expect(paths(filtered.events)).toEqual(['/payments']);
    expect(seqs(filtered.events)).toEqual([2]);

    const all = await snapshot();
    expect(seqs(all.events)).toEqual([1, 2]);
  });

  it('filters by verification result and combines both conditions', async () => {
    await postEvent(server.base, 'default', '/payments', 'sig'); // 1 valid
    await postEvent(server.base, 'default', '/payments'); // 2 invalid
    await postEvent(server.base, 'default', '/orders'); // 3 invalid

    expect(seqs((await snapshot('&verification=invalid')).events)).toEqual([2, 3]);
    expect(seqs((await snapshot('&path=/payments')).events)).toEqual([1, 2]);
    expect(seqs((await snapshot('&path=/payments&verification=valid')).events)).toEqual([1]);
    expect(seqs((await snapshot('&path=/payments&verification=invalid')).events)).toEqual([2]);
  });

  it('rejects malformed filter query params', async () => {
    const response = await fetch(`${server.base}/api/events?workspace=default&verification=bogus`);
    expect(response.status).toBe(400);
  });
});

describe('filtered stream', () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer('test-epoch', 5);
  });
  afterEach(async () => {
    await server.close();
  });

  it('replays and pushes only in-scope events, and capture keeps recording the rest', async () => {
    await postEvent(server.base, 'default', '/orders', 'sig'); // 1
    await postEvent(server.base, 'default', '/payments', 'sig'); // 2

    const client = new SseClient(server.base, 'default', {query: '?path=%2Fpayments'});
    await client.waitFor(frames => frames.some(frame => frame.event === 'ready'));
    expect(seqs(client.events())).toEqual([2]);

    await postEvent(server.base, 'default', '/orders', 'sig'); // 3 - must not arrive
    await postEvent(server.base, 'default', '/payments'); // 4 - invalid but path matches
    await client.waitFor(frames => client.events().length >= 2);
    // Give seq 3's frame a chance to arrive wrongly.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seqs(client.events())).toEqual([2, 4]);
    expect(paths(client.events())).toEqual(['/payments', '/payments']);
    client.close();

    // The out-of-scope request was still captured into the workspace log.
    const all = await (await fetch(`${server.base}/api/events?workspace=default`)).json();
    expect(seqs(all.events)).toEqual([1, 2, 3, 4]);
  });

  it('delivers disjoint scopes to two connections from one workspace', async () => {
    const pay = new SseClient(server.base, 'default', {query: '?path=%2Fpayments'});
    const invalid = new SseClient(server.base, 'default', {query: '?verification=invalid'});
    await Promise.all([
      pay.waitFor(frames => frames.some(frame => frame.event === 'ready')),
      invalid.waitFor(frames => frames.some(frame => frame.event === 'ready')),
    ]);

    await postEvent(server.base, 'default', '/payments', 'sig'); // 1
    await postEvent(server.base, 'default', '/orders'); // 2
    await postEvent(server.base, 'default', '/payments'); // 3

    await pay.waitFor(frames => pay.events().length >= 2);
    await invalid.waitFor(frames => invalid.events().length >= 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seqs(pay.events())).toEqual([1, 3]);
    expect(seqs(invalid.events())).toEqual([2, 3]);
    pay.close();
    invalid.close();
  });

  it('resumes after the in-scope cursor without treating out-of-scope seqs as a gap', async () => {
    const live = new SseClient(server.base, 'default', {query: '?path=%2Fpayments'});
    await live.waitFor(frames => frames.some(frame => frame.event === 'ready'));
    await postEvent(server.base, 'default', '/orders', 'sig'); // 1
    await postEvent(server.base, 'default', '/payments', 'sig'); // 2 - seen live
    await postEvent(server.base, 'default', '/orders'); // 3
    await live.waitFor(frames => live.events().length >= 1);
    live.close();

    await postEvent(server.base, 'default', '/orders', 'sig'); // 4
    await postEvent(server.base, 'default', '/payments', 'sig'); // 5

    const resumed = new SseClient(server.base, 'default', {
      query: '?path=%2Fpayments',
      lastEventId: 'test-epoch:2',
    });
    await resumed.waitFor(frames => frames.some(frame => frame.event === 'ready'));
    expect(seqs(resumed.events())).toEqual([5]);
    expect(resumed.gaps()).toHaveLength(0);
    resumed.close();
  });

  it('sees no gap when buffered seqs between cursor and replay are merely out of scope', async () => {
    for (const [path, sig] of [
      ['/a', 'sig'], // 1
      ['/b', 'sig'], // 2
      ['/a', 'sig'], // 3
      ['/b', 'sig'], // 4
    ] as const) {
      await postEvent(server.base, 'default', path, sig);
    }
    const client = new SseClient(server.base, 'default', {
      query: '?path=%2Fb',
      lastEventId: 'test-epoch:2',
    });
    await client.waitFor(frames => frames.some(frame => frame.event === 'ready'));
    expect(seqs(client.events())).toEqual([4]);
    expect(client.gaps()).toHaveLength(0);
    client.close();
  });

  it('rejects malformed filter query params on the stream', async () => {
    const client = new SseClient(server.base, 'default', {query: '?verification=bogus'});
    await client.waitFor(frames => client.responseCode === 400);
    expect(client.responseCode).toBe(400);
    client.close();
  });
});

describe('filtered overflow detection', () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer('test-epoch', 5);
  });
  afterEach(async () => {
    await server.close();
  });

  it('stays continuous when only out-of-scope events have been evicted', async () => {
    await postEvent(server.base, 'default', '/b', 'sig'); // 1 - cursor
    for (let i = 0; i < 4; i++) await postEvent(server.base, 'default', '/a', 'sig'); // 2..5
    await postEvent(server.base, 'default', '/a', 'sig'); // 6 evicts 1
    await postEvent(server.base, 'default', '/b', 'sig'); // 7 evicts 2; buffer 3..7

    const client = new SseClient(server.base, 'default', {
      query: '?path=%2Fb',
      lastEventId: 'test-epoch:1',
    });
    await client.waitFor(frames => frames.some(frame => frame.event === 'ready'));
    expect(client.gaps()).toHaveLength(0);
    expect(seqs(client.events())).toEqual([7]);
    client.close();
  });

  it('reports an in-scope eviction and still replays the surviving in-scope tail', async () => {
    await postEvent(server.base, 'default', '/b', 'sig'); // 1 - cursor
    await postEvent(server.base, 'default', '/b', 'sig'); // 2 - evicted later, in scope
    for (let i = 0; i < 4; i++) await postEvent(server.base, 'default', '/a', 'sig'); // 3..6
    await postEvent(server.base, 'default', '/b', 'sig'); // 7; buffer 3..7, ledger 1,2

    const client = new SseClient(server.base, 'default', {
      query: '?path=%2Fb',
      lastEventId: 'test-epoch:1',
    });
    await client.waitFor(frames => frames.some(frame => frame.event === 'gap'));
    const gap = client.gaps()[0];
    expect(gap.reason).toBe('buffer-overflow');
    expect(gap.lastSeen).toBe(1);
    expect(gap.oldest).toBe(7);
    expect(String(gap.message)).toContain('/b');
    expect(seqs(client.events())).toEqual([7]);
    client.close();
  });

  it('says the range is indeterminate once the eviction ledger itself has rolled', async () => {
    await postEvent(server.base, 'default', '/b', 'sig'); // 1 - cursor
    for (let i = 2; i <= 12; i++) await postEvent(server.base, 'default', '/a', 'sig');
    // Buffer holds 8..12, ledger holds 3..7; seq 2 is beyond both, its scope
    // unknown. The UI must not claim continuity or a definite in-scope loss.

    const client = new SseClient(server.base, 'default', {
      query: '?path=%2Fb',
      lastEventId: 'test-epoch:1',
    });
    await client.waitFor(frames => frames.some(frame => frame.event === 'gap'));
    const gap = client.gaps()[0];
    expect(gap.reason).toBe('buffer-overflow');
    expect(String(gap.message)).toContain('无法确定');
    expect(client.events()).toHaveLength(0);
    client.close();
  });
});
