import { useEffect, useState } from 'react';
import { api, type Diff } from '../api';
import { navigate } from '../App';

interface FileDiff {
  path: string;
  lines: string[];
}

function splitFiles(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      files.push({ path: m[2], lines: [] });
      continue;
    }
    const cur = files[files.length - 1];
    if (!cur || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) continue;
    cur.lines.push(line);
  }
  return files;
}

export function DiffView({ id }: { id: string }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.diff(id).then(setDiff, (e) => setError(e.message));
  }, [id]);

  const files = diff ? splitFiles(diff.diff) : [];
  const stats = new Map(diff?.files.map((f) => [f.path, f]) ?? []);

  return (
    <div className="page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate(`#/s/${id}`)} aria-label="戻る">
          ‹
        </button>
        <h1 className="topbar-title">差分</h1>
        {diff && (
          <span className="small mono">
            <span className="add-text">+{diff.files.reduce((n, f) => n + f.added, 0)}</span>{' '}
            <span className="del-text">−{diff.files.reduce((n, f) => n + f.removed, 0)}</span>
          </span>
        )}
      </header>
      <main className="diff-page">
        {error && <div className="banner error">{error}</div>}
        {!diff && !error && <div className="empty">読み込み中…</div>}
        {diff && files.length === 0 && <div className="empty">ベースブランチからの変更はありません。</div>}
        {files.map((f) => {
          const s = stats.get(f.path);
          const isOpen = open[f.path] ?? files.length <= 3;
          return (
            <section key={f.path} className="file-diff">
              <button className="file-head" onClick={() => setOpen({ ...open, [f.path]: !isOpen })}>
                <span className="chevron">{isOpen ? '▾' : '▸'}</span>
                <span className="mono ellipsis">{f.path}</span>
                {s && (
                  <span className="small mono">
                    <span className="add-text">+{s.added}</span> <span className="del-text">−{s.removed}</span>
                  </span>
                )}
              </button>
              {isOpen && (
                <pre className="diff-body">
                  {f.lines.map((l, i) => (
                    <div key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                      {l || ' '}
                    </div>
                  ))}
                </pre>
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}
