import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const messages = [];
let model = { provider: 'mock-proxy', id: 'mock-proxy-sonnet', name: 'Mock Proxy Sonnet', reasoning: true, input: ['text', 'image'], contextWindow: 200000 };
let thinkingLevel = 'medium';
let sessionId = `mock-proxy-${Date.now()}`;
let sessionFile = `mock-proxy-session-${process.pid}.jsonl`;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function response(cmd, success = true, data = null, error = undefined) {
  send({ type: 'response', id: cmd.id, command: cmd.type, success, data, ...(error ? { error } : {}) });
}

function emit(payload, delay = 0) {
  setTimeout(() => send(payload), delay);
}

function handlePrompt(cmd) {
  const text = cmd.message ?? '';
  const now = Date.now();
  messages.push({ role: 'user', timestamp: now, content: text });
  response(cmd, true, { accepted: true });

  const chunks = ['Proxy mode ', 'is streaming ', 'through Rust.'];
  let assistant = '';
  emit({ type: 'agent_start' }, 10);
  emit({ type: 'message_start', message: { role: 'assistant' } }, 20);
  chunks.forEach((delta, index) => {
    assistant += delta;
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }, 50 + index * 40);
  });
  emit({ type: 'message_end' }, 220);
  emit({ type: 'agent_end' }, 240);
  setTimeout(() => {
    messages.push({ role: 'assistant', timestamp: Date.now(), content: assistant });
  }, 230);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  switch (cmd.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
      handlePrompt(cmd);
      break;
    case 'abort':
      response(cmd, true, { aborted: true });
      emit({ type: 'agent_end' }, 5);
      break;
    case 'get_state':
      response(cmd, true, { model, thinkingLevel, sessionId, sessionFile, autoCompactionEnabled: true });
      break;
    case 'get_session_stats':
      response(cmd, true, {
        tokens: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, total: 20 },
        cost: 0.001,
        contextUsage: { tokens: 20, contextWindow: 200000, percent: 0.01 },
      });
      break;
    case 'get_messages':
      response(cmd, true, { messages });
      break;
    case 'get_available_models':
      response(cmd, true, { models: [model] });
      break;
    case 'set_model':
      model = { ...model, provider: cmd.provider ?? model.provider, id: cmd.modelId ?? model.id };
      response(cmd, true, {});
      break;
    case 'set_thinking_level':
      thinkingLevel = cmd.level ?? thinkingLevel;
      response(cmd, true, {});
      break;
    case 'new_session':
      messages.length = 0;
      sessionId = `mock-proxy-${Date.now()}`;
      sessionFile = `mock-proxy-session-${process.pid}-${Date.now()}.jsonl`;
      response(cmd, true, {});
      break;
    case 'switch_session':
      sessionFile = cmd.sessionPath ?? sessionFile;
      response(cmd, true, {});
      break;
    case 'fork':
      response(cmd, true, {});
      break;
    default:
      response(cmd, false, null, `Unknown command: ${cmd.type}`);
  }
});
