import { execFile } from 'node:child_process';
import type { Config } from './config.js';

export class GitError extends Error {}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: string | null;
  description: string | null;
}

export class GitHub {
  constructor(private cfg: Config) {}

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.githubApiBase}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'geminicode',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GitError(`GitHub API ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  async listRepos(): Promise<RepoInfo[]> {
    const repos = await this.api<any[]>('GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    return repos.map(toRepoInfo);
  }

  async getRepo(fullName: string): Promise<RepoInfo> {
    return toRepoInfo(await this.api<any>('GET', `/repos/${fullName}`));
  }

  async findPull(fullName: string, branch: string): Promise<string | null> {
    const owner = fullName.split('/')[0];
    const pulls = await this.api<any[]>('GET', `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    return pulls[0]?.html_url ?? null;
  }

  async createPull(fullName: string, p: { head: string; base: string; title: string; body: string }): Promise<string> {
    const pr = await this.api<any>('POST', `/repos/${fullName}/pulls`, p);
    return pr.html_url;
  }

  /** Environment that makes git authenticate to GitHub without writing the token to disk. */
  gitAuthEnv(): NodeJS.ProcessEnv {
    const basic = Buffer.from(`x-access-token:${this.cfg.githubToken}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `http.${this.cfg.githubGitBase}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  cloneUrl(fullName: string): string {
    return `${this.cfg.githubGitBase}/${fullName}.git`;
  }
}

function toRepoInfo(r: any): RepoInfo {
  return {
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
    pushedAt: r.pushed_at ?? null,
    description: r.description ?? null,
  };
}

export function git(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}

export async function cloneWorkspace(
  gh: GitHub,
  cfg: Config,
  p: { repo: string; baseBranch: string; branch: string; dir: string },
): Promise<void> {
  await git(['clone', '--branch', p.baseBranch, gh.cloneUrl(p.repo), p.dir], cfg.dataDir, gh.gitAuthEnv());
  await git(['checkout', '-b', p.branch], p.dir);
  await git(['config', 'user.name', cfg.gitAuthorName], p.dir);
  await git(['config', 'user.email', cfg.gitAuthorEmail], p.dir);
}

export interface DiffResult {
  diff: string;
  files: { path: string; added: number; removed: number }[];
}

/** Everything on the session branch (committed or not, including new files) relative to the base branch. */
export async function diffWorkspace(dir: string, baseBranch: string): Promise<DiffResult> {
  await git(['add', '--all', '--intent-to-add'], dir);
  const base = `origin/${baseBranch}`;
  const [diff, numstat] = await Promise.all([
    git(['diff', '--no-color', '--find-renames', base], dir),
    git(['diff', '--numstat', '--find-renames', base], dir),
  ]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, r, ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 };
    });
  return { diff, files };
}

/** Commits pending changes (if any) and pushes the session branch. Returns the number of commits ahead of base. */
export async function commitAndPush(
  gh: GitHub,
  p: { dir: string; branch: string; baseBranch: string; message: string },
): Promise<number> {
  await git(['add', '--all'], p.dir);
  const staged = await git(['diff', '--cached', '--name-only'], p.dir);
  if (staged.trim()) await git(['commit', '-m', p.message], p.dir);
  const ahead = Number((await git(['rev-list', '--count', `origin/${p.baseBranch}..HEAD`], p.dir)).trim());
  if (ahead === 0) return 0;
  await git(['push', '-u', 'origin', `HEAD:refs/heads/${p.branch}`], p.dir, gh.gitAuthEnv());
  return ahead;
}
