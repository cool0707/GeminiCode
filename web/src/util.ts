import type { SessionStatus } from './api';

export const statusLabel: Record<SessionStatus, string> = {
  starting: '準備中',
  idle: '待機中',
  running: '実行中',
  waiting: '承認待ち',
  stopped: '停止',
  error: 'エラー',
};

export function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return new Date(ms).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const modeLabel: Record<string, string> = {
  default: '毎回確認',
  autoEdit: '編集は自動',
  yolo: 'すべて自動',
  plan: '計画のみ',
};
