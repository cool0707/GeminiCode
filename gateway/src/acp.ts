// Minimal ACP (Agent Client Protocol) client: newline-delimited JSON-RPC 2.0
// over the stdio of a `gemini --acp` child process.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequest {
  sessionId: string;
  options: PermissionOption[];
  toolCall: Record<string, unknown> & { toolCallId: string; title?: string };
}

export type PermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };

export interface SessionUpdateParams {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate: string };
}

export interface PromptResult {
  stopReason: string;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
}

export interface NewSessionResult {
  sessionId: string;
  modes?: { availableModes: { id: string; name: string; description?: string }[]; currentModeId: string };
  models?: { availableModels: { modelId: string; name: string; description?: string }[]; currentModelId: string };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class AcpError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

export interface AcpClientEvents {
  update: [SessionUpdateParams];
  permission: [PermissionRequest, (outcome: PermissionOutcome) => void];
  stderr: [string];
  exit: [number | null];
}

export class AcpClient extends EventEmitter<AcpClientEvents> {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  exited = false;

  constructor(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    super();
    this.proc = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: 'pipe' });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => this.emit('stderr', chunk));
    this.proc.on('error', (err) => this.onExit(null, err));
    this.proc.on('exit', (code) => this.onExit(code));
  }

  private onExit(code: number | null, err?: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) p.reject(err ?? new Error(`agent exited (code ${code})`));
    this.pending.clear();
    this.emit('exit', code);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('stderr', `[non-JSON stdout] ${line}\n`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AcpError(msg.error.message ?? 'ACP error', msg.error.code ?? -1));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'session/update') {
      this.emit('update', msg.params);
      return;
    }
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      let answered = false;
      this.emit('permission', msg.params, (outcome) => {
        if (answered) return;
        answered = true;
        this.write({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
      });
      return;
    }
    if (msg.id !== undefined) {
      // We advertise no fs/terminal capabilities, so any other request is unexpected.
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
    }
  }

  private write(msg: unknown): void {
    if (this.exited) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error('agent is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  initialize() {
    return this.request<{ protocolVersion: number; agentCapabilities?: { loadSession?: boolean } }>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'geminicode', version: '0.1.0' },
    });
  }

  newSession(cwd: string) {
    return this.request<NewSessionResult>('session/new', { cwd, mcpServers: [] });
  }

  loadSession(sessionId: string, cwd: string) {
    return this.request<Omit<NewSessionResult, 'sessionId'>>('session/load', { sessionId, cwd, mcpServers: [] });
  }

  prompt(sessionId: string, text: string) {
    return this.request<PromptResult>('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  }

  setMode(sessionId: string, modeId: string) {
    return this.request<unknown>('session/set_mode', { sessionId, modeId });
  }

  setModel(sessionId: string, modelId: string) {
    return this.request<unknown>('session/set_model', { sessionId, modelId });
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  kill(): void {
    if (!this.exited) this.proc.kill('SIGTERM');
  }
}
