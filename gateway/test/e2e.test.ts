import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/config.js';
import { Db } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/sessions.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geminicode-test-'));
const remoteRoot = path.join(tmp, 'remote');
const bare = path.join(remoteRoot, 'owner/repo.git');
const pulls: any[] = [];
let ghServer: http.Server;
let app: FastifyInstance;
let sessions: SessionManager;
let db: Db;
let cfg: Config;

function sh(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

before(async () => {
  // A local bare repository stands in for github.com.
  fs.mkdirSync(bare, { recursive: true });
  sh(['init', '--bare', '-b', 'main'], bare);
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  sh(['init', '-b', 'main'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# repo\n');
  sh(['add', '.'], seed);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], seed);
  sh(['push', bare, 'main'], seed);

  // A minimal fake of the GitHub REST endpoints we use.
  ghServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url ?? '';
      if (req.headers.authorization !== 'Bearer gh-token') return res.writeHead(401).end('{}');
      if (url.startsWith('/user/repos')) return res.end(JSON.stringify([{ full_name: 'owner/repo', default_branch: 'main', private: true }]));
      if (url === '/repos/owner/repo') return res.end(JSON.stringify({ full_name: 'owner/repo', default_branch: 'main', private: true }));
      if (url.startsWith('/repos/owner/repo/pulls') && req.method === 'GET') return res.end(JSON.stringify(pulls));
      if (url === '/repos/owner/repo/pulls' && req.method === 'POST') {
        const pr = { ...JSON.parse(body), html_url: 'https://github.com/owner/repo/pull/1' };
        pulls.push(pr);
        return res.writeHead(201).end(JSON.stringify(pr));
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => ghServer.listen(0, '127.0.0.1', r));
  const ghPort = (ghServer.address() as { port: number }).port;

  const agentBin = path.join(tmp, 'fake-gemini');
  fs.writeFileSync(agentBin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, 'fake-agent.js')}" "$@"\n`, { mode: 0o755 });

  cfg = {
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(tmp, 'data'),
    webDir: path.join(tmp, 'no-web'),
    geminiBin: agentBin,
    geminiArgs: [],
    geminiApiKey: 'test-key',
    githubToken: 'gh-token',
    githubApiBase: `http://127.0.0.1:${ghPort}`,
    githubGitBase: `file://${remoteRoot}`,
    gitAuthorName: 'Test',
    gitAuthorEmail: 'test@example.com',
    cfAccessTeamDomain: '',
    cfAccessAud: '',
    allowedEmails: [],
    insecureNoAuth: true,
    idleTimeoutMs: 0,
    startupTimeoutMs: 3000,
    geminiHome: path.join(tmp, 'gemini-home'),
    defaultModel: 'auto',
    auth: 'api-key',
    dailyTokenLimit: 0,
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  db = new Db(path.join(cfg.dataDir, 'test.db'));
  sessions = new SessionManager(cfg, db);
  app = await buildServer(cfg, sessions);
  app.log.level = 'warn';
  await app.listen({ host: '127.0.0.1', port: 0 });
});

after(async () => {
  sessions.shutdown();
  await app.close();
  ghServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-geminicode': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({ method: method as 'GET', url, headers, payload: body as object });
  return { status: res.statusCode, json: res.json() };
}

/** Number of live processes whose working directory is dir (Linux /proc). */
function processesIn(dir: string): number {
  let n = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (fs.readlinkSync(`/proc/${pid}/cwd`) === dir) n++;
    } catch {
      // Process exited or not ours.
    }
  }
  return n;
}

async function waitFor<T>(fn: () => T | undefined | false, label: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('rejects state-changing requests without the X-GeminiCode header', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
  assert.equal(res.statusCode, 403);
});

test('lists repositories through the GitHub API', async () => {
  const { status, json } = await api('GET', '/api/repos');
  assert.equal(status, 200);
  assert.equal(json[0].fullName, 'owner/repo');
  assert.equal(json[0].defaultBranch, 'main');
});

test('lists models by probing Gemini CLI once', async () => {
  const { status, json } = await api('GET', '/api/models');
  assert.equal(status, 200);
  assert.equal(json.default, 'auto');
  assert.deepEqual(json.models.map((m: any) => m.modelId), ['auto', 'gemini-3-flash-preview']);
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'models.json')), 'cached for next time');
});

