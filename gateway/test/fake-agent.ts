// A stand-in for `gemini --acp` used by the tests: speaks just enough ACP.
// Prompts containing "edit" request permission and then write hello.txt.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

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
const models = { availableModels: [{ modelId: 'auto', name: 'Auto' }], currentModelId: 'auto' };

async function handle(msg: any): Promise<unknown> {
  const p = msg.params;
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
    case 'session/new': {
      cwd = p.cwd;
      if (process.env.GEMINI_API_KEY !== 'test-key') throw { code: -32000, message: 'no api key' };
      // Like the real CLI: a saved "Log in with Google" choice wins over the API key and
      // waits for a browser login, printing the URL (no newline) to stdout.
      let selected = '';
      try {
        const file = path.join(process.env.GEMINI_CLI_HOME ?? '', '.gemini', 'settings.json');
        selected = JSON.parse(fs.readFileSync(file, 'utf8')).security.auth.selectedType;
      } catch {}
      if (selected !== 'gemini-api-key') {
        process.stdout.write('\x1b[?1049hPlease visit the following URL to authorize the application: https://accounts.google.com/o/oauth2/auth');
        return new Promise(() => {});
      }
      return { sessionId: 'fake-session', modes, models };
    }
    case 'session/load':
      cwd = p.cwd;
      update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed' } });
      return { modes, models };
    case 'session/set_mode':
      modes.currentModeId = p.modeId;
      update(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId });
      return {};
    case 'session/set_model':
      return {};
    case 'session/prompt': {
      const text: string = p.prompt[0].text;
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
      for (const chunk of ['echo: ', text, '\n\n- `hello.txt` を作成\n- **完了**']) {
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
      }
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
