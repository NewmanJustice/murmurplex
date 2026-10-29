'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store');
const { startService } = require('../src/service');
const { claudeSettings } = require('../src/claude');
const repository = require('../src/repository');

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-claude-'));
}

function storeProject(t) {
  const root = project();
  const store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return store;
}

function event(name, fields = {}) {
  return { hook_event_name: name, session_id: 'conversation', ...fields };
}

function runHook(handler, environment, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(handler.command, handler.args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('configured Claude hooks run silently through the helper, authenticated service and restart', async t => {
  const root = project();
  const credentialsDirectory = path.join(root, 'private', 'credentials');
  let service = await startService(path.join(root, '.murmurplex'), credentialsDirectory);
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = service.store.register({ name: 'Claude', kind: 'claude' });
  service.issueCredential(agent.id);
  // Exercise exec-form argument handling without shell interpolation.
  const extensionRoot = path.join(root, "extension with spaces and 'quotes'");
  const helper = path.join(extensionRoot, 'bin', 'murmurplex-agent');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.mkdirSync(path.join(extensionRoot, 'src'));
  fs.copyFileSync(path.resolve(__dirname, '../bin/murmurplex-agent'), helper);
  fs.copyFileSync(path.resolve(__dirname, '../src/claude.js'), path.join(extensionRoot, 'src', 'claude.js'));
  fs.copyFileSync(path.resolve(__dirname, '../src/codex.js'), path.join(extensionRoot, 'src', 'codex.js'));
  fs.copyFileSync(path.resolve(__dirname, '../src/copilot.js'), path.join(extensionRoot, 'src', 'copilot.js'));
  fs.copyFileSync(path.resolve(__dirname, '../src/security.js'), path.join(extensionRoot, 'src', 'security.js'));
  const settings = claudeSettings(helper);
  const environment = { ...process.env, MURMURPLEX_AGENT_ID: agent.id, MURMURPLEX_CREDENTIALS: service.credentialFile(agent.id) };
  const hook = async (name, fields = {}) => {
    const result = await runHook(settings.hooks[name][0].hooks[0], environment, event(name, fields));
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    return service.store.agent(agent.id);
  };
  await hook('SessionStart');
  assert.equal((await hook('UserPromptSubmit')).status, 'working');
  assert.equal((await hook('PreToolUse', {
    tool_name: 'AskUserQuestion', tool_use_id: 'question',
    tool_input: { questions: ['Private question text'] }, transcript_path: '/private/transcript'
  })).attention, 'needs-input');
  const persisted = fs.readFileSync(path.join(root, '.murmurplex/state.json'), 'utf8');
  assert.doesNotMatch(persisted, /Private question text|private\/transcript/);
  await service.close();
  service = await startService(path.join(root, '.murmurplex'), credentialsDirectory);
  service.issueCredential(agent.id);
  assert.equal(service.store.agent(agent.id).status, 'disconnected');
  assert.equal(service.store.agent(agent.id).attention, 'needs-input');
  // The terminal's environment points at the credential file, which the restarted service reissues.
  const answered = await hook('PostToolUse', {
    tool_name: 'AskUserQuestion', tool_use_id: 'question',
    tool_response: { answer: 'Private answer '.repeat(10000) }
  });
  assert.equal(answered.attention, null);
  assert.equal(answered.status, 'working');
  assert.equal((await hook('Stop')).status, 'finished');
  assert.equal(service.store.snapshot().tasks.length, 0, 'a completed response is not a completed backlog task');
  const invalid = await runHook(settings.hooks.Stop[0].hooks[0], environment, '{broken');
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Murmurplex:/);
});

test('parallel tools and subagents cannot clear another outstanding request', t => {
  const store = storeProject(t);
  const agent = store.register({ name: 'Claude', kind: 'claude' });
  const hook = (name, fields = {}) => store.claudeHook(agent.id, event(name, fields));
  hook('SessionStart');
  hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'first' });
  hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'second' });
  hook('PermissionRequest', { tool_name: 'Bash' });
  hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question', agent_id: 'child' });
  hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'unrelated', agent_id: 'child' });
  assert.equal(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'first' }).attention, 'needs-permission');
  assert.equal(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'second' }).attention, 'needs-input');
  assert.equal(hook('Stop').attention, 'needs-input');
  assert.equal(hook('UserPromptSubmit').attention, 'needs-input', 'autonomous prompt submissions do not imply an answer');
  hook('Stop', { agent_id: 'child' });
  hook('SessionEnd', { agent_id: 'child' });
  assert.equal(store.agent(agent.id).status, 'needs-input');
  assert.equal(hook('PostToolUseFailure', { tool_name: 'AskUserQuestion', tool_use_id: 'question', agent_id: 'child' }).attention, null);
  assert.equal(store.agent(agent.id).status, 'working');
});

