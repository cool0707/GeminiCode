import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AcpClient, type PermissionOutcome, type PermissionRequest } from './acp.js';
import type { Config } from './config.js';
import type { Db, EventRow, SessionRow, SessionStatus } from './db.js';
import { cloneWorkspace, commitAndPush, diffWorkspace, GitHub } from './git.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface PendingPermission {
  requestId: string;
  respond: (outcome: PermissionOutcome) => void;
}

interface LiveAgent {
  client: AcpClient;
  acpSessionId: string;
  ready: Promise<void>;
  loading: boolean;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
  permissions: Map<string, PendingPermission>;
  modes: { id: string; name: string; description?: string }[];
  models: { modelId: string; name: string }[];
}

export interface CreateSessionInput {
  repo: string;
  baseBranch?: string;
  prompt: string;
  mode?: string;
  model?: string;
}

export interface SessionManagerEvents {
  event: [EventRow];
  session: [SessionRow];
}

const ACTIVE: SessionStatus[] = ['starting', 'idle', 'running', 'waiting'];

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private agents = new Map<string, LiveAgent>();
  readonly gh: GitHub;

  constructor(private cfg: Config, private db: Db) {
    super();
    this.gh = new GitHub(cfg);
    fs.mkdirSync(path.join(cfg.dataDir, 'workspaces'), { recursive: true });
    fs.mkdirSync(path.join(cfg.dataDir, 'logs'), { recursive: true });
    this.recoverAfterRestart();
  }

  /** The gateway owns no agent processes at startup: close out whatever the previous run left open. */
  private recoverAfterRestart(): void {
    for (const s of this.db.listSessions()) {
      if (!ACTIVE.includes(s.status)) continue;
      const unresolved = this.unresolvedPermissions(s.id);
      for (const requestId of unresolved) this.append(s.id, 'permission_resolved', { requestId, outcome: 'expired' });
      if (s.status === 'running' || s.status === 'waiting' || s.status === 'starting') {
        this.append(s.id, 'system', { level: 'warn', text: 'ゲートウェイの再起動で処理が中断されました。続きを送信すると再開します。' });
      }
    }
    this.db.markAllStopped();
  }

  private unresolvedPermissions(sessionId: string): string[] {
    const open = new Set<string>();
    for (const e of this.db.eventsAfter(sessionId, 0)) {
      const d = e.data as { requestId?: string };
      if (e.kind === 'permission' && d.requestId) open.add(d.requestId);
      if (e.kind === 'permission_resolved' && d.requestId) open.delete(d.requestId);
    }
    return [...open];
  }

  private append(sessionId: string, kind: string, data: unknown): EventRow {
    const row = this.db.appendEvent(sessionId, kind, data);
    this.emit('event', row);
    return row;
  }

  private setStatus(id: string, status: SessionStatus, extra: Partial<SessionRow> = {}): void {
    this.db.updateSession(id, { status, ...extra });
    const row = this.db.getSession(id);
    if (row) this.emit('session', row);
  }

  list(): SessionRow[] {
    return this.db.listSessions();
  }

  get(id: string): SessionRow {
    const row = this.db.getSession(id);
    if (!row) throw new HttpError(404, 'session not found');
    return row;
  }

  info(id: string) {
    const row = this.get(id);
    const live = this.agents.get(id);
    return { ...row, live: !!live, modes: live?.modes ?? [], models: live?.models ?? [] };
  }

  events(id: string, after: number): EventRow[] {
    this.get(id);
    return this.db.eventsAfter(id, after);
  }

  async create(input: CreateSessionInput): Promise<SessionRow> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'prompt is required');
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo ?? '')) throw new HttpError(400, 'repo must be "owner/name"');
    this.checkUsage();

    const id = randomUUID();
    const short = id.slice(0, 6);
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
    const now = Date.now();
    const row: SessionRow = {
      id,
      title: prompt.split('\n')[0].slice(0, 80),
      repo: input.repo,
      base_branch: input.baseBranch?.trim() || '',
      branch: `gemini/${slug || 'session'}-${short}`,
      workdir: path.join(this.cfg.dataDir, 'workspaces', id),
      acp_session_id: null,
      status: 'starting',
      mode: input.mode || 'default',
      model: input.model || 'auto',
      pr_url: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.db.insertSession(row);
    this.emit('session', row);
    this.append(id, 'user', { text: prompt });

    void (async () => {
      try {
        if (!row.base_branch) {
          row.base_branch = (await this.gh.getRepo(row.repo)).defaultBranch;
          this.db.updateSession(id, { base_branch: row.base_branch });
        }
        this.append(id, 'system', { level: 'info', text: `${row.repo} (${row.base_branch}) を clone しています…` });
        await cloneWorkspace(this.gh, this.cfg, {
          repo: row.repo,
          baseBranch: row.base_branch,
          branch: row.branch,
          dir: row.workdir,
        });
        this.append(id, 'system', { level: 'info', text: `ブランチ ${row.branch} を作成しました。` });
        await this.runTurn(id, prompt);
      } catch (err) {
        this.fail(id, err);
      }
    })();
    return row;
  }

  private fail(id: string, err: unknown): void {
    const message = readableError(err instanceof Error ? err.message : String(err));
    this.append(id, 'system', { level: 'error', text: message });
    this.setStatus(id, 'error', { error: message });
  }

  private checkUsage(): void {
    if (this.cfg.dailyTokenLimit > 0 && this.db.usageToday() >= this.cfg.dailyTokenLimit) {
      throw new HttpError(429, `本日のトークン上限 (${this.cfg.dailyTokenLimit}) に達しました`);
    }
  }

  usage() {
    return { today: this.db.usageToday(), limit: this.cfg.dailyTokenLimit };
  }

  private agentEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_API_KEY: this.cfg.geminiApiKey };
    // The agent runs shell commands on the model's behalf: keep gateway secrets out of its reach.
    for (const k of ['GITHUB_TOKEN', 'CF_ACCESS_AUD', 'CF_ACCESS_TEAM_DOMAIN']) delete env[k];
    return env;
  }

  private ensureAgent(id: string): LiveAgent {
    const existing = this.agents.get(id);
    if (existing && !existing.client.exited) return existing;

    const row = this.get(id);
    const client = new AcpClient(this.cfg.geminiBin, ['--acp', '--skip-trust', ...this.cfg.geminiArgs], {
      cwd: row.workdir,
      env: this.agentEnv(),
    });
    const log = fs.createWriteStream(path.join(this.cfg.dataDir, 'logs', `${id}.log`), { flags: 'a' });
    let stderrTail = '';
    client.on('stderr', (s) => {
      log.write(s);
      stderrTail = (stderrTail + s).slice(-2000);
    });

    const live: LiveAgent = {
      client,
      acpSessionId: row.acp_session_id ?? '',
      loading: false,
      busy: false,
      permissions: new Map(),
      modes: [],
      models: [],
      ready: Promise.resolve(),
    };

    client.on('update', ({ update }) => {
      // session/load replays the whole conversation, which we already have in our own log.
      if (live.loading || update.sessionUpdate === 'available_commands_update') return;
      if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
        this.db.updateSession(id, { mode: update.currentModeId });
      }
      this.append(id, 'update', update);
    });

    client.on('permission', (req: PermissionRequest, respond) => {
      const requestId = randomUUID();
      live.permissions.set(requestId, { requestId, respond });
      this.append(id, 'permission', { requestId, toolCall: req.toolCall, options: req.options });
      this.setStatus(id, 'waiting');
    });

    client.on('exit', (code) => {
      log.end();
      clearTimeout(live.idleTimer);
      for (const p of live.permissions.values()) {
        this.append(id, 'permission_resolved', { requestId: p.requestId, outcome: 'expired' });
      }
      live.permissions.clear();
      if (this.agents.get(id) === live) this.agents.delete(id);
      const current = this.db.getSession(id);
      if (!current) return;
      if (live.busy) {
        this.fail(id, new Error(`Gemini CLI が異常終了しました (code ${code})\n${stderrTail.trim()}`));
      } else if (ACTIVE.includes(current.status)) {
        this.setStatus(id, 'stopped');
      }
    });

    live.ready = (async () => {
      const init = await client.initialize();
      let modes, models;
      if (row.acp_session_id && init.agentCapabilities?.loadSession) {
        live.loading = true;
        try {
          ({ modes, models } = await client.loadSession(row.acp_session_id, row.workdir));
        } finally {
          live.loading = false;
        }
      } else {
        const res = await client.newSession(row.workdir);
        live.acpSessionId = res.sessionId;
        ({ modes, models } = res);
        this.db.updateSession(id, { acp_session_id: res.sessionId });
      }
      live.modes = modes?.availableModes ?? [];
      live.models = models?.availableModels ?? [];
      if (modes && row.mode && modes.currentModeId !== row.mode) await client.setMode(live.acpSessionId, row.mode);
      if (models && row.model && models.currentModelId !== row.model) {
        await client.setModel(live.acpSessionId, row.model).catch((err: Error) => {
          this.append(id, 'system', { level: 'warn', text: `モデル ${row.model} を設定できませんでした: ${err.message}` });
        });
      }
    })();
    this.agents.set(id, live);
    return live;
  }

  private scheduleIdleStop(id: string, live: LiveAgent): void {
    clearTimeout(live.idleTimer);
    if (this.cfg.idleTimeoutMs <= 0) return;
    live.idleTimer = setTimeout(() => {
      if (!live.busy) live.client.kill();
    }, this.cfg.idleTimeoutMs);
  }

  private async runTurn(id: string, text: string): Promise<void> {
    const live = this.ensureAgent(id);
    live.busy = true;
    clearTimeout(live.idleTimer);
    this.setStatus(id, 'running', { error: null });
    try {
      await live.ready;
      const result = await live.client.prompt(live.acpSessionId, text);
      const tokens = result.usage?.totalTokens ?? 0;
      if (tokens) this.db.addUsage(tokens);
      this.append(id, 'turn_end', { stopReason: result.stopReason, usage: result.usage ?? null });
      live.busy = false;
      this.setStatus(id, 'idle');
      this.scheduleIdleStop(id, live);
    } catch (err) {
      live.busy = false;
      if (!live.client.exited) this.scheduleIdleStop(id, live);
      throw err;
    }
  }

  async prompt(id: string, text: string): Promise<void> {
    const row = this.get(id);
    text = text?.trim();
    if (!text) throw new HttpError(400, 'text is required');
    if (row.status === 'starting') throw new HttpError(409, 'セッションを準備中です');
    if (this.agents.get(id)?.busy) throw new HttpError(409, '前の指示を実行中です。停止してから送信してください');
    if (!fs.existsSync(row.workdir)) throw new HttpError(409, 'ワークスペースがありません');
    this.checkUsage();
    this.append(id, 'user', { text });
    this.runTurn(id, text).catch((err) => this.fail(id, err));
  }

  respondPermission(id: string, requestId: string, optionId: string | null): void {
    const live = this.agents.get(id);
    const pending = live?.permissions.get(requestId);
    if (!live || !pending) throw new HttpError(404, 'この確認はすでに終了しています');
    live.permissions.delete(requestId);
    pending.respond(optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' });
    this.append(id, 'permission_resolved', { requestId, outcome: optionId ?? 'cancelled' });
    if (live.permissions.size === 0 && live.busy) this.setStatus(id, 'running');
  }

  cancel(id: string): void {
    const live = this.agents.get(id);
    if (!live?.busy) return;
    for (const p of [...live.permissions.values()]) this.respondPermission(id, p.requestId, null);
    live.client.cancel(live.acpSessionId);
    this.append(id, 'system', { level: 'info', text: '停止を要求しました。' });
  }

  async setMode(id: string, modeId: string): Promise<void> {
    this.get(id);
    this.db.updateSession(id, { mode: modeId });
    const live = this.agents.get(id);
    if (live && !live.client.exited) {
      await live.ready;
      await live.client.setMode(live.acpSessionId, modeId);
    }
    this.emit('session', this.get(id));
  }

  stop(id: string): void {
    this.agents.get(id)?.client.kill();
  }

  async remove(id: string): Promise<void> {
    const row = this.get(id);
    const live = this.agents.get(id);
    if (live && !live.client.exited) {
      const exited = new Promise((r) => live.client.once('exit', r));
      live.client.kill();
      await exited;
    }
    await fs.promises.rm(row.workdir, { recursive: true, force: true });
    this.db.deleteSession(id);
  }

  async diff(id: string) {
    const row = this.get(id);
    if (!row.base_branch || !fs.existsSync(row.workdir)) return { diff: '', files: [] };
    return diffWorkspace(row.workdir, row.base_branch);
  }

  async push(id: string): Promise<{ commits: number }> {
    const row = this.get(id);
    if (this.agents.get(id)?.busy) throw new HttpError(409, '実行中は push できません');
    const commits = await commitAndPush(this.gh, {
      dir: row.workdir,
      branch: row.branch,
      baseBranch: row.base_branch,
      message: row.title,
    });
    this.append(id, 'system', {
      level: 'info',
      text: commits ? `${row.branch} に push しました（${commits} コミット）。` : 'push する変更がありません。',
    });
    return { commits };
  }

  async createPr(id: string): Promise<{ url: string }> {
    const row = this.get(id);
    const { commits } = await this.push(id);
    if (!commits) throw new HttpError(409, '変更がないため PR を作成できません');
    let url = row.pr_url ?? (await this.gh.findPull(row.repo, row.branch));
    if (!url) {
      url = await this.gh.createPull(row.repo, {
        head: row.branch,
        base: row.base_branch,
        title: row.title,
        body: `GeminiCode のセッションから作成しました。\n\n> ${row.title}`,
      });
      this.append(id, 'system', { level: 'info', text: `PR を作成しました: ${url}` });
    }
    this.db.updateSession(id, { pr_url: url });
    this.emit('session', this.get(id));
    return { url };
  }

  shutdown(): void {
    for (const live of this.agents.values()) live.client.kill();
  }
}

/** API errors arrive as JSON nested inside JSON strings; dig out the innermost message. */
export function readableError(message: string): string {
  for (let depth = 0; depth < 5; depth++) {
    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch {
      break;
    }
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner !== 'string') break;
    message = inner;
  }
  return message;
}
