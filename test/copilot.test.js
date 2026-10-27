'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store');
const { startService } = require('../src/service');

const event = (name, fields = {}) => ({ hook_event_name: name, session_id: 'conversation', ...fields });

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

test('Copilot state machine: lifecycle, ask_user attention, subagents and invalid input', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-copilot-'));
  const store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = store.register({ name: 'Copilot', kind: 'copilot' });
  const hook = (name, fields) => store.copilotHook(agent.id, event(name, fields));
  hook('SessionStart');
  assert.equal(hook('UserPromptSubmit').status, 'working');
  assert.equal(hook('PreToolUse', { tool_name: 'AskUserQuestion' }).status, 'needs-input');
  assert.equal(hook('PreToolUse', { tool_name: 'Bash', agent_id: 'sub' }).status, 'needs-input', 'subagent tools do not clear attention');
  assert.equal(hook('PostToolUse', { tool_name: 'AskUserQuestion' }).status, 'working');
  assert.equal(store.agent(agent.id).attention, null);
  assert.equal(hook('Stop').status, 'finished');
  hook('PreToolUse', { tool_name: 'AskUserQuestion' });
  assert.equal(hook('Stop').status, 'needs-input', 'a finished turn does not resolve an unanswered question');
  assert.throws(() => store.copilotHook(agent.id, { ...event('Stop'), session_id: 'other' }), /inactive/);
  assert.equal(hook('SessionEnd').status, 'disconnected');
  for (const invalid of [null, { hook_event_name: 'PermissionRequest', session_id: 's' }, event('PreToolUse'), { hook_event_name: 'Stop' }]) {
    assert.throws(() => store.copilotHook(agent.id, invalid));
  }
  const shell = store.register({ name: 'Shell', kind: 'shell' });
  assert.throws(() => store.copilotHook(shell.id, event('Stop')), /Copilot agent/);
});

test('Copilot preserves child questions and manual permission attention across parent turn boundaries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-copilot-'));
  const store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = store.register({ name: 'Copilot', kind: 'copilot' });
  const hook = (name, fields) => store.copilotHook(agent.id, event(name, fields));
  hook('SessionStart');
  hook('PreToolUse', { tool_name: 'AskUserQuestion', agent_id: 'child' });
  assert.equal(hook('Stop').attention, 'needs-input');
  assert.equal(hook('UserPromptSubmit').status, 'needs-input');
  assert.equal(hook('PostToolUseFailure', { tool_name: 'AskUserQuestion', agent_id: 'child' }).attention, null);
  store.status(agent.id, 'needs-permission');
  assert.equal(hook('Stop').status, 'needs-permission');
  assert.equal(hook('SessionEnd').attention, 'needs-permission');
  store.status(agent.id, 'working');
  assert.equal(hook('Stop').status, 'finished');
});

test('Copilot preserves request correlation through service restart, resume and conversation replacement', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-copilot-'));
  let store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = store.register({ name: 'Copilot', kind: 'copilot' });
  const hook = (name, fields) => store.copilotHook(agent.id, event(name, fields));
  hook('SessionStart');
  hook('PreToolUse', { tool_name: 'AskUserQuestion' });
  store.close();
  store = new Store(root);
  assert.equal(store.agent(agent.id).attention, 'needs-input');
  hook('SessionStart');
  assert.equal(hook('PostToolUse', { tool_name: 'AskUserQuestion' }).attention, null);
  hook('PreToolUse', { tool_name: 'AskUserQuestion' });
  hook('SessionStart', { session_id: 'replacement' });
  hook('PreToolUse', { session_id: 'replacement', tool_name: 'AskUserQuestion' });
  assert.equal(hook('PostToolUse', { session_id: 'replacement', tool_name: 'AskUserQuestion' }).attention, 'needs-input', 'a new conversation cannot resolve the old question');
  const before = store.snapshot();
  for (const name of ['PreToolUse', 'PostToolUse', 'SessionStart']) {
    assert.throws(() => hook(name, { agent_id: 'old-child', tool_name: 'AskUserQuestion' }), /inactive/);
    assert.deepEqual(store.snapshot(), before);
  }
  store.status(agent.id, 'working');
  assert.equal(hook('Stop', { session_id: 'replacement' }).attention, null);
});

test('the shipped Copilot plugin hooks reach the service through the helper on PATH', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-copilot-'));
  const service = await startService(path.join(root, '.murmurplex'), path.join(root, 'private', 'credentials'));
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = service.store.register({ name: 'Copilot', kind: 'copilot' });
  service.issueCredential(agent.id);
  const plugin = path.resolve(__dirname, '../copilot-plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'plugin.json'), 'utf8'));
  const { hooks } = JSON.parse(fs.readFileSync(path.join(plugin, manifest.hooks), 'utf8'));
  const environment = {
    ...process.env, MURMURPLEX_AGENT_ID: agent.id, MURMURPLEX_CREDENTIALS: service.credentialFile(agent.id),
    PATH: `${path.resolve(__dirname, '../bin')}${path.delimiter}${process.env.PATH}`
  };
  const run = (name, input) => runCommand('bash', ['-c', hooks[name][0].bash], environment, input);
  for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.deepEqual(await run(name, event(name)), { code: 0, stdout: '', stderr: '' });
  assert.equal(service.store.agent(agent.id).status, 'finished');
  await run('UserPromptSubmit', event('UserPromptSubmit'));
  assert.deepEqual(await run('ErrorOccurred', event('ErrorOccurred', { recoverable: true })), { code: 0, stdout: '', stderr: '' });
  assert.equal(service.store.agent(agent.id).status, 'working');
  assert.deepEqual(await run('ErrorOccurred', event('ErrorOccurred', {
    recoverable: false, error: { message: 'private error text' }
  })), { code: 0, stdout: '', stderr: '' });
  assert.equal(service.store.agent(agent.id).status, 'unknown');
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.murmurplex/state.json'), 'utf8'), /private error text/);
  service.store.status(agent.id, 'needs-permission');
  await run('ErrorOccurred', event('ErrorOccurred', { recoverable: false }));
  assert.equal(service.store.agent(agent.id).attention, 'needs-permission');
  assert.equal(service.store.agent(agent.id).status, 'unknown');
  const before = service.store.snapshot();
  for (const invalid of [{ not: 'an event' }, event('ErrorOccurred', { recoverable: 'false' }), event('PreToolUse', { session_id: 'obsolete', tool_name: 'Bash' })]) {
    const result = await run('PreToolUse', invalid);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Copilot status reporting failed:/);
    assert.deepEqual(service.store.snapshot(), before);
  }
});

test('Copilot hook reporting failures are diagnostic only, while ordinary helper failures exit nonzero', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-copilot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env, MURMURPLEX_AGENT_ID: 'copilot', MURMURPLEX_CREDENTIALS: path.join(root, 'missing.json') };
  const helper = path.resolve(__dirname, '../bin/murmurplex-agent');
  const result = await runCommand(process.execPath, [helper, 'copilot-hook'], environment, event('PreToolUse', { tool_name: 'Bash' }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Copilot status reporting failed:.*ENOENT/);
  const manual = await runCommand(process.execPath, [helper, 'status', 'working'], environment, {});
  assert.equal(manual.code, 1);
  assert.match(manual.stderr, /Murmurplex:.*ENOENT/);
});
