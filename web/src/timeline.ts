// Folds the raw event log (ACP session updates + gateway events) into chat items.
import type { EventRow } from './api';

export interface ToolContent {
  type: string;
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
}

export interface ToolItem {
  type: 'tool';
  key: string;
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  content: ToolContent[];
  locations: { path: string; line?: number }[];
}

export interface PermissionItem {
  type: 'permission';
  key: string;
  requestId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; content?: ToolContent[] };
  options: { optionId: string; name: string; kind: string }[];
  outcome: string | null;
}

export type Item =
  | { type: 'user'; key: string; text: string; ts: number }
  | { type: 'agent'; key: string; text: string }
  | { type: 'thought'; key: string; text: string }
  | { type: 'plan'; key: string; entries: { content: string; status: string; priority?: string }[] }
  | { type: 'system'; key: string; level: string; text: string }
  | { type: 'turn_end'; key: string; stopReason: string; tokens: number | null }
  | ToolItem
  | PermissionItem;

export interface Timeline {
  items: Item[];
  usage: { used: number; size: number } | null;
}

export function emptyTimeline(): Timeline {
  return { items: [], usage: null };
}

/** Returns a new timeline with the event applied (items are replaced, never mutated in place). */
export function applyEvent(tl: Timeline, e: EventRow): Timeline {
  const items = tl.items.slice();
  const last = items[items.length - 1];
  const key = String(e.seq);
  const d = e.data;

  switch (e.kind) {
    case 'user':
      items.push({ type: 'user', key, text: d.text, ts: e.ts });
      break;
    case 'system':
      items.push({ type: 'system', key, level: d.level, text: d.text });
      break;
    case 'turn_end':
      items.push({ type: 'turn_end', key, stopReason: d.stopReason, tokens: d.usage?.totalTokens ?? null });
      break;
    case 'permission':
      items.push({ type: 'permission', key, requestId: d.requestId, toolCall: d.toolCall, options: d.options, outcome: null });
      break;
    case 'permission_resolved': {
      const i = items.findIndex((it) => it.type === 'permission' && it.requestId === d.requestId);
      if (i >= 0) items[i] = { ...(items[i] as PermissionItem), outcome: d.outcome };
      break;
    }
    case 'update': {
      const u = d;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk': {
          const type = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought';
          const text = u.content?.type === 'text' ? u.content.text : '';
          if (last && last.type === type) items[items.length - 1] = { ...last, text: last.text + text };
          else items.push({ type, key, text });
          break;
        }
        case 'tool_call': {
          const i = items.findIndex((it) => it.type === 'tool' && it.toolCallId === u.toolCallId);
          const tool: ToolItem = {
            type: 'tool',
            key,
            toolCallId: u.toolCallId,
            title: u.title ?? 'ツール',
            kind: u.kind ?? 'other',
            status: u.status ?? 'pending',
            content: u.content ?? [],
            locations: u.locations ?? [],
          };
          if (i >= 0) items[i] = { ...tool, key: items[i].key };
          else items.push(tool);
          break;
        }
        case 'tool_call_update': {
          const i = items.findIndex((it) => it.type === 'tool' && it.toolCallId === u.toolCallId);
          if (i < 0) break;
          const prev = items[i] as ToolItem;
          items[i] = {
            ...prev,
            title: u.title ?? prev.title,
            kind: u.kind ?? prev.kind,
            status: u.status ?? prev.status,
            content: u.content ?? prev.content,
            locations: u.locations ?? prev.locations,
          };
          break;
        }
        case 'plan':
          if (last?.type === 'plan') items[items.length - 1] = { ...last, entries: u.entries };
          else items.push({ type: 'plan', key, entries: u.entries ?? [] });
          break;
        case 'usage_update':
          return { items, usage: { used: u.used, size: u.size } };
      }
      break;
    }
  }
  return { ...tl, items };
}

export function pendingPermission(tl: Timeline): PermissionItem | undefined {
  return tl.items.find((it): it is PermissionItem => it.type === 'permission' && it.outcome === null);
}
