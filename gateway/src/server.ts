import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createAuth, type AuthedRequest } from './auth.js';
import type { Config } from './config.js';
import type { EventRow, SessionRow } from './db.js';
import { GitError } from './git.js';
import { HttpError, type SessionManager } from './sessions.js';

export async function buildServer(cfg: Config, sessions: SessionManager): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const auth = createAuth(cfg);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    await auth(req, reply);
    if (reply.sent) return;
    // Cross-site requests cannot set custom headers without a CORS preflight, which we never grant.
    if (req.method !== 'GET' && req.headers['x-geminicode'] !== '1') {
      return reply.code(403).send({ error: 'missing X-GeminiCode header' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof GitError) return reply.code(502).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: (err as Error).message });
  });

  app.get('/api/me', async (req) => ({ email: (req as AuthedRequest).userEmail, usage: sessions.usage() }));

  app.get('/api/repos', async () => sessions.gh.listRepos());

  app.get('/api/sessions', async () => sessions.list());

  app.get('/api/models', async () => sessions.models());

  app.post<{ Body: { repo: string; baseBranch?: string; prompt: string; mode?: string; model?: string } }>(
    '/api/sessions',
    async (req) => sessions.create(req.body ?? ({} as never)),
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => sessions.info(req.params.id));

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/sessions/:id/events', async (req) =>
    sessions.events(req.params.id, Number(req.query.after ?? 0)),
  );

  app.post<{ Params: { id: string }; Body: { text: string } }>('/api/sessions/:id/prompt', async (req) => {
    await sessions.prompt(req.params.id, req.body?.text);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { requestId: string; optionId: string | null } }>(
    '/api/sessions/:id/permission',
    async (req) => {
      sessions.respondPermission(req.params.id, req.body?.requestId, req.body?.optionId ?? null);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', async (req) => {
    sessions.cancel(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { modeId: string } }>('/api/sessions/:id/mode', async (req) => {
    await sessions.setMode(req.params.id, req.body?.modeId);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { modelId: string } }>('/api/sessions/:id/model', async (req) => {
    await sessions.setModel(req.params.id, req.body?.modelId);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (req) => {
    sessions.stop(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/diff', async (req) => sessions.diff(req.params.id));

  app.post<{ Params: { id: string } }>('/api/sessions/:id/push', async (req) => sessions.push(req.params.id));

  app.post<{ Params: { id: string } }>('/api/sessions/:id/pr', async (req) => sessions.createPr(req.params.id));

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    await sessions.remove(req.params.id);
    return { ok: true };
  });

  // Server-sent events: session list changes for everyone, plus the event log of one session.
  // EventSource resends the last seen id as Last-Event-ID on reconnect, so nothing is lost
  // when the phone drops the connection.
  app.get<{ Querystring: { session?: string; after?: string } }>('/api/stream', (req, reply) => {
    const sessionId = req.query.session;
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const sendEvent = (e: EventRow) => {
      if (e.session_id === sessionId) res.write(`id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const sendSession = (s: SessionRow) => res.write(`event: session\ndata: ${JSON.stringify(s)}\n\n`);

    if (sessionId) {
      try {
        for (const e of sessions.events(sessionId, after)) sendEvent(e);
      } catch {
        res.write(`event: gone\ndata: {}\n\n`);
      }
    }
    sessions.on('event', sendEvent);
    sessions.on('session', sendSession);
    // Cloudflare closes proxied connections that stay silent for 100 s.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      sessions.off('event', sendEvent);
      sessions.off('session', sendSession);
    });
  });

  if (fs.existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir, wildcard: false });
    // Single-page app: unknown non-API paths get index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.log.warn(`web build not found at ${cfg.webDir}; serving API only`);
  }

  return app;
}
