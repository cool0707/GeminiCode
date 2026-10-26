import { useState } from 'react';
import type { ToolContent, ToolItem } from '../timeline';
import { lineDiff } from '../lineDiff';

const kindIcon: Record<string, string> = {
  read: '📄',
  edit: '✏️',
  delete: '🗑',
  move: '↔',
  search: '🔍',
  execute: '▶',
  think: '💭',
  fetch: '🌐',
  other: '🔧',
};

const statusIcon: Record<string, string> = {
  pending: '…',
  in_progress: '⏳',
  completed: '✓',
  failed: '✕',
};

export function ToolContentView({ content }: { content: ToolContent[] }) {
  return (
    <>
      {content.map((c, i) => {
        if (c.type === 'diff') return <InlineDiff key={i} path={c.path ?? ''} oldText={c.oldText ?? ''} newText={c.newText ?? ''} />;
        if (c.type === 'content' && c.content?.type === 'text') {
          return (
            <pre key={i} className="tool-output">
              {c.content.text}
            </pre>
          );
        }
        return null;
      })}
    </>
  );
}

export function InlineDiff({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const lines = lineDiff(oldText, newText);
  return (
    <div className="inline-diff">
      <div className="diff-path mono">{path}</div>
      <pre className="diff-body">
        {lines.map((l, i) =>
          l === null ? (
            <div key={i} className="diff-gap">
              ⋯
            </div>
          ) : (
            <div key={i} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}>
              {l.op}
              {l.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false);
  const hasBody = tool.content.length > 0 || tool.locations.length > 0;
  return (
    <div className={`tool-card status-${tool.status}`}>
      <button className="tool-head" onClick={() => hasBody && setOpen(!open)} aria-expanded={open}>
        <span className="tool-kind">{kindIcon[tool.kind] ?? kindIcon.other}</span>
        <span className="tool-title ellipsis">{tool.title}</span>
        <span className={`tool-status ${tool.status}`}>{statusIcon[tool.status] ?? tool.status}</span>
        {hasBody && <span className="chevron">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <div className="tool-body">
          {tool.locations.map((l, i) => (
            <div key={i} className="muted small mono">
              {l.path}
              {l.line ? `:${l.line}` : ''}
            </div>
          ))}
          <ToolContentView content={tool.content} />
        </div>
      )}
    </div>
  );
}
