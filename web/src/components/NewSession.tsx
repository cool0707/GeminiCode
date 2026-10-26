import { useEffect, useState } from 'react';
import { api, type ModelInfo, type Repo } from '../api';
import { navigate } from '../App';
import { modeLabel } from '../util';
import { ModelPicker } from './ModelPicker';

const LAST_REPO = 'geminicode.lastRepo';
const LAST_MODE = 'geminicode.lastMode';
const LAST_MODEL = 'geminicode.lastModel';

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: just don't remember.
  }
}

export function NewSession() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState(() => load(LAST_REPO, ''));
  const [baseBranch, setBaseBranch] = useState('');
  const [mode, setMode] = useState(() => load(LAST_MODE, 'default'));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState(() => load(LAST_MODEL, ''));
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.repos().then(
      (list) => {
        setRepos(list);
        setRepo((cur) => (list.some((r) => r.fullName === cur) ? cur : (list[0]?.fullName ?? '')));
      },
      (e) => setError(e.message),
    );
    api.models().then(
      (m) => {
        setModels(m.models);
        setModel((cur) => (cur && m.models.some((x) => x.modelId === cur) ? cur : m.default));
      },
      () => setModel((cur) => cur || 'auto'),
    );
  }, []);

  const selected = repos?.find((r) => r.fullName === repo);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      save(LAST_REPO, repo);
      save(LAST_MODE, mode);
      save(LAST_MODEL, model);
      const s = await api.create({ repo, baseBranch: baseBranch || undefined, prompt, mode, model });
      navigate(`#/s/${s.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate('#/')} aria-label="戻る">
          ‹
        </button>
        <h1 className="topbar-title">新しいセッション</h1>
      </header>
      <main className="form">
        {error && <div className="banner error">{error}</div>}
        <label className="field">
          <span>リポジトリ</span>
          <select value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!repos}>
            {!repos && <option>読み込み中…</option>}
            {repos?.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>ベースブランチ</span>
          <input
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            placeholder={selected?.defaultBranch ?? 'デフォルトブランチ'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="field">
          <span>承認モード</span>
          <div className="segmented">
            {['default', 'autoEdit', 'yolo'].map((m) => (
              <button key={m} className={m === mode ? 'active' : ''} onClick={() => setMode(m)} type="button">
                {modeLabel[m]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>モデル</span>
          {model ? (
            <ModelPicker className="select-like" value={model} models={models} onChange={setModel} />
          ) : (
            <div className="select-like muted">読み込み中…</div>
          )}
          <span className="hint">Pro 系が混雑して応答しないときは Flash 系を選んでください。</span>
        </div>
        <label className="field grow">
          <span>指示</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例: README にセットアップ手順を追記して"
            rows={8}
          />
        </label>
        <button className="primary block" disabled={busy || !repo || !prompt.trim()} onClick={submit}>
          {busy ? '作成中…' : '開始'}
        </button>
      </main>
    </div>
  );
}