test('full session: clone, permission, diff, PR, resume', async () => {
  const created = await api('POST', '/api/sessions', { repo: 'owner/repo', prompt: 'please edit a file' });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id: string = created.json.id;
  assert.match(created.json.branch, /^gemini\/please-edit-a-file-/);

  const perm = await waitFor(
    () => db.eventsAfter(id, 0).find((e) => e.kind === 'permission'),
    'permission request',
  );
  assert.equal(db.getSession(id)?.status, 'waiting');
  const { requestId, options } = perm.data as any;
  assert.equal(options[0].optionId, 'proceed_once');

  assert.equal((await api('POST', `/api/sessions/${id}/permission`, { requestId, optionId: 'proceed_once' })).status, 200);
  await waitFor(() => db.getSession(id)?.status === 'idle', 'idle after first turn');

  const kinds = db.eventsAfter(id, 0).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'system'), ['user', 'update', 'permission', 'permission_resolved', 'update', 'update', 'update', 'update', 'update', 'update', 'update', 'turn_end']);

  const diff = await api('GET', `/api/sessions/${id}/diff`);
  assert.deepEqual(diff.json.files, [{ path: 'hello.txt', added: 1, removed: 0 }]);
  assert.match(diff.json.diff, /\+hello/);

  const pr = await api('POST', `/api/sessions/${id}/pr`);
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  assert.equal(pr.json.url, 'https://github.com/owner/repo/pull/1');
  assert.equal(pulls[0].head, created.json.branch);
  assert.equal(pulls[0].base, 'main');
  assert.match(sh(['branch', '--list'], bare), new RegExp(created.json.branch.replace('/', '\\/')));

  // Kill the agent; the next prompt must respawn it and resume via session/load
  // without duplicating the replayed history into our log.
  await api('POST', `/api/sessions/${id}/stop`);
  await waitFor(() => db.getSession(id)?.status === 'stopped', 'stopped');
  const before = db.eventsAfter(id, 0).at(-1)!.seq;
  assert.equal((await api('POST', `/api/sessions/${id}/prompt`, { text: 'hi again' })).status, 200);
  await waitFor(() => db.eventsAfter(id, before).some((e) => e.kind === 'turn_end'), 'second turn');
  const texts = db.eventsAfter(id, before).map((e) => JSON.stringify(e.data));
  assert.ok(!texts.some((t) => t.includes('replayed')));
  assert.ok(texts.some((t) => t.includes('hi again')));

  assert.equal((await api('GET', '/api/me')).json.usage.today, 20);
});

