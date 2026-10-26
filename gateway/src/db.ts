import { DatabaseSync } from 'node:sqlite';

export type SessionStatus = 'starting' | 'idle' | 'running' | 'waiting' | 'stopped' | 'error';

export interface SessionRow {
  id: string;
  title: string;
  repo: string;
  base_branch: string;
  branch: string;
  workdir: string;
  acp_session_id: string | null;
  status: SessionStatus;
  mode: string;
  model: string;
  pr_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  seq: number;
  session_id: string;
  ts: number;
  kind: string;
  data: unknown;
}

export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        branch TEXT NOT NULL,
        workdir TEXT NOT NULL,
        acp_session_id TEXT,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT NOT NULL,
        pr_url TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events (session_id, seq);
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT PRIMARY KEY,
        tokens INTEGER NOT NULL
      );
    `);
  }

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, repo, base_branch, branch, workdir, acp_session_id, status, mode, model, pr_url, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.title, row.repo, row.base_branch, row.branch, row.workdir, row.acp_session_id,
        row.status, row.mode, row.model, row.pr_url, row.error, row.created_at, row.updated_at,
      );
  }

  updateSession(id: string, fields: Partial<Omit<SessionRow, 'id'>>): void {
    const entries = Object.entries({ ...fields, updated_at: Date.now() });
    const sql = `UPDATE sessions SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, v]) => v as string | number | null), id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[];
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  appendEvent(sessionId: string, kind: string, data: unknown): EventRow {
    const ts = Date.now();
    const res = this.db
      .prepare('INSERT INTO events (session_id, ts, kind, data) VALUES (?, ?, ?, ?)')
      .run(sessionId, ts, kind, JSON.stringify(data));
    return { seq: Number(res.lastInsertRowid), session_id: sessionId, ts, kind, data };
  }

  eventsAfter(sessionId: string, after: number): EventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, after) as unknown as (Omit<EventRow, 'data'> & { data: string })[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  /** Marks sessions left running by a previous gateway process as stopped. */
  markAllStopped(): void {
    this.db
      .prepare(`UPDATE sessions SET status = 'stopped' WHERE status IN ('starting', 'idle', 'running', 'waiting')`)
      .run();
  }

  addUsage(tokens: number): void {
    this.db
      .prepare('INSERT INTO usage (day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens')
      .run(today(), tokens);
  }

  usageToday(): number {
    const row = this.db.prepare('SELECT tokens FROM usage WHERE day = ?').get(today()) as { tokens: number } | undefined;
    return row?.tokens ?? 0;
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