test('attention survives turn boundaries and is explicitly resolvable when no matching result exists', t => {
  const store = storeProject(t);
  const agent = store.register({ name: 'Claude', kind: 'claude' });
  const hook = (name, fields = {}) => store.claudeHook(agent.id, event(name, fields));
  hook('SessionStart');
  hook('PermissionRequest', { tool_name: 'Bash' });
  assert.equal(hook('Stop').attention, 'needs-permission');
  assert.equal(hook('SessionEnd').attention, 'needs-permission');
  assert.equal(store.agent(agent.id).status, 'disconnected');
  assert.equal(hook('SessionStart', { session_id: 'replacement' }).attention, 'needs-permission');
  const before = store.snapshot();
  assert.throws(() => hook('Stop'), /inactive conversation/);
  for (const name of ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'SessionStart']) {
    assert.throws(() => hook(name, { agent_id: 'old-child', tool_name: 'AskUserQuestion', tool_use_id: 'old-question' }), /inactive conversation/);
  }
  assert.deepEqual(store.snapshot(), before);
  store.status(agent.id, 'working');
  assert.equal(store.agent(agent.id).attention, null);
  assert.equal(hook('Stop', { session_id: 'replacement', background_tasks: [{ status: 'running' }] }).status, 'idle');
  assert.equal(hook('Stop', { session_id: 'replacement', session_crons: [{}] }).status, 'idle');
  assert.equal(hook('StopFailure', { session_id: 'replacement' }).status, 'unknown');
  store.status(agent.id, 'needs-input');
  assert.equal(hook('PostToolUse', { session_id: 'replacement', tool_name: 'Read', tool_use_id: 'unrelated' }).attention, 'needs-input');
});

test('manual attention overrides automatic requests and invalid events never commit', t => {
  const store = storeProject(t);
  const agent = store.register({ name: 'Claude', kind: 'claude' });
  store.claudeHook(agent.id, event('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question' }));
  store.status(agent.id, 'needs-permission');
  store.claudeHook(agent.id, event('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question' }));
  assert.equal(store.agent(agent.id).attention, 'needs-permission');
  const shell = store.register({ name: 'Shell', kind: 'shell' });
  const before = store.snapshot();
  for (const invalid of [null, {}, event('UnknownEvent'), event('Stop', { session_id: '' }), event('PreToolUse', { tool_name: 'Bash' }), event('Stop', { background_tasks: {} })]) {
    assert.throws(() => store.claudeHook(agent.id, invalid));
  }
  assert.throws(() => store.claudeHook(shell.id, event('Stop')), /Claude agent/);
  assert.deepEqual(store.snapshot(), before);
});

