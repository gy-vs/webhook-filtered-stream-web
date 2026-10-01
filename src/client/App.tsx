import {useEffect, useMemo, useRef, useState} from 'react';
import {Radio, RotateCcw, AlertTriangle, Plus, X} from 'lucide-react';
import {
  applyEvent,
  applyGap,
  applySnapshot,
  dismissGap,
  emptyLog,
  eventKey,
  gapKey,
  gapsForRender,
  type ConnectionState,
  type EventLogState,
  type EventRow,
  type GapNotice,
} from './eventLog';
import {openWorkspaceStream} from './stream';
import {
  EMPTY_FILTER,
  describeFilter,
  filterQueryString,
  filtersEqual,
  isFiltered,
  normalizePath,
  type EventFilter,
} from './filter';

type WorkspaceView = {
  log: EventLogState;
  status: ConnectionState;
  selected: string | null;
  unread: number;
  // Observation scope for this workspace only; other workspaces keep theirs.
  filter: EventFilter;
};

const DEFAULT_WORKSPACES = ['default', 'payments'];

function freshView(): WorkspaceView {
  return {log: emptyLog(), status: 'connecting', selected: null, unread: 0, filter: EMPTY_FILTER};
}

function gapLabel(gap: GapNotice) {
  if (gap.reason === 'epoch-changed') return '服务端重启';
  if (gap.reason === 'ahead-of-buffer') return '游标超前';
  return '重放缓冲区溢出';
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<string[]>(DEFAULT_WORKSPACES);
  const [workspace, setWorkspace] = useState('default');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  const [views, setViews] = useState<Record<string, WorkspaceView>>(() => ({
    default: freshView(),
    payments: freshView(),
  }));
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  // Scope of the connection whose callbacks are currently allowed to land.
  // Keyed by workspace + filter so stale frames from an old condition cannot
  // merge into the new list.
  const scopeKeyRef = useRef('default|');
  const documentVisibleRef = useRef(typeof document === 'undefined' || document.visibilityState !== 'hidden');

  const view = views[workspace] ?? freshView();
  const filter = view.filter;

  const patchView = (name: string, patch: (current: WorkspaceView) => WorkspaceView) => {
    setViews(prev => {
      const current = prev[name] ?? freshView();
      const next = patch(current);
      if (next === current) return prev;
      return {...prev, [name]: next};
    });
  };

  const scopeKey = (name: string, scope: EventFilter) => name + '|' + filterQueryString(scope);

  // Snapshot + exactly one EventSource per active (workspace, filter) scope.
  // Re-runs (StrictMode remounts, workspace switches, filter changes) close the
  // previous source first and reset the observed log, so the snapshot and the
  // stream always belong to the same condition and no connection is dangling.
  useEffect(() => {
    const scope = scopeKey(workspace, filter);
    scopeKeyRef.current = scope;
    let cancelled = false;
    const query = filterQueryString(filter);
    fetch('/api/events?workspace=' + encodeURIComponent(workspace) + (query ? '&' + query : ''))
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        if (cancelled || scopeKeyRef.current !== scope || !payload) return;
        const events: EventRow[] = Array.isArray(payload.events) ? payload.events : [];
        patchView(workspace, current =>
          filtersEqual(current.filter, filter)
            ? {...current, log: applySnapshot(current.log, events)}
            : current,
        );
      })
      .catch(() => {
        /* stream reconnect covers snapshot failures */
      });

    const close = openWorkspaceStream(
      workspace,
      {
        onEvent: (event, live) => {
          patchView(workspaceRef.current, current => {
            if (scopeKeyRef.current !== scope || !filtersEqual(current.filter, filter)) return current;
            const before = current.log.rows.length;
            const log = applyEvent(current.log, event);
            if (log === current.log || log.rows.length === before) return current;
            // Only genuinely live events arriving while the tab is hidden are
            // unread; replayed frames (initial load / reconnect) never are.
            const unread = live && !documentVisibleRef.current ? current.unread + 1 : current.unread;
            return {...current, log, unread};
          });
        },
        onGap: gap => {
          patchView(workspaceRef.current, current => {
            if (scopeKeyRef.current !== scope || !filtersEqual(current.filter, filter)) return current;
            return {...current, log: applyGap(current.log, gap)};
          });
        },
        onReady: () => {
          /* status already flips to open via source.onopen */
        },
        onStateChange: status => {
          patchView(workspaceRef.current, current =>
            scopeKeyRef.current === scope && filtersEqual(current.filter, filter) && current.status !== status
              ? {...current, status}
              : current,
          );
        },
      },
      filter,
    );

    return () => {
      cancelled = true;
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, filter.path, filter.verification]);

  // Keep the path input in sync when the workspace or its committed filter changes.
  useEffect(() => {
    setPathDraft(filter.path ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, filter.path]);

  // Reset unread when the tab becomes visible (per workspace).
  useEffect(() => {
    const onVisibility = () => {
      documentVisibleRef.current = document.visibilityState !== 'hidden';
      if (document.visibilityState !== 'hidden') {
        setViews(prev => {
          const current = prev[workspaceRef.current];
          if (!current || current.unread === 0) return prev;
          return {...prev, [workspaceRef.current]: {...current, unread: 0}};
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    const total = Object.values(views).reduce((sum, item) => sum + item.unread, 0);
    document.title = total > 0 ? `(${total}) Webhook Lab` : 'Webhook Lab';
  }, [views]);

  function switchWorkspace(next: string) {
    if (next === workspace) return;
    const nextView = views[next];
    scopeKeyRef.current = scopeKey(next, nextView?.filter ?? EMPTY_FILTER);
    setWorkspace(next);
    setPathDraft(nextView?.filter.path ?? '');
    setViews(prev => {
      const current = prev[next];
      if (!current || current.unread === 0) return prev;
      return {...prev, [next]: {...current, unread: 0}};
    });
  }

  function addWorkspace() {
    const name = newWorkspace.trim().toLowerCase();
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || workspaces.includes(name)) {
      setNewWorkspace('');
      return;
    }
    setWorkspaces(prev => [...prev, name]);
    setViews(prev => (prev[name] ? prev : {...prev, [name]: freshView()}));
    setNewWorkspace('');
    switchWorkspace(name);
  }

  /**
   * Change this workspace's observation scope. The log, gaps and selection are
   * cleared synchronously and the scope guard advances before the old source's
   * teardown, so late frames delivered under the old condition can neither
   * interleave into the new list nor leave the detail pointing at a row the
   * new scope does not contain. Unread state belongs to the workspace and is
   * intentionally kept; other workspaces are untouched.
   */
  function commitFilter(next: EventFilter) {
    if (filtersEqual(filter, next)) return;
    scopeKeyRef.current = scopeKey(workspace, next);
    patchView(workspace, current => ({
      ...current,
      filter: next,
      log: emptyLog(),
      selected: null,
      status: 'connecting',
    }));
  }

  function submitPath(raw: string) {
    commitFilter({...filter, path: normalizePath(raw)});
  }

  function setVerification(verification: EventFilter['verification']) {
    commitFilter({...filter, verification});
  }

  function clearFilter() {
    setPathDraft('');
    commitFilter(EMPTY_FILTER);
  }

  const knownPaths = useMemo(
    () => Array.from(new Set(view.log.rows.map(row => row.path))).sort(),
    [view.log.rows],
  );
  const rowsDescending = useMemo(() => view.log.rows.slice().reverse(), [view.log.rows]);
  const {banners, inline} = useMemo(() => gapsForRender(view.log), [view.log]);
  const inlineByBoundary = useMemo(() => {
    const map = new Map<string | null, GapNotice[]>();
    for (const item of inline) {
      const list = map.get(item.boundaryKey) ?? [];
      list.push(item.gap);
      map.set(item.boundaryKey, list);
    }
    return map;
  }, [inline]);

  const active: EventRow | undefined =
    view.log.rows.find(event => eventKey(event) === view.selected) ?? view.log.rows[view.log.rows.length - 1];

  async function replay() {
    if (!active) return;
    await fetch('/api/replay', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({ids: [active.seq]}),
    });
  }

  const statusText =
    view.status === 'open' ? '已连接' : view.status === 'reconnecting' ? '断线重连中…' : '连接中…';

  return (
    <main className="shell">
      <header className="topbar">
        <Radio size={20} />
        <span className="brand">Webhook Lab</span>
        <small>实时请求工作区</small>
        <nav className="workspaces">
          {workspaces.map(name => (
            <button
              key={name}
              className={'ws-tab' + (name === workspace ? ' active' : '')}
              onClick={() => switchWorkspace(name)}
            >
              {name}
              {views[name]?.unread ? <span className="unread">{views[name].unread}</span> : null}
            </button>
          ))}
          <span className="ws-add">
            <input
              value={newWorkspace}
              onChange={event => setNewWorkspace(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') addWorkspace();
              }}
              placeholder="新工作区"
              aria-label="新工作区名称"
            />
            <button className="ws-add-btn" onClick={addWorkspace} title="加入工作区">
              <Plus size={14} />
            </button>
          </span>
        </nav>
        <span className={'conn conn-' + view.status}>{statusText}</span>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>
            事件
            <small className="epoch">epoch: {active?.epoch.slice(0, 8) ?? '—'}</small>
          </h2>
          <div className="filters">
            <input
              className="filter-path"
              list="known-paths"
              value={pathDraft}
              onChange={event => setPathDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submitPath(pathDraft);
              }}
              onBlur={() => submitPath(pathDraft)}
              placeholder="按路径筛选，如 /orders"
              aria-label="按请求路径筛选"
            />
            <datalist id="known-paths">
              {knownPaths.map(path => (
                <option key={path} value={path} />
              ))}
            </datalist>
            <select
              className="filter-verif"
              value={filter.verification}
              onChange={event => setVerification(event.target.value as EventFilter['verification'])}
              aria-label="按验证结果筛选"
            >
              <option value="all">全部校验</option>
              <option value="invalid">校验失败</option>
              <option value="valid">校验通过</option>
            </select>
            {isFiltered(filter) && (
              <button className="filter-clear" onClick={clearFilter} title="清除筛选">
                <X size={14} />
              </button>
            )}
          </div>
          {isFiltered(filter) && <p className="filter-scope">观察范围：{describeFilter(filter)}</p>}
          {banners.map(gap => (
            <div className="gap-banner" key={'banner-' + gapKey(gap)}>
              <AlertTriangle size={15} />
              <div>
                <strong>{gapLabel(gap)}</strong>
                <span>{gap.message}</span>
              </div>
              <button
                className="gap-close"
                onClick={() => patchView(workspace, current => ({...current, log: dismissGap(current.log, gapKey(gap))}))}
              >
                ×
              </button>
            </div>
          ))}
          <div className="list">
            {rowsDescending.flatMap(event => [
              <button
                className={active && eventKey(active) === eventKey(event) ? 'active' : ''}
                onClick={() => patchView(workspace, current => ({...current, selected: eventKey(event)}))}
                key={'event-' + eventKey(event)}
              >
                {event.method} {event.path}
                <br />
                <small>
                  event {event.seq} · {event.epoch.slice(0, 8)}
                </small>
              </button>,
              ...(inlineByBoundary.get(eventKey(event)) ?? []).map(gap => (
                <div className="gap-divider" key={'divider-' + gapKey(gap)} title={gap.message}>
                  <AlertTriangle size={13} />
                  <span>
                    缺口：{gapLabel(gap)}（{gap.oldest == null ? '?' : '#' + gap.oldest} 起可续传）
                  </span>
                </div>
              )),
            ])}
            {view.log.rows.length === 0 && banners.length === 0 && (
              <p className="empty">
                {isFiltered(filter)
                  ? `等待 ${workspace} 工作区中 ${describeFilter(filter)} 的 webhook…`
                  : `等待 ${workspace} 工作区的 webhook…`}
              </p>
            )}
          </div>
        </aside>
        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={replay} disabled={!active}>
              <RotateCcw size={15} /> 重放
            </button>
          </div>
          <h2>Payload</h2>
          <pre>{JSON.stringify(active?.body ?? {}, null, 2)}</pre>
        </section>
        <section className="pane">
          <h2>校验</h2>
          <span className="pill">{active?.verification.reason ?? 'waiting'}</span>
          <pre>{JSON.stringify(active ?? null, null, 2)}</pre>
        </section>
      </section>
    </main>
  );
}