test('stream replays the log after Last-Event-ID', async () => {
  const id = db.listSessions()[0].id;
  const all = db.eventsAfter(id, 0);
  const address = app.server.address() as { port: number };
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${address.port}/api/stream?session=${id}`, {
    headers: { 'last-event-id': String(all[2].seq) },
    signal: ctrl.signal,
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  let text = '';
  while ((text.match(/^id: /gm) ?? []).length < all.length - 3) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
  }
  ctrl.abort();
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids, all.slice(3).map((e) => e.seq));
});

test('denied permission ends the turn as cancelled', async () => {
  const created = await api('POST', '/api/sessions', { repo: 'owner/repo', prompt: 'edit but deny' });
  const id: string = created.json.id;
  const perm = await waitFor(() => db.eventsAfter(id, 0).find((e) => e.kind === 'permission'), 'permission');
  await api('POST', `/api/sessions/${id}/permission`, { requestId: (perm.data as any).requestId, optionId: 'cancel' });
  const end = await waitFor(() => db.eventsAfter(id, 0).find((e) => e.kind === 'turn_end'), 'turn end');
  assert.equal((end.data as any).stopReason, 'cancelled');
  const diff = await api('GET', `/api/sessions/${id}/diff`);
  assert.deepEqual(diff.json.files, []);
  assert.equal((await api('DELETE', `/api/sessions/${id}`)).status, 200);
  assert.equal(db.getSession(id), undefined);
});

test('readableError unwraps nested API error JSON', async () => {
  const { readableError } = await import('../src/sessions.js');
  const nested = JSON.stringify({ error: { message: JSON.stringify({ error: { code: 400, message: 'API key not valid.' } }) } });
  assert.equal(readableError(nested), 'API key not valid.');
  assert.equal(readableError('plain text'), 'plain text');
});

test('a saved Google login does not hang the session forever', async () => {
  const settings = path.join(tmp, 'gemini-home', '.gemini', 'settings.json');
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).security.auth.selectedType, 'gemini-api-key');
  const original = fs.readFileSync(settings, 'utf8');
  fs.writeFileSync(settings, JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }));
  try {
    const created = await api('POST', '/api/sessions', { repo: 'owner/repo', prompt: 'hello' });
    const id: string = created.json.id;
    await waitFor(() => db.getSession(id)?.status === 'error', 'startup timeout', 10_000);
    const error = db.getSession(id)!.error!;
    assert.match(error, /起動しませんでした/);
    assert.match(error, /Please visit the following URL/);
    assert.ok(!error.includes('\x1b'), 'ANSI escapes are stripped');
    const errors = db.eventsAfter(id, 0).filter((e) => e.kind === 'system' && (e.data as any).level === 'error');
    assert.equal(errors.length, 1, 'reported once, not again when the killed agent exits');
  } finally {
    fs.writeFileSync(settings, original);
  }
});

test('chosen model is applied, retries are shown once each, and the model can be switched', async () => {
  const created = await api('POST', '/api/sessions', {
    repo: 'owner/repo',
    prompt: 'busy model check',
    model: 'gemini-3-flash-preview',
  });
  const id: string = created.json.id;
  assert.equal(created.json.model, 'gemini-3-flash-preview');
  await waitFor(() => db.getSession(id)?.status === 'idle', 'turn with retries', 15_000);
  const texts = () => db.eventsAfter(id, 0).map((e) => JSON.stringify(e.data)).join('\n');
  const retries = db.eventsAfter(id, 0).filter((e) => e.kind === 'system' && /リトライしています/.test((e.data as any).text));
  assert.deepEqual(
    retries.map((e) => (e.data as any).text.match(/（(\d+) 回目）/)[1]),
    ['1', '2'],
    'one notice per attempt even though both stderr and the debug log report it',
  );
  assert.match((retries[0].data as any).text, /混雑/);
  assert.match(texts(), /model: gemini-3-flash-preview/);
  assert.match(texts(), /apikey=set/);

  assert.equal((await api('POST', `/api/sessions/${id}/model`, { modelId: 'auto' })).status, 200);
  assert.equal(db.getSession(id)?.model, 'auto');
  const before = db.eventsAfter(id, 0).at(-1)!.seq;
  await api('POST', `/api/sessions/${id}/prompt`, { text: 'again' });
  await waitFor(() => db.eventsAfter(id, before).some((e) => e.kind === 'turn_end'), 'second turn');
  assert.match(db.eventsAfter(id, before).map((e) => JSON.stringify(e.data)).join('\n'), /model: auto/);
});

test('stop ends a turn the agent will not cancel, and the session resumes afterwards', async () => {
  const created = await api('POST', '/api/sessions', { repo: 'owner/repo', prompt: 'hang forever' });
  const id: string = created.json.id;
  await waitFor(() => db.getSession(id)?.status === 'running' && db.eventsAfter(id, 0).length >= 3, 'running');
  await new Promise((r) => setTimeout(r, 300));
  await api('POST', `/api/sessions/${id}/cancel`);
  await waitFor(() => db.getSession(id)?.status === 'stopped', 'stopped after grace period', 10_000);
  const events = db.eventsAfter(id, 0);
  assert.equal(db.getSession(id)?.error, null);
  assert.ok(!events.some((e) => e.kind === 'system' && (e.data as any).level === 'error'), 'not reported as an error');
  assert.equal((events.findLast((e) => e.kind === 'turn_end')!.data as any).stopReason, 'cancelled');

  const workdir = db.getSession(id)!.workdir;
  await waitFor(() => processesIn(workdir) === 0, 'agent and its relaunched child gone', 5000);

  const before = events[events.length - 1].seq;
  assert.equal((await api('POST', `/api/sessions/${id}/prompt`, { text: 'resume' })).status, 200);
  await waitFor(() => db.eventsAfter(id, before).some((e) => e.kind === 'turn_end'), 'resumed turn');
  assert.equal(db.getSession(id)?.status, 'idle');
  // The first turn never completed, so the agent had nothing saved to load.
  assert.ok(
    db.eventsAfter(id, before).some((e) => e.kind === 'system' && /新しい会話として続けます/.test((e.data as any).text)),
    'falls back to a new agent conversation',
  );
});

test('Google login mode: asks for the login instead of hanging, then works once logged in', async () => {
  const gcfg: Config = {
    ...cfg,
    auth: 'google',
    geminiApiKey: '',
    dataDir: path.join(tmp, 'data-google'),
    geminiHome: path.join(tmp, 'gemini-home-google'),
  };
  fs.mkdirSync(gcfg.dataDir, { recursive: true });
  const gdb = new Db(path.join(gcfg.dataDir, 'test.db'));
  const gsessions = new SessionManager(gcfg, gdb);
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(gcfg.geminiHome, '.gemini', 'settings.json'), 'utf8'));
    assert.equal(settings.security.auth.selectedType, 'oauth-personal');

    // Not logged in yet: the model list falls back instead of hanging, and a session fails fast.
    assert.deepEqual((await gsessions.models()).models.map((m) => m.modelId), ['auto']);
    const row = await gsessions.create({ repo: 'owner/repo', prompt: 'hello google' });
    await waitFor(() => gdb.getSession(row.id)?.status === 'error', 'login required', 5000);
    assert.match(gdb.getSession(row.id)!.error!, /ログインが済んでいません[\s\S]*login-google\.sh/);

    // After deploy/login-google.sh has stored credentials, the same session works.
    fs.writeFileSync(path.join(gcfg.geminiHome, '.gemini', 'gemini-credentials.json'), '{}');
    await gsessions.prompt(row.id, 'hello again');
    await waitFor(() => gdb.getSession(row.id)?.status === 'idle', 'turn with Google login', 10_000);
    const said = gdb.eventsAfter(row.id, 0).map((e) => JSON.stringify(e.data)).join('\n');
    assert.match(said, /hello again/);
    assert.match(said, /apikey=unset/, 'the API key is not passed to the agent in Google login mode');
  } finally {
    gsessions.shutdown();
  }
});
