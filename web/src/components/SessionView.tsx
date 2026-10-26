import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, subscribe, type ModelInfo, type SessionInfo } from '../api';
import { navigate } from '../App';
import { applyEvent, emptyTimeline, pendingPermission, type Item, type PermissionItem } from '../timeline';
import { formatTokens, modeLabel, statusLabel } from '../util';
import { Markdown } from './Markdown';
import { ToolCard, ToolContentView } from './ToolCard';
import { ModelPicker } from './ModelPicker';

const outcomeLabel: Record<string, string> = { cancelled: '拒否しました', expired: '期限切れ' };

// Gemini CLI's ToolConfirmationOutcome ids; anything else falls back to the agent's own label.
const optionLabel: Record<string, string> = {
  proceed_once: '今回だけ許可',
  proceed_always: 'このセッション中は許可',
  proceed_always_and_save: '今後も常に許可',
  proceed_always_server: 'このサーバーのツールをすべて許可',
  proceed_always_tool: 'このツールをセッション中は許可',
  cancel: '拒否',
};

const optionName = (o: { optionId: string; name: string }) => optionLabel[o.optionId] ?? o.name;

export function SessionView({ id }: { id: string }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [timeline, setTimeline] = useState(emptyTimeline);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [knownModels, setKnownModels] = useState<ModelInfo[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const refresh = useCallback(() => api.session(id).then(setSession, (e) => setError(e.message)), [id]);

  useEffect(() => {
    api.models().then((m) => setKnownModels(m.models), () => {});
  }, []);

  useEffect(() => {
    refresh();
    return subscribe(
      { session: id },
      {
        event: (e) => setTimeline((tl) => applyEvent(tl, e)),
        session: (s) => {
          if (s.id === id) setSession((prev) => (prev ? { ...prev, ...s } : prev));
        },
        open: () => setConnected(true),
        error: () => setConnected(false),
      },
    );
  }, [id, refresh]);

  // The agent reports available modes once it is running; refetch when it comes up.
  useEffect(() => {
    if (session && !session.modes.length && (session.status === 'running' || session.status === 'idle')) refresh();
  }, [session?.status, session?.modes.length, refresh]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const pending = pendingPermission(timeline);
  const busy = session?.status === 'running' || session?.status === 'waiting' || session?.status === 'starting';

  return (
    <div className="page session-page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate('#/')} aria-label="戻る">
          ‹
        </button>
        <div className="topbar-main">
          <div className="topbar-title ellipsis">{session?.title ?? '…'}</div>
          <div className="muted small mono ellipsis">
            {session ? `${session.repo} · ${session.branch}` : ''}
          </div>
        </div>
        {session && <span className={`pill status-${session.status}`}>{statusLabel[session.status]}</span>}
        <button className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="メニュー">
          ⋯
        </button>
      </header>

      {!connected && <div className="banner warn">再接続しています…</div>}
      {error && (
        <div className="banner error" onClick={() => setError('')}>
          {error}
        </div>
      )}

      <div className="timeline" ref={scrollRef} onScroll={onScroll}>
        {timeline.items.map((item) => (
          <TimelineItem key={item.key} item={item} />
        ))}
        {busy && !pending && <div className="typing">考えています…</div>}
      </div>

      {pending ? (
        <PermissionSheet
          item={pending}
          onAnswer={(optionId) => run(() => api.permission(id, pending.requestId, optionId))}
        />
      ) : (
        session && (
          <Composer
            session={session}
            busy={busy}
            usage={timeline.usage}
            onSend={(text) => run(() => api.prompt(id, text))}
            onCancel={() => run(() => api.cancel(id))}
            onMode={(m) => run(async () => {
              await api.setMode(id, m);
              setSession((s) => (s ? { ...s, mode: m } : s));
            })}
            models={session.models.length ? session.models : knownModels}
            onModel={(m) => run(async () => {
              await api.setModel(id, m);
              setSession((s) => (s ? { ...s, model: m } : s));
            })}
          />
        )
      )}

      {menuOpen && session && (
        <ActionSheet
          session={session}
          busy={busy}
          onClose={() => setMenuOpen(false)}
          run={run}
        />
      )}
    </div>
  );
}

function TimelineItem({ item }: { item: Item }) {
  switch (item.type) {
    case 'user':
      return <div className="bubble user">{item.text}</div>;
    case 'agent':
      return (
        <div className="bubble agent">
          <Markdown text={item.text} />
        </div>
      );
    case 'thought':
      return (
        <details className="thought">
          <summary>思考</summary>
          <Markdown text={item.text} />
        </details>
      );
    case 'tool':
      return <ToolCard tool={item} />;
    case 'plan':
      return (
        <div className="plan card">
          <div className="small muted">計画</div>
          <ul>
            {item.entries.map((e, i) => (
              <li key={i} className={`plan-${e.status}`}>
                {e.status === 'completed' ? '☑' : e.status === 'in_progress' ? '▶' : '☐'} {e.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'permission':
      return (
        <div className="system small">
          🔐 {item.toolCall.title ?? 'ツール実行'}:{' '}
          {item.outcome === null
            ? '承認待ち'
            : (outcomeLabel[item.outcome] ?? optionName(item.options.find((o) => o.optionId === item.outcome) ?? { optionId: item.outcome, name: item.outcome }))}
        </div>
      );
    case 'system':
      return <div className={`system small level-${item.level}`}>{item.text}</div>;
    case 'turn_end':
      return (
        <div className="turn-end small muted">
          {item.stopReason === 'end_turn' ? '完了' : item.stopReason === 'cancelled' ? '停止しました' : item.stopReason}
          {item.tokens ? ` · ${formatTokens(item.tokens)} tokens` : ''}
        </div>
      );
  }
}

function PermissionSheet({ item, onAnswer }: { item: PermissionItem; onAnswer: (optionId: string | null) => void }) {
  const [sending, setSending] = useState(false);
  const answer = (optionId: string | null) => {
    setSending(true);
    onAnswer(optionId);
  };
  const order = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 } as Record<string, number>;
  const options = [...item.options].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  return (
    <div className="sheet permission-sheet">
      <div className="sheet-title">🔐 実行の許可</div>
      <div className="permission-tool">{item.toolCall.title}</div>
      {item.toolCall.content && item.toolCall.content.length > 0 && (
        <div className="permission-body">
          <ToolContentView content={item.toolCall.content} />
        </div>
      )}
      <div className="permission-actions">
        {options.map((o) => (
          <button
            key={o.optionId}
            disabled={sending}
            className={o.kind.startsWith('allow') ? (o.kind === 'allow_once' ? 'primary' : 'secondary') : 'danger'}
            onClick={() => answer(o.optionId)}
          >
            {optionName(o)}
          </button>
        ))}
        {!options.some((o) => o.kind.startsWith('reject')) && (
          <button className="danger" disabled={sending} onClick={() => answer(null)}>
            拒否
          </button>
        )}
      </div>
    </div>
  );
}

function Composer(props: {
  session: SessionInfo;
  busy: boolean;
  usage: { used: number; size: number } | null;
  onSend: (text: string) => Promise<boolean>;
  onCancel: () => void;
  onMode: (mode: string) => void;
  models: ModelInfo[];
  onModel: (modelId: string) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    const ok = await props.onSend(text);
    setSending(false);
    if (ok) setText('');
  };

  const modes = props.session.modes.length
    ? props.session.modes.map((m) => m.id)
    : ['default', 'autoEdit', 'yolo'];
  const nextMode = modes[(modes.indexOf(props.session.mode) + 1) % modes.length];

  return (
    <div className="composer">
      <div className="composer-meta">
        <button className="chip" onClick={() => props.onMode(nextMode)} title="承認モードを切り替え">
          {modeLabel[props.session.mode] ?? props.session.mode}
        </button>
        <ModelPicker className="chip" value={props.session.model} models={props.models} onChange={props.onModel} />
        {props.usage && props.usage.size > 0 && (
          <span className="muted small">文脈 {Math.round((props.usage.used / props.usage.size) * 100)}%</span>
        )}
      </div>
      <div className="composer-row">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={props.busy ? '実行中…' : '続けて指示する'}
          onChange={(e) => setText(e.target.value)}
          disabled={sending}
        />
        {props.busy ? (
          <button className="send stop" onClick={props.onCancel} aria-label="停止">
            ■
          </button>
        ) : (
          <button className="send" onClick={send} disabled={sending || !text.trim()} aria-label="送信">
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

function ActionSheet(props: {
  session: SessionInfo;
  busy: boolean;
  onClose: () => void;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { session, onClose, run } = props;
  const [working, setWorking] = useState('');
  const act = (label: string, fn: () => Promise<unknown>) => async () => {
    setWorking(label);
    await run(fn);
    setWorking('');
    onClose();
  };
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet action-sheet" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => navigate(`#/s/${session.id}/diff`)}>差分を見る</button>
        <button disabled={props.busy || !!working} onClick={act('push', () => api.push(session.id))}>
          {working === 'push' ? 'push 中…' : 'コミットして push'}
        </button>
        {session.pr_url ? (
          <a className="sheet-link" href={session.pr_url} target="_blank" rel="noreferrer">
            PR を開く ↗
          </a>
        ) : (
          <button
            disabled={props.busy || !!working}
            onClick={act('pr', async () => {
              const { url } = await api.pr(session.id);
              window.open(url, '_blank');
            })}
          >
            {working === 'pr' ? 'PR 作成中…' : 'PR を作成'}
          </button>
        )}
        <button disabled={!session.live} onClick={act('stop', () => api.stop(session.id))}>
          Gemini CLI を終了（メモリ解放）
        </button>
        <button
          className="danger-text"
          onClick={act('remove', async () => {
            if (!confirm('セッションとワークスペースを削除します。push していない変更は失われます。')) return;
            await api.remove(session.id);
            navigate('#/');
          })}
        >
          セッションを削除
        </button>
        <button className="cancel" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
