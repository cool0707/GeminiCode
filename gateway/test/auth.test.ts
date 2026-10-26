import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

test('Cloudflare Access JWT verification', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const cfg = {
    ...loadConfig(),
    insecureNoAuth: false,
    cfAccessTeamDomain: 'team.cloudflareaccess.com',
    cfAccessAud: 'aud-123',
    allowedEmails: ['me@example.com'],
  };
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (l: string) => logs.push(l) } } });
  const auth = createAuth(cfg, createLocalJWKSet({ keys: [jwk] }));
  app.addHook('onRequest', auth);
  app.get('/', async (req) => ({ email: (req as { userEmail?: string }).userEmail }));

  const sign = (claims: { aud?: string; email?: string; iss?: string }) =>
    new SignJWT({ email: claims.email ?? 'me@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(claims.iss ?? 'https://team.cloudflareaccess.com')
      .setAudience(claims.aud ?? 'aud-123')
      .setExpirationTime('5m')
      .sign(privateKey);

  const get = async (headers: Record<string, string>) => {
    const res = await app.inject({ method: 'GET', url: '/', headers });
    return { status: res.statusCode, body: res.json() };
  };

  assert.equal((await get({})).status, 401);
  const ok = await get({ 'cf-access-jwt-assertion': await sign({}) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'me@example.com');
  assert.equal((await get({ cookie: `CF_Authorization=${await sign({})}` })).status, 200);
  assert.equal((await get({ 'cf-access-jwt-assertion': await sign({ aud: 'other' }) })).status, 401);
  assert.ok(logs.some((l) => JSON.parse(l).aud === 'other'), 'logs the audience of a validly signed token');
  assert.equal((await get({ 'cf-access-jwt-assertion': await sign({ iss: 'https://evil.example' }) })).status, 401);
  assert.equal((await get({ 'cf-access-jwt-assertion': await sign({ email: 'someone@example.com' }) })).status, 403);
  await app.close();
});
