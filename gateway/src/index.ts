import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.js';
import { Db } from './db.js';
import { buildServer } from './server.js';
import { SessionManager } from './sessions.js';

const cfg = loadConfig();
const errors = validateConfig(cfg);
if (errors.length) {
  for (const e of errors) console.error(`config error: ${e}`);
  process.exit(1);
}
if (cfg.insecureNoAuth) console.warn('WARNING: authentication is disabled (GEMINICODE_INSECURE_NO_AUTH=1)');

fs.mkdirSync(cfg.dataDir, { recursive: true });
const db = new Db(path.join(cfg.dataDir, 'geminicode.db'));
const sessions = new SessionManager(cfg, db);
const app = await buildServer(cfg, sessions);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    sessions.shutdown();
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: cfg.host, port: cfg.port });
