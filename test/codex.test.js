'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Store } = require('../src/store');
const { startService } = require('../src/service');
const { codexConfigArgs } = require('../src/codex');

const event = (name, fields = {}) => ({ hook_event_name: name, session_id: 'conversation', ...fields });
const tool = (id, name = 'Bash', fields = {}) => ({ tool_name: name, tool_use_id: id, ...fields });

function runCommand(command, args, environment, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-codex-'));
  const store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = store.register({ name: 'Codex', kind: 'codex' });
  return { root, store, agent, hook: (name, fields) => store.codexHook(agent.id, event(name, fields)) };
}

test('Codex state machine: lifecycle, permission attention, interrupt and invalid input', t => {
  const { store, agent, hook } = fixture(t);
  hook('SessionStart');
  assert.equal(hook('UserPromptSubmit').status, 'working');
  hook('PreToolUse', tool('a'));
  assert.equal(hook('PermissionRequest', { tool_name: 'Bash' }).status, 'needs-permission');
  hook('PreToolUse', tool('b'));
  assert.equal(hook('PostToolUse', tool('b')).status, 'needs-permission', 'an unrelated parallel call does not clear the prompt');
  assert.equal(hook('PostToolUse', tool('a')).status, 'working');
  assert.equal(store.agent(agent.id).attention, null);
  hook('PermissionRequest', { tool_name: 'apply_patch' });
  assert.equal(hook('PostToolUse', tool('c', 'apply_patch')).attention, null, 'a prompt with no tracked call resolves on the next result of that tool');
  hook('PermissionRequest', { tool_name: 'Bash' });
  assert.equal(hook('Stop').status, 'needs-permission', 'a finished turn does not resolve an unanswered prompt');
  const interrupted = hook('Interrupt');
  assert.equal(interrupted.status, 'idle');
  assert.equal(interrupted.attention, null);
  assert.equal(hook('Stop').status, 'finished');
  assert.throws(() => store.codexHook(agent.id, { ...event('Stop'), session_id: 'other' }), /inactive/);
  assert.equal(hook('SessionEnd').status, 'disconnected');
  for (const invalid of [null, { hook_event_name: 'PreCompact', session_id: 's' }, event('PostToolUse', { tool_name: 'Bash' }), event('PermissionRequest'), event('SubagentStop'), { hook_event_name: 'Stop' }]) {
    assert.throws(() => store.codexHook(agent.id, invalid));
  }
  const shell = store.register({ name: 'Shell', kind: 'shell' });
  assert.throws(() => store.codexHook(shell.id, event('Stop')), /Codex agent/);
});

test('Codex subagents share the parent session id, keep attention and are cleaned up when they stop', t => {
  const { store, agent, hook } = fixture(t);
  hook('SessionStart');
  hook('PreToolUse', tool('child-call', 'Bash', { agent_id: 'child' }));
  assert.equal(hook('PermissionRequest', { tool_name: 'Bash', agent_id: 'child' }).status, 'needs-permission');
  assert.equal(hook('Stop').status, 'needs-permission');
  assert.equal(hook('UserPromptSubmit').status, 'needs-permission');
  assert.equal(hook('SubagentStop', { agent_id: 'child' }).attention, null);
  assert.equal(store.agent(agent.id).status, 'working');
  assert.equal(hook('SubagentStop', { agent_id: 'child' }).status, 'working', 'a repeated subagent stop is harmless');
  assert.equal(store.agent(agent.id).codex.requests.length, 0);
  assert.throws(() => hook('SessionStart', { agent_id: 'other', session_id: 'x' }) && hook('Stop', { session_id: 'x' }), /inactive/);
});

