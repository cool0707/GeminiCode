import { useEffect, useState } from 'react';
import { api, subscribe, type Session } from '../api';
import { navigate } from '../App';
import { formatTokens, relativeTime, statusLabel } from '../util';

export function SessionList() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [usage, setUsage] = useState<{ today: number; limit: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.sessions().then(setSessions, (e) => setError(e.message));
    api.me().then((m) => setUsage(m.usage), () => {});
    return subscribe(
      {},
      {
        session: (s) =>
          setSessions((prev) => {
            const rest = (prev ?? []).filter((p) => p.id !== s.id);
            return [s, ...rest].sort((a, b) => b.updated_at - a.updated_at);
          }),
      },
    );
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="topbar-title">GeminiCode</h1>
        {usage && (
          <span className="muted small">
            今日 {formatTokens(usage.today)}
            {usage.limit > 0 && ` / ${formatTokens(usage.limit)}`} tokens
          </span>
        )}
      </header>
      <main className="list">
        {error && <div className="banner error">{error}</div>}
        {sessions === null && !error && <div className="empty">読み込み中…</div>}
        {sessions?.length === 0 && (
          <div className="empty">
            <p>セッションはまだありません。</p>
            <p className="muted small">右下の「新規」から、リポジトリと指示を選んで始めます。</p>
          </div>
        )}
        {sessions?.map((s) => (
          <a key={s.id} className="card session-card" href={`#/s/${s.id}`}>
            <div className="session-card-head">
              <span className={`pill status-${s.status}`}>{statusLabel[s.status]}</span>
              <span className="muted small">{relativeTime(s.updated_at)}</span>
            </div>
            <div className="session-title">{s.title}</div>
            <div className="muted small mono ellipsis">
              {s.repo} · {s.branch}
            </div>
            {s.pr_url && <div className="small pr-link">PR 作成済み</div>}
          </a>
        ))}
      </main>
      <button className="fab" onClick={() => navigate('#/new')}>
        ＋ 新規
      </button>
    </div>
  );
}
