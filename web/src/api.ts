export type SessionStatus = 'starting' | 'idle' | 'running' | 'waiting' | 'stopped' | 'error';

export interface Session {
  id: string;
  title: string;
  repo: string;
  base_branch: string;
  branch: string;
  status: SessionStatus;
  mode: string;
  model: string;
  pr_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionInfo extends Session {
  live: boolean;
  modes: { id: string; name: string; description?: string }[];
  models: { modelId: string; name: string }[];
}

export interface EventRow {
  seq: number;
  session_id: string;
  ts: number;
  kind: string;
  data: any;
}

export interface Repo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: string | null;
  description: string | null;
}

export interface Diff {
  diff: string;
  files: { path: string; added: number; removed: number }[];
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-GeminiCode': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    // Cloudflare Access session expired: a full reload goes through the login page.
    location.reload();
    throw new Error('ログインし直してください');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export const api = {
  me: () => call<{ email: string; usage: { today: number; limit: number } }>('GET', '/api/me'),
  repos: () => call<Repo[]>('GET', '/api/repos'),
  sessions: () => call<Session[]>('GET', '/api/sessions'),
  session: (id: string) => call<SessionInfo>('GET', `/api/sessions/${id}`),
  create: (body: { repo: string; baseBranch?: string; prompt: string; mode: string }) =>
    call<Session>('POST', '/api/sessions', body),
  prompt: (id: string, text: string) => call('POST', `/api/sessions/${id}/prompt`, { text }),
  permission: (id: string, requestId: string, optionId: string | null) =>
    call('POST', `/api/sessions/${id}/permission`, { requestId, optionId }),
  cancel: (id: string) => call('POST', `/api/sessions/${id}/cancel`),
  setMode: (id: string, modeId: string) => call('POST', `/api/sessions/${id}/mode`, { modeId }),
  stop: (id: string) => call('POST', `/api/sessions/${id}/stop`),
  diff: (id: string) => call<Diff>('GET', `/api/sessions/${id}/diff`),
  push: (id: string) => call<{ commits: number }>('POST', `/api/sessions/${id}/push`),
  pr: (id: string) => call<{ url: string }>('POST', `/api/sessions/${id}/pr`),
  remove: (id: string) => call('DELETE', `/api/sessions/${id}`),
};

/**
 * Subscribes to /api/stream. EventSource reconnects on its own (sending Last-Event-ID),
 * but mobile browsers sometimes leave it closed after the tab was in the background,
 * so we recreate it when the page becomes visible again.
 */
export function subscribe(
  opts: { session?: string },
  handlers: { event?: (e: EventRow) => void; session?: (s: Session) => void; open?: () => void; error?: () => void },
): () => void {
  let lastSeq = 0;
  let es: EventSource | null = null;
  const connect = () => {
    const q = new URLSearchParams();
    if (opts.session) q.set('session', opts.session);
    q.set('after', String(lastSeq));
    es = new EventSource(`/api/stream?${q}`);
    es.addEventListener('event', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as EventRow;
      if (e.seq <= lastSeq) return;
      lastSeq = e.seq;
      handlers.event?.(e);
    });
    es.addEventListener('session', (m) => handlers.session?.(JSON.parse((m as MessageEvent).data)));
    es.onopen = () => handlers.open?.();
    es.onerror = () => handlers.error?.();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED) connect();
  };
  connect();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    es?.close();
  };
}
