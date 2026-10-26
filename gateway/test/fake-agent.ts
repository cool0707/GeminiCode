// A stand-in for `gemini --acp` used by the tests: speaks just enough ACP.
// Prompts containing "edit" request permission and then write hello.txt.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Like the real CLI, relaunch as a child process; the parent ignores SIGTERM while the child runs.
if (!process.env.FAKE_AGENT_CHILD) {
  const child = spawn(process.execPath, [import.meta.filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, FAKE_AGENT_CHILD: '1' },
  });
  process.on('SIGTERM', () => {});
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  runAgent();
}

function runAgent() {

let cwd = process.cwd();
let nextId = 1000;
const waiting = new Map<number, (result: any) => void>();
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
const update = (sessionId: string, u: unknown) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const ask = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

const modes = {
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'autoEdit', name: 'Auto Edit' },
    { id: 'yolo', name: 'YOLO' },
  ],
  currentModeId: 'default',
};
const models = {
  availableModels: [
    { modelId: 'auto', name: 'Auto' },
    { modelId: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview' },
  ],
  currentModelId: 'auto',
};

async function handle(msg: any): Promise<unknown> {
  const p = msg.params;
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
    case 'session/new': {
      cwd = p.cwd;
      // Like the real CLI: the saved auth type wins. "Log in with Google" without stored
      // credentials waits for a login, printing the URL (no newline) to stdout.
      const geminiDir = path.join(process.env.GEMINI_CLI_HOME ?? '', '.gemini');
      let selected = '';
      try {
        selected = JSON.parse(fs.readFileSync(path.join(geminiDir, 'settings.json'), 'utf8')).security.auth.selectedType;
      } catch {}
      if (selected === 'gemini-api-key' && process.env.GEMINI_API_KEY !== 'test-key') {
        throw { code: -32000, message: 'Gemini API key is missing or not configured.' };
      }
      const loggedIn =
        process.env.GEMINI_FORCE_FILE_STORAGE === 'true' && fs.existsSync(path.join(geminiDir, 'gemini-credentials.json'));
      if (selected !== 'gemini-api-key' && !(selected === 'oauth-personal' && loggedIn)) {
        process.stdout.write('\x1b[?1049hPlease visit the following URL to authorize the application: https://accounts.google.com/o/oauth2/auth');
        return new Promise(() => {});
      }
      return { sessionId: 'fake-session', modes, models };
    }
    case 'session/load':
      cwd = p.cwd;
      // Like the real CLI: nothing to load until a turn has completed and been saved.
      if (!fs.existsSync(path.join(cwd, '.git', 'fake-saved'))) throw { code: -32603, message: 'Internal error' };
      update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed' } });
      return { modes, models };
    case 'session/set_mode':
      modes.currentModeId = p.modeId;
      update(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId });
      return {};
    case 'session/set_model':
      models.currentModelId = p.modelId;
      return {};
    case 'session/prompt': {
      const text: string = p.prompt[0].text;
      if (text.includes('hang')) return new Promise(() => {}); // ignores session/cancel, like a retry loop
      if (text.includes('busy')) {
        // Gemini CLI reports API retries through its debug logger: console.warn and GEMINI_DEBUG_LOG_FILE.
        for (const attempt of [1, 2]) {
          const line = `Attempt ${attempt} failed with status 503. Retrying with backoff... _ApiError: high demand\n`;
          process.stderr.write(line);
          if (process.env.GEMINI_DEBUG_LOG_FILE) fs.appendFileSync(process.env.GEMINI_DEBUG_LOG_FILE, `[ts] [WARN] ${line}`);
          await new Promise((r) => setTimeout(r, 1300));
        }
      }
      if (text.includes('edit')) {
        const toolCall = {
          toolCallId: 't1',
          title: 'WriteFile hello.txt',
          kind: 'edit',
          status: 'pending',
          content: [{ type: 'diff', path: 'hello.txt', oldText: '', newText: 'hello\n' }],
          locations: [{ path: 'hello.txt' }],
        };
        update(p.sessionId, { sessionUpdate: 'tool_call', ...toolCall });
        const res = await ask('session/request_permission', {
          sessionId: p.sessionId,
          toolCall,
          options: [
            { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'cancel', name: 'Deny', kind: 'reject_once' },
          ],
        });
        if (res.outcome.outcome === 'selected' && res.outcome.optionId === 'proceed_once') {
          fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello\n');
          update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        } else {
          update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
          return { stopReason: 'cancelled' };
        }
      }
      update(p.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about the request.' } });
      const envInfo = `\n\napikey=${process.env.GEMINI_API_KEY ? 'set' : 'unset'}`;
      for (const chunk of ['echo: ', text, envInfo, '\n\n- `hello.txt` を作成\n- **完了**', `\n\nmodel: ${models.currentModelId}`]) {
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
      }
      fs.writeFileSync(path.join(cwd, '.git', 'fake-saved'), '');
      return { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
    }
    default:
      throw { code: -32601, message: `unknown method ${msg.method}` };
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  if (msg.id === undefined) return; // notifications (session/cancel) are ignored
  handle(msg).then(
    (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
    (error) => send({ jsonrpc: '2.0', id: msg.id, error }),
  );
});
}