test('extension launches scoped hooks and keeps hidden-agent attention visible when focused', async t => {
  const root = project();
  const storage = project();
  const commands = new Map();
  const errors = [];
  const disposable = { dispose() {} };
  const status = { show() {}, dispose() {} };
  let provider;
  let repositoryProvider;
  let inspect = async () => ({
    root, branch: 'main', head: 'head', branches: ['main'], changes: [],
    worktrees: [{ path: root, branch: 'main', current: true }]
  });
  let selectedAgent;
  let handover;
  let inheritAuthentication = false;
  let confirmRecovery = async () => undefined;
  const group = { viewColumn: 1, tabs: [] };
  class UIValue { constructor(value) { this.value = value; } }
  const vscode = {
    EventEmitter: class {
      constructor() { this.event = () => disposable; }
      fire() {}
      dispose() {}
    },
    ThemeColor: UIValue, ThemeIcon: UIValue, TreeItem: UIValue,
    StatusBarAlignment: { Left: 1 },
    env: { clipboard: { async writeText(value) { handover = value; } } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: key => key === 'inheritAuthenticationEnvironment' ? inheritAuthentication : false })
    },
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return disposable; },
      async executeCommand() {}
    },
    window: {
      terminals: [],
      tabGroups: { all: [group], activeTabGroup: group, onDidChangeTabGroups: () => disposable, onDidChangeTabs: () => disposable },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => status,
      registerTreeDataProvider(name, value) {
        if (name === 'murmurplex.agents') provider = value;
        if (name === 'murmurplex.repository') repositoryProvider = value;
        return disposable;
      },
      onDidCloseTerminal: () => disposable,
      showErrorMessage: message => errors.push(message),
      showInformationMessage() {},
      showWarningMessage: (...args) => confirmRecovery(...args),
      async showQuickPick(items) { return items.find(item => item.agent.id === selectedAgent); },
      createTerminal(options) {
        const terminal = { name: options.name, options, creationOptions: options, show() { vscode.window.activeTerminal = terminal; } };
        this.terminals.push(terminal);
        return terminal;
      }
    }
  };
  const Module = require('node:module');
  const load = Module._load;
  let extension;
  try {
    Module._load = function (name, ...args) {
      if (name === 'vscode') return vscode;
      if (name === './repository') return {
        inspectRepository: (...inspectArgs) => inspect(...inspectArgs),
        reconcileTaskReferences: repository.reconcileTaskReferences
      };
      return load.call(this, name, ...args);
    };
    extension = require('../src/extension');
  } finally { Module._load = load; }
  const context = { subscriptions: [], extensionPath: path.resolve(__dirname, '..'), globalStorageUri: { fsPath: storage } };
  extension.activate(context);
  t.after(async () => {
    await extension.deactivate();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(storage, { recursive: true, force: true });
  });
  const directory = path.join(root, '.murmurplex');
  const seed = new Store(directory);
  seed.task({ title: 'Tracked feature', status: 'in-progress', branch: 'main', worktreePath: root });
  seed.close();
  const lock = path.join(directory, 'writer.lock');
  fs.writeFileSync(lock, '1234\n');
  await commands.get('murmurplex.recoverLock')();
  assert.equal(fs.readFileSync(lock, 'utf8'), '1234\n', 'cancel must preserve the lock');
  let replacement;
  confirmRecovery = async () => {
    fs.unlinkSync(lock);
    replacement = new Store(directory);
    return 'Remove Lock';
  };
  await commands.get('murmurplex.recoverLock')();
  assert.match(errors.pop(), /lock changed since confirmation/);
  assert.equal(Store.lockOwner(directory).raw, replacement.owner.raw);
  replacement.close();
  fs.writeFileSync(lock, '1234\n');
  confirmRecovery = async () => 'Remove Lock';
  await commands.get('murmurplex.recoverLock')();
  assert.equal(fs.existsSync(lock), false);
  const agent = await commands.get('murmurplex.addTab')({ kind: 'claude', name: 'Claude' });
  assert.ok(agent?.id, errors.join('\n'));
  const terminal = vscode.window.terminals[0];
  assert.equal(terminal.options.shellPath, 'claude');
  assert.equal(terminal.options.shellArgs[0], '--settings');
  assert.equal(terminal.options.env.OPENAI_API_KEY, null, 'native login is the default');
  assert.equal(terminal.options.env.GH_TOKEN, null);
  const settings = JSON.parse(terminal.options.shellArgs[1]);
  const other = await commands.get('murmurplex.addTab')({ kind: 'shell', name: 'Other agent' });
  assert.notEqual(vscode.window.activeTerminal, terminal);
  const hook = async (name, fields = {}) => {
    const result = await runHook(settings.hooks[name][0].hooks[0], { ...process.env, ...terminal.options.env }, event(name, fields));
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  };
  await hook('SessionStart');
  await hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'approval' });
  await hook('PermissionRequest', { tool_name: 'Bash' });
  assert.match(status.text, /1 waiting/);
  const item = provider.getTreeItem(provider.getChildren().find(item => item.id === agent.id));
  assert.equal(item.description, 'needs-permission');
  assert.equal(item.iconPath.value, 'circle-filled');
  await commands.get('murmurplex.openAgent')(agent);
  assert.equal(vscode.window.activeTerminal, terminal);
  assert.match(status.text, /1 waiting/, 'focus must not resolve a request');
  await hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'approval' });
  assert.doesNotMatch(status.text, /waiting/);
  assert.equal(provider.getChildren().find(item => item.id === agent.id).attention, null);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false, 'launch settings never overwrite project Claude configuration');
  const credentialFile = terminal.options.env.MURMURPLEX_CREDENTIALS;
  assert.ok(credentialFile.startsWith(storage + path.sep));
  await extension.deactivate();
  assert.equal(fs.existsSync(credentialFile), false);
  extension.activate(context);
  await commands.get('murmurplex.start')();
  assert.ok(fs.existsSync(credentialFile), 'restored terminals keep the same external credential-file path');
  await hook('UserPromptSubmit');
  assert.equal(provider.getChildren().find(item => item.id === agent.id).status, 'working');
  const credential = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  const taskResponse = await fetch(credential.url + '/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Tracked feature', status: 'in-progress', ownerId: agent.id,
      branch: 'main', worktreePath: root, priority: 'high',
      acceptanceCriteria: ['Tests pass'], progress: 'Implementation ready',
      nextAction: 'Run the recovery tests', blocker: 'Review pending'
    })
  });
  assert.equal(taskResponse.status, 200);
  const tasks = repositoryProvider.getChildren().find(item => item.label === 'Tasks');
  const trackedTask = repositoryProvider.getChildren(tasks).find(item => item.label === 'Tracked feature' && item.description === 'HIGH · in-progress');
  assert.equal(trackedTask.description, 'HIGH · in-progress');
  assert.match(trackedTask.tooltip, /Progress: Implementation ready/);
  assert.match(trackedTask.tooltip, /Next: Run the recovery tests/);
  assert.match(trackedTask.tooltip, /Blocker: Review pending/);
  assert.equal(repositoryProvider.getChildren(trackedTask).find(item => item.label === 'Next action').description, 'Run the recovery tests');
  const criteria = repositoryProvider.getChildren(trackedTask).find(item => item.label === 'Acceptance criteria');
  assert.equal(repositoryProvider.getChildren(criteria)[0].label, 'Tests pass');
  const references = repositoryProvider.getChildren().find(item => item.label === 'Saved task references');
  assert.equal(repositoryProvider.getChildren(references)[0].description, 'PRESENT', 'task changes refresh the saved-reference view without rerunning Git');
  assert.equal(repositoryProvider.getChildren(references)[0].tooltip, `branch main\nworktree ${root}`);
  const post = (body) => fetch(credential.url + '/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${credential.token}` }, body: JSON.stringify(body)
  });
  assert.equal((await post({ to: agent.id, body: 'Coordinator-only exchange' })).status, 200);
  assert.equal((await post({ to: other.id, body: 'Worker-visible exchange' })).status, 200);
  selectedAgent = other.id;
  await commands.get('murmurplex.brief')();
  assert.match(handover, /Worker-visible exchange/);
  assert.match(handover, /Run the recovery tests/);
  assert.doesNotMatch(handover, /Coordinator-only exchange/);
  assert.ok(!handover.includes(credential.token));
  inheritAuthentication = true;
  await commands.get('murmurplex.addTab')({ kind: 'shell', name: 'Compatibility login' });
  assert.equal(vscode.window.terminals.at(-1).options.env.OPENAI_API_KEY, undefined, 'compatibility mode does not delete provider credentials');

  const pending = [];
  inspect = () => new Promise(resolve => pending.push(resolve));
  const olderRefresh = commands.get('murmurplex.refreshRepository')();
  const newerRefresh = commands.get('murmurplex.refreshRepository')();
  assert.equal(pending.length, 2);
  pending[1]({ root, branch: 'newer', head: 'new-head', changes: [], worktrees: [] });
  await newerRefresh;
  pending[0]({ root, branch: 'older', head: 'old-head', changes: [], worktrees: [] });
  await olderRefresh;
  assert.equal(repositoryProvider.getChildren().find(item => item.label === 'Branch').description, 'newer');
  assert.deepEqual(errors, []);
});
