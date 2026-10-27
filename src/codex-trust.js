'use strict';
const { spawn } = require('node:child_process');
const { codexConfigArgs, COMMAND } = require('./codex');

// Asks the installed Codex which of Murmurplex's launch-time hooks it will run.
function summariseHooks(response) {
  const hooks = (response?.data || []).flatMap(entry => entry.hooks || []).filter(hook => hook.command === COMMAND);
  if (!hooks.length) return 'unavailable';
  return hooks.every(hook => hook.trustStatus === 'trusted' || hook.isManaged) ? 'trusted' : 'needs-review';
}

function codexHookTrust(cwd, { command = 'codex', env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    let child, buffer = '', done = false;
    const finish = state => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child?.kill();
      resolve(state);
    };
    const timer = setTimeout(() => finish('unavailable'), timeoutMs);
    try { child = spawn(command, ['app-server', ...codexConfigArgs()], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return finish('unavailable'); }
    child.on('error', () => finish('unavailable'));
    child.on('close', () => finish('unavailable'));
    child.stdin.on('error', () => finish('unavailable'));
    const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
        } else if (message.id === 2) finish(message.result ? summariseHooks(message.result) : 'unavailable');
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'murmurplex', version: '0' } } });
  });
}

module.exports = { codexHookTrust, summariseHooks };
