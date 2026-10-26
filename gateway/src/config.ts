import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  webDir: string;
  geminiBin: string;
  geminiArgs: string[];
  geminiApiKey: string;
  githubToken: string;
  githubApiBase: string;
  githubGitBase: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  cfAccessTeamDomain: string;
  cfAccessAud: string;
  allowedEmails: string[];
  insecureNoAuth: boolean;
  idleTimeoutMs: number;
  startupTimeoutMs: number;
  geminiHome: string;
  defaultModel: string;
  dailyTokenLimit: number;
}

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export function loadConfig(): Config {
  const dataDir = env('GEMINICODE_DATA_DIR', path.join(os.homedir(), '.local/share/geminicode'));
  const cfg: Config = {
    host: env('GEMINICODE_HOST', '127.0.0.1'),
    port: Number(env('GEMINICODE_PORT', '8080')),
    dataDir,
    webDir: env('GEMINICODE_WEB_DIR', path.resolve(import.meta.dirname, '../../../web/dist')),
    geminiBin: env('GEMINI_BIN', 'gemini'),
    geminiArgs: env('GEMINI_EXTRA_ARGS').split(' ').filter(Boolean),
    geminiApiKey: env('GEMINI_API_KEY'),
    githubToken: env('GITHUB_TOKEN'),
    githubApiBase: env('GITHUB_API_BASE', 'https://api.github.com'),
    githubGitBase: env('GITHUB_GIT_BASE', 'https://github.com'),
    gitAuthorName: env('GIT_AUTHOR_NAME', 'GeminiCode'),
    gitAuthorEmail: env('GIT_AUTHOR_EMAIL', 'geminicode@users.noreply.github.com'),
    cfAccessTeamDomain: env('CF_ACCESS_TEAM_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    cfAccessAud: env('CF_ACCESS_AUD'),
    allowedEmails: env('ALLOWED_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    insecureNoAuth: env('GEMINICODE_INSECURE_NO_AUTH') === '1',
    idleTimeoutMs: Number(env('GEMINICODE_IDLE_MINUTES', '30')) * 60_000,
    startupTimeoutMs: Number(env('GEMINICODE_STARTUP_TIMEOUT_SECONDS', '120')) * 1000,
    // Gemini CLI gets its own home so a login method chosen in interactive use
    // (e.g. "Log in with Google", which waits for a browser) never applies here.
    geminiHome: env('GEMINICODE_GEMINI_HOME', path.join(dataDir, 'gemini-home')),
    defaultModel: env('GEMINICODE_DEFAULT_MODEL', 'auto'),
    dailyTokenLimit: Number(env('GEMINICODE_DAILY_TOKEN_LIMIT', '0')),
  };
  return cfg;
}

export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];
  if (!cfg.geminiApiKey) errors.push('GEMINI_API_KEY is not set');
  if (!cfg.githubToken) errors.push('GITHUB_TOKEN is not set');
  if (!cfg.insecureNoAuth && (!cfg.cfAccessTeamDomain || !cfg.cfAccessAud)) {
    errors.push('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required (or set GEMINICODE_INSECURE_NO_AUTH=1 for local development)');
  }
  return errors;
}