test('Codex preserves requests across restart and obsolete conversations cannot change state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-codex-'));
  let store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = store.register({ name: 'Codex', kind: 'codex' });
  store.codexHook(agent.id, event('SessionStart'));
  store.codexHook(agent.id, event('PermissionRequest', { tool_name: 'Bash' }));
  store.close();
  store = new Store(root);
  assert.equal(store.agent(agent.id).attention, 'needs-permission');
  store.codexHook(agent.id, event('SessionStart', { session_id: 'replacement' }));
  const before = store.snapshot();
  for (const name of ['UserPromptSubmit', 'Interrupt', 'Stop', 'SessionEnd']) {
    assert.throws(() => store.codexHook(agent.id, event(name)), /inactive/);
    assert.deepEqual(store.snapshot(), before);
  }
  store.status(agent.id, 'working');
  assert.equal(store.agent(agent.id).codex.requests.length, 0);
});

test('Codex hook definitions are stable and contain no per-launch values', () => {
  const args = codexConfigArgs();
  assert.equal(args.length % 2, 0);
  for (let i = 0; i < args.length; i += 2) assert.equal(args[i], '-c');
  const text = args.join('\n');
  assert.doesNotMatch(text, /MURMURPLEX_|\/home|\\|token/i);
  assert.match(text, /hooks\.PermissionRequest=\[\{hooks=\[\{type="command",command="murmurplex-agent codex-hook",timeout=6\}\]\}\]/);
  for (const name of ['Interrupt', 'SessionEnd']) assert.match(text, new RegExp(`hooks\\.${name}=.*timeout=3`));
  assert.deepEqual(codexConfigArgs(), args);
});

test('Codex helper reports through the service, ignores prompt text and never blocks Codex', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-codex-'));
  const service = await startService(path.join(root, '.murmurplex'));
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = service.store.register({ name: 'Codex', kind: 'codex' });
  service.issueCredential(agent.id);
  const helper = path.resolve(__dirname, '../bin/murmurplex-agent');
  const environment = { ...process.env, MURMURPLEX_AGENT_ID: agent.id, MURMURPLEX_CREDENTIALS: service.credentialFile(agent.id) };
  const run = input => runCommand(process.execPath, [helper, 'codex-hook'], environment, input);
  assert.deepEqual(await run(event('SessionStart', { source: 'startup', model: 'private-model' })), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await run(event('UserPromptSubmit', { prompt: 'private prompt text', transcript_path: null })), { code: 0, stdout: '', stderr: '' });
  assert.equal(service.store.agent(agent.id).status, 'working');
  assert.deepEqual(await run(event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'private command' } })), { code: 0, stdout: '', stderr: '' });
  assert.equal(service.store.agent(agent.id).attention, 'needs-permission');
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.murmurplex/state.json'), 'utf8'), /private/);
  const before = service.store.snapshot();
  for (const invalid of [{ not: 'an event' }, event('Stop', { session_id: 'obsolete' })]) {
    const result = await run(invalid);
    assert.equal(result.code, 0, 'exit code 2 would make Codex continue or block');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Codex status reporting failed:/);
    assert.deepEqual(service.store.snapshot(), before);
  }
  const unreachable = await runCommand(process.execPath, [helper, 'codex-hook'], { ...process.env, MURMURPLEX_AGENT_ID: agent.id, MURMURPLEX_CREDENTIALS: path.join(root, 'missing.json') }, event('Stop'));
  assert.equal(unreachable.code, 0);
});

test('Codex hook trust is summarised from the installed Codex and degrades to unavailable', async t => {
  const { codexHookTrust, summariseHooks } = require('../src/codex-trust');
  const hook = trustStatus => ({ command: 'murmurplex-agent codex-hook', trustStatus });
  assert.equal(summariseHooks({ data: [{ hooks: [hook('trusted'), hook('trusted')] }] }), 'trusted');
  assert.equal(summariseHooks({ data: [{ hooks: [hook('trusted'), hook('modified')] }] }), 'needs-review');
  assert.equal(summariseHooks({ data: [{ hooks: [{ command: 'other', trustStatus: 'trusted' }] }] }), 'unavailable');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(await codexHookTrust(home, { command: path.join(home, 'missing-codex') }), 'unavailable');
  const installed = spawnSync('codex', ['--version']).status === 0;
  if (installed) assert.equal(await codexHookTrust(home, { env: { ...process.env, CODEX_HOME: home } }), 'needs-review');
});
