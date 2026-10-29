'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { CURRENT_VERSION } = require('../src/migrations');

const v1 = overrides => ({
  version: 1, revision: 7, coordinatorId: 'a', tasks: [], messages: [], decisions: [],
  agents: [{ id: 'a', name: 'Claude', kind: 'claude', status: 'working', attention: null, createdAt: 'x' }],
  ...overrides
});

function project(t, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const raw = typeof state === 'string' ? state : JSON.stringify(state);
  fs.writeFileSync(file, raw);
  return { root, file, raw };
}

test('a version 1 project is migrated, backed up once, and keeps its records', t => {
  const { root, file, raw } = project(t, v1({
    agents: [
      { id: 'a', name: 'Claude', kind: 'claude', status: 'needs-input', attention: 'needs-input', createdAt: 'x', claude: { sessionId: 's', tools: [], requests: [{ sessionId: 's', scope: '', id: 't', attention: 'needs-input' }] } },
      { id: 'b', name: 'Shell', kind: 'shell', status: 'idle', createdAt: 'x', copilot: { sessionId: 's', requests: [] } },
      { id: 'c', name: 'Copilot', kind: 'copilot', status: 'idle', attention: null, createdAt: 'x', copilot: { requests: 'broken' } }
    ],
    messages: [{ id: 'm', from: 'a', to: 'b', body: 'hi', createdAt: 'x', acknowledgedAt: null }]
  }));
  const store = new Store(root);
  const state = store.snapshot();
  store.close();
  assert.equal(state.version, CURRENT_VERSION);
  assert.equal(state.messages.length, 1);
  assert.equal(state.agents[0].claude.requests.length, 1, 'outstanding requests survive migration');
  assert.equal(state.agents[0].attention, 'needs-input');
  assert.equal(state.agents[1].attention, null);
  assert.equal(state.agents[1].copilot, undefined, 'a lifecycle record on the wrong agent kind is dropped');
  assert.deepEqual(state.agents[2].copilot, { sessionId: null, requests: [] });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, CURRENT_VERSION);
  assert.equal(fs.readFileSync(`${file}.v1.bak`, 'utf8'), raw);
  const again = new Store(root);
  again.close();
  assert.equal(fs.readFileSync(`${file}.v1.bak`, 'utf8'), raw, 'the backup is not overwritten');
});

test('version 2 tasks gain optional branch and worktree references during migration', t => {
  const legacy = { ...v1({ version: 2, tasks: [{ id: 'task-1', title: 'Review', status: 'review', ownerId: 'a' }] }) };
  const { root, file, raw } = project(t, legacy);
  const store = new Store(root);
  const state = store.snapshot();
  store.close();
  assert.equal(state.version, CURRENT_VERSION);
  assert.deepEqual(state.tasks[0], {
    id: 'task-1', title: 'Review', status: 'review', ownerId: 'a', branch: null, worktreePath: null,
    priority: 'normal', acceptanceCriteria: [], dependsOn: [], progress: '', blocker: null, nextAction: ''
  });
  assert.equal(fs.readFileSync(`${file}.v2.bak`, 'utf8'), raw);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, CURRENT_VERSION);
});

test('version 3 tasks gain richer metadata defaults during migration', t => {
  const legacy = v1({
    version: 3,
    tasks: [{ id: 'task-1', title: 'Review', status: 'review', ownerId: 'a', branch: 'main', worktreePath: null }]
  });
  const { root, file, raw } = project(t, legacy);
  const store = new Store(root);
  const task = store.snapshot().tasks[0];
  store.close();
  assert.equal(task.priority, 'normal');
  assert.deepEqual(task.acceptanceCriteria, []);
  assert.deepEqual(task.dependsOn, []);
  assert.equal(task.progress, '');
  assert.equal(task.blocker, null);
  assert.equal(fs.readFileSync(`${file}.v3.bak`, 'utf8'), raw);
});

test('version 4 tasks gain next-action defaults during migration', t => {
  const legacy = v1({
    version: 4,
    tasks: [{
      id: 'task-1', title: 'Review', status: 'review', ownerId: 'a', branch: 'main', worktreePath: null,
      priority: 'normal', acceptanceCriteria: [], dependsOn: [], progress: 'Code ready', blocker: null
    }]
  });
  const { root, file, raw } = project(t, legacy);
  const store = new Store(root);
  const task = store.snapshot().tasks[0];
  store.close();
  assert.equal(task.progress, 'Code ready');
  assert.equal(task.nextAction, '');
  assert.equal(fs.readFileSync(`${file}.v4.bak`, 'utf8'), raw);
});

test('new projects start at the current version without a backup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  assert.equal(store.snapshot().version, CURRENT_VERSION);
  store.close();
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.bak')), []);
});

test('newer, malformed or inconsistent state is refused and left untouched', t => {
  const cases = {
    newer: v1({ version: CURRENT_VERSION + 1 }),
    'no version': { ...v1(), version: undefined },
    'fractional version': v1({ version: 1.5 }),
    'missing list': v1({ tasks: undefined }),
    'bad revision': v1({ revision: -1 }),
    'duplicate agent': v1({ agents: [v1().agents[0], v1().agents[0]] }),
    'unknown kind': v1({ agents: [{ ...v1().agents[0], kind: 'gemini' }] }),
    'unknown status': v1({ agents: [{ ...v1().agents[0], status: 'sleeping' }] }),
    'bad attention': v1({ agents: [{ ...v1().agents[0], attention: 'angry' }] }),
    'unknown coordinator': v1({ coordinatorId: 'missing' }),
    'invalid task branch': v1({ tasks: [{ id: 'task', branch: 'bad\nbranch', worktreePath: null }] }),
    'missing task reference fields': v1({ version: CURRENT_VERSION, tasks: [{ id: 'task' }] }),
    'missing task dependency': v1({ version: CURRENT_VERSION, tasks: [{
      id: 'task-1', ownerId: null, branch: null, worktreePath: null, priority: 'normal',
      acceptanceCriteria: [], dependsOn: ['missing'], progress: '', blocker: null, nextAction: ''
    }] }),
    'cyclic task dependencies': v1({ version: CURRENT_VERSION, tasks: [
      { id: 'task-1', ownerId: null, branch: null, worktreePath: null, priority: 'normal', acceptanceCriteria: [], dependsOn: ['task-2'], progress: '', blocker: null, nextAction: '' },
      { id: 'task-2', ownerId: null, branch: null, worktreePath: null, priority: 'normal', acceptanceCriteria: [], dependsOn: ['task-1'], progress: '', blocker: null, nextAction: '' }
    ] }),
    'not an object': '[]'
  };
  for (const [name, state] of Object.entries(cases)) {
    const { root, file, raw } = project(t, state);
    assert.throws(() => new Store(root), /state|Murmurplex/, name);
    assert.equal(fs.readFileSync(file, 'utf8'), raw, `${name}: original file preserved`);
    assert.equal(fs.existsSync(path.join(root, 'writer.lock')), false, `${name}: lock released`);
    assert.deepEqual(fs.readdirSync(root).filter(entry => entry.endsWith('.bak')), [], `${name}: no backup for refused state`);
  }
  assert.throws(() => new Store(project(t, v1({ version: CURRENT_VERSION + 1 })).root), /newer Murmurplex/);
});
