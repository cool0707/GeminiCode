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

  const cfg: Config = {
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
  assert.deepEqual(kinds.filter((k) => k !== 'system'), ['user', 'update', 'permission', 'permission_resolved', 'update', 'update', 'update', 'update', 'update', 'turn_end']);

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
  const before = db.eventsAfter(id, 0).length;
  assert.equal((await api('POST', `/api/sessions/${id}/prompt`, { text: 'hi again' })).status, 200);
  await waitFor(() => db.eventsAfter(id, 0).some((e) => e.kind === 'turn_end' && e.seq > before + 1), 'second turn');
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
