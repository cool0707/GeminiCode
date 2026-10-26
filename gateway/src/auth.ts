// Cloudflare Access sits in front of the tunnel; we still verify its JWT so that
// nothing reaching the port directly (or through a misconfigured route) gets in.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';

export function createAuth(cfg: Config, keys?: JWTVerifyGetKey) {
  if (cfg.insecureNoAuth) {
    return async (req: FastifyRequest) => {
      (req as AuthedRequest).userEmail = 'local@localhost';
    };
  }
  const issuer = `https://${cfg.cfAccessTeamDomain}`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.headers['cf-access-jwt-assertion'] as string | undefined) ?? cookie(req, 'CF_Authorization');
    if (!token) return reply.code(401).send({ error: 'missing Cloudflare Access token' });
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: cfg.cfAccessAud });
      const email = String(payload.email ?? '').toLowerCase();
      if (cfg.allowedEmails.length && !cfg.allowedEmails.includes(email)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      (req as AuthedRequest).userEmail = email;
    } catch {
      return reply.code(401).send({ error: 'invalid Cloudflare Access token' });
    }
  };
}

export type AuthedRequest = FastifyRequest & { userEmail?: string };

function cookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
