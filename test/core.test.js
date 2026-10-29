'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store } = require('../src/store');
const { startService } = require('../src/service');
const { gridLayout } = require('../src/layout');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-'));
  return directory;
}

test('grid gives every pane equal area for one through nine groups', () => {
  for (let count = 1; count <= 9; count++) {
    const layout = gridLayout(count);
    assert.equal(layout.orientation, 1);
    assert.equal(layout.groups.reduce((sum, row) => sum + row.groups.length, 0), count);
    for (const row of layout.groups) for (const pane of row.groups) assert.ok(Math.abs(row.size * pane.size - 1 / count) < 1e-12);
  }
  assert.throws(() => gridLayout(10));
});

test('project recovery preserves ownership, coordinator handover, attention and unacknowledged mail', t => {
  const directory = temporary(t);
  let store = new Store(directory);
  const coordinator = store.register({ name: 'Lead', kind: 'claude' });
  const worker = store.register({ name: 'Reviewer', kind: 'codex' });
  store.task({ title: 'Review implementation', status: 'review', ownerId: worker.id });
  store.decision('Merges require user approval.');
  const message = store.send({ from: coordinator.id, to: worker.id, body: 'Review the branch.' });
  store.status(worker.id, 'needs-permission');
  store.coordinator(worker.id);
  store.close();
  store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const snapshot = store.snapshot();
  assert.equal(snapshot.coordinatorId, worker.id);
  assert.equal(snapshot.tasks[0].ownerId, worker.id);
  assert.equal(snapshot.decisions[0].body, 'Merges require user approval.');
  assert.equal(snapshot.agents[1].status, 'disconnected');
  assert.equal(snapshot.agents[1].attention, 'needs-permission');
  assert.equal(store.inbox(worker.id)[0].id, message.id);
  assert.equal(store.inbox(worker.id).length, 1, 'reading is not acknowledgement');
  assert.throws(() => store.acknowledge(coordinator.id, message.id));
  store.acknowledge(worker.id, message.id);
  assert.equal(store.inbox(worker.id).length, 0);
  store.status(worker.id, 'working');
  assert.equal(store.snapshot().agents[1].attention, null);
});

test('task branch and worktree references persist, update and reject invalid values', t => {
  const directory = temporary(t);
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const task = store.task({ title: 'Implement feature', branch: 'feature/next', worktreePath: '/projects/feature' });
  assert.equal(task.branch, 'feature/next');
  assert.equal(task.worktreePath, '/projects/feature');
  const updated = store.task({ id: task.id, title: task.title, status: 'in-progress' });
  assert.equal(updated.branch, 'feature/next', 'omitted references are retained on update');
  assert.equal(updated.worktreePath, '/projects/feature');
  for (const invalid of [{ branch: '' }, { branch: 'bad\nbranch' }, { worktreePath: ' ' }, { worktreePath: 'bad\0path' }]) {
    assert.throws(() => store.task({ id: task.id, title: task.title, ...invalid }));
  }
  assert.deepEqual(store.snapshot().tasks[0], updated);
});

test('single writer and validation failures preserve committed state', t => {
  const directory = temporary(t);
  const store = new Store(directory); t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.throws(() => new Store(directory), /owns this project/);
  const before = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  assert.throws(() => store.send({ from: 'user', to: 'missing', body: 'hello' }));
  assert.throws(() => store.register({ name: 'Unknown', kind: 'made-up' }));
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), before);
});

test('corrupt state fails visibly without overwriting it or leaking the lock', t => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'state.json'), '{broken');
  assert.throws(() => new Store(directory));
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(directory, 'writer.lock')), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a stale lock is never reclaimed automatically, reports its owner, and is only removed explicitly', t => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'writer.lock'), JSON.stringify({ pid: 2 ** 22 + 1, hostname: 'old-container', startedAt: '2026-01-01T00:00:00.000Z' }));
  assert.throws(() => new Store(directory), error => error.code === 'PROJECT_LOCKED' && /process 4194305 on old-container since 2026-01-01.*never reclaimed automatically/.test(error.message));
  const owner = Store.lockOwner(directory);
  assert.equal(owner.hostname, 'old-container');
  Store.breakLock(directory, owner);
  const store = new Store(directory);
  assert.equal(Store.lockOwner(directory).pid, process.pid);
  store.close();
  assert.equal(Store.lockOwner(directory), undefined);
  fs.writeFileSync(path.join(directory, 'writer.lock'), '1234\n');
  assert.equal(Store.lockOwner(directory).pid, 1234);
});

test('recovery cannot remove a replacement lock and a displaced writer cannot commit or release it', t => {
  const directory = temporary();
  let second;
  t.after(() => { second?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const first = new Store(directory);
  const confirmed = Store.lockOwner(directory);
  // Simulate explicit recovery of a still-running owner; it must lose all write authority.
  Store.breakLock(directory, confirmed);
  second = new Store(directory);
  const replacement = Store.lockOwner(directory);
  assert.throws(() => Store.breakLock(directory, confirmed), /lock changed/);
  assert.throws(() => Store.breakLock(directory), /lock changed/);
  const before = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  assert.throws(() => first.register({ name: 'Lost writer', kind: 'shell' }), /ownership was lost/);
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), before);
  assert.throws(() => first.close(), /current lock was not removed/);
  assert.equal(Store.lockOwner(directory).raw, replacement.raw);
  second.register({ name: 'Still owned', kind: 'shell' });
});

test('recovery excludes another process throughout the lock removal operation', t => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = path.join(directory, 'writer.lock');
  fs.writeFileSync(lock, '1234\n');
  const confirmed = Store.lockOwner(directory);
  const unlink = fs.unlinkSync;
  let contender;
  t.mock.method(fs, 'unlinkSync', filename => {
    unlink(filename);
    if (filename === lock) contender = spawnSync(process.execPath, ['-e', `
      const { Store } = require(${JSON.stringify(require.resolve('../src/store'))});
      try { new Store(process.argv[1]); process.exitCode = 1; }
      catch (error) {
        if (!/writer operation is in progress/.test(error.message)) throw error;
      }
    `, directory], { encoding: 'utf8', timeout: 10000 });
  });
  Store.breakLock(directory, confirmed);
  assert.equal(contender.status, 0, contender.stderr);
  const store = new Store(directory);
  store.close();
});

test('an interrupted writer operation fails closed instead of reclaiming its guard', t => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = path.join(directory, 'writer.lock');
  fs.writeFileSync(lock, '1234\n');
  const owner = Store.lockOwner(directory);
  fs.mkdirSync(path.join(directory, 'writer-operation.lock'));
  assert.throws(() => new Store(directory), /stop all Murmurplex windows and containers/);
  assert.throws(() => Store.breakLock(directory, owner), /writer operation is in progress/);
  assert.equal(Store.lockOwner(directory).raw, owner.raw);
});

test('cleanup preserves non-writer backups, directories and symlinks', t => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backup = path.join(directory, 'state.json.manual-backup.tmp');
  const orphan = path.join(directory, 'state.json.12345678-1234-4123-8123-123456789abc.tmp');
  const folder = path.join(directory, 'state.json.12345678-1234-4123-8123-123456789abd.tmp');
  const link = path.join(directory, 'state.json.12345678-1234-4123-8123-123456789abe.tmp');
  fs.writeFileSync(backup, 'manual backup');
  fs.writeFileSync(orphan, 'partial write');
  fs.mkdirSync(folder);
  if (process.platform !== 'win32') fs.symlinkSync(backup, link);
  const store = new Store(directory);
  store.close();
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'manual backup');
  assert.ok(fs.statSync(folder).isDirectory());
  if (process.platform !== 'win32') assert.ok(fs.lstatSync(link).isSymbolicLink());
});

for (const stage of ['partial-write', 'after-fsync', 'before-rename']) {
  test(`a killed subprocess preserves committed state at ${stage} and recovers its orphan`, t => {
    const directory = temporary();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let store = new Store(directory);
    const agent = store.register({ name: 'Lead', kind: 'claude' });
    store.close();
    const before = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { Store } = require(${JSON.stringify(require.resolve('../src/store'))});
      const store = new Store(process.argv[1]);
      fs.copyFileSync(store.filename, require('node:path').join(process.argv[1], 'committed.json'));
      const write = fs.writeFileSync;
      const sync = fs.fsyncSync;
      if (process.argv[2] === 'partial-write') {
        fs.writeFileSync = (fd, data, ...args) => {
          write(fd, data.slice(0, 12), ...args);
          process.kill(process.pid, 'SIGKILL');
        };
      } else if (process.argv[2] === 'after-fsync') {
        fs.fsyncSync = fd => { sync(fd); process.kill(process.pid, 'SIGKILL'); };
      } else {
        fs.renameSync = () => { process.kill(process.pid, 'SIGKILL'); };
      }
      store.register({ name: 'Uncommitted', kind: 'shell' });
    `, directory, stage], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.ok(child.signal === 'SIGKILL' || (process.platform === 'win32' && child.status !== 0), child.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), fs.readFileSync(path.join(directory, 'committed.json'), 'utf8'));
    assert.deepEqual(saved.agents.map(a => a.id), before.agents.map(a => a.id));
    const orphans = fs.readdirSync(directory).filter(name => name.endsWith('.tmp'));
    assert.equal(orphans.length, 1);
    if (stage === 'before-rename') {
      assert.throws(() => new Store(directory), /writer operation is in progress/);
      // The subprocess is dead and no other service exists; offline guard removal is safe.
      fs.rmdirSync(path.join(directory, 'writer-operation.lock'));
    }
    assert.throws(() => new Store(directory), /stale writer\.lock/);
    Store.breakLock(directory, Store.lockOwner(directory));
    store = new Store(directory);
    assert.equal(store.agent(agent.id).name, 'Lead');
    assert.equal(store.snapshot().agents.length, 1);
    assert.equal(fs.existsSync(path.join(directory, orphans[0])), false);
    store.close();
  });
}

test('a failed rename preserves both committed and in-memory state and releases its operation guard', t => {
  const directory = temporary();
  const store = new Store(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const before = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  const state = store.snapshot();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('injected rename failure'); });
  assert.throws(() => store.register({ name: 'Uncommitted', kind: 'shell' }), /injected rename failure/);
  rename.mock.restore();
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), before);
  assert.deepEqual(store.snapshot(), state);
  assert.equal(fs.existsSync(path.join(directory, 'writer-operation.lock')), false);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

const tokenOf = (service, id) => JSON.parse(fs.readFileSync(service.credentialFile(id), 'utf8')).token;

test('credentials stay outside Git even without ignore rules and legacy checkout credentials are removed', async t => {
  const directory = temporary(t);
  const project = path.join(directory, 'project');
  const stateDirectory = path.join(project, '.murmurplex');
  const credentialsDirectory = path.join(directory, 'private', 'credentials');
  fs.mkdirSync(path.join(stateDirectory, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(stateDirectory, 'credentials', 'legacy.json'), '{"token":"old"}');
  fs.writeFileSync(path.join(stateDirectory, 'runtime.json'), '{"token":"old"}');
  const initialized = spawnSync('git', ['init', '--quiet', project], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const service = await startService(stateDirectory, credentialsDirectory);
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const agent = service.store.register({ name: 'Worker', kind: 'shell' });
  service.issueCredential(agent.id);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'credentials')), false);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'runtime.json')), false);
  assert.equal(fs.existsSync(path.join(project, '.gitignore')), false);
  assert.equal(fs.statSync(credentialsDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(service.credentialFile(agent.id)).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(service.credentialFile(agent.id)));
  assert.ok(!fs.readFileSync(path.join(stateDirectory, 'state.json'), 'utf8').includes(tokenOf(service, agent.id)));
  const staged = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', 'add', '--dry-run', '.'], { cwd: project, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(staged.stdout, /state\.json/);
  assert.doesNotMatch(staged.stdout, /credentials|runtime\.json/);
});

test('service authentication, mailbox, invalid requests and restart recovery', async t => {
  const directory = temporary(t);
  const credentialsDirectory = `${directory}-credentials`;
  let service = await startService(directory, credentialsDirectory);
  t.after(async () => { if (service) await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const lead = service.store.register({ name: 'Coordinator', kind: 'copilot' });
  const worker = service.store.register({ name: 'Worker', kind: 'codex' });
  service.issueCredential(lead.id); service.issueCredential(worker.id);
  const request = (endpoint, body, token, origin) => fetch(service.url + endpoint, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const asLead = (endpoint, body) => request(endpoint, body, tokenOf(service, lead.id));
  const asWorker = (endpoint, body) => request(endpoint, body, tokenOf(service, worker.id));
  assert.equal((await request('/state')).status, 401);
  assert.equal((await request('/state', null, 'wrong')).status, 401);
  assert.equal((await request('/state', null, tokenOf(service, lead.id), 'https://example.com')).status, 401);
  assert.equal((await asLead('/messages', { from: lead.id, to: worker.id, body: 'Please review.' })).status, 200);
  assert.equal((await asLead('/messages', { to: worker.id, body: 'The sender defaults to the caller.' })).status, 200);
  assert.equal((await asWorker('/status', { agentId: worker.id, status: 'invalid' })).status, 400);
  assert.equal((await asWorker('/missing')).status, 404);
  assert.equal((await request('/status', { status: 'idle' }, tokenOf(service, worker.id)).then(r => r.status)), 200);
  assert.equal((await fetch(service.url + '/status', { method: 'POST', headers: { Authorization: `Bearer ${tokenOf(service, worker.id)}` }, body: '{broken' })).status, 400);
  assert.equal((await fetch(service.url + '/status', { method: 'POST', headers: { Authorization: `Bearer ${tokenOf(service, worker.id)}` }, body: 'x'.repeat(70000) })).status, 413);
  // An agent cannot act as another agent or as the user.
  const before = service.store.snapshot();
  for (const [endpoint, body] of [
    ['/status', { agentId: lead.id, status: 'needs-permission' }],
    ['/messages', { from: lead.id, to: worker.id, body: 'spoofed' }],
    ['/messages', { from: 'user', to: lead.id, body: 'spoofed' }],
    ['/ack', { agentId: lead.id, messageId: 'any' }],
    ['/hooks/codex', { agentId: lead.id, event: {} }]
  ]) assert.equal((await asWorker(endpoint, body)).status, 403, `${endpoint} ${JSON.stringify(body)}`);
  assert.equal((await asWorker(`/inbox?agentId=${lead.id}`)).status, 403);
  assert.deepEqual(service.store.snapshot(), before);
  assert.equal(fs.statSync(service.credentialFile(worker.id)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(directory, 'runtime.json')), false, 'no shared credential is written');
  const oldToken = tokenOf(service, worker.id);
  service.issueCredential(worker.id);
  assert.notEqual(tokenOf(service, worker.id), oldToken);
  assert.equal((await request('/state', null, oldToken)).status, 401, 'rotation revokes the earlier token');
  assert.equal((await asWorker('/state')).status, 200);
  const stale = tokenOf(service, worker.id);
  service.revokeCredential(worker.id);
  assert.equal(fs.existsSync(service.credentialFile(worker.id)), false);
  assert.equal((await request('/state', null, stale)).status, 401, 'revocation takes effect immediately');
  service.issueCredential(worker.id);
  await service.close(); service = undefined;
  assert.equal(fs.existsSync(credentialsDirectory), false);
  service = await startService(directory, credentialsDirectory);
  assert.equal(fs.readdirSync(credentialsDirectory).length, 0, 'credentials never survive a restart');
  assert.equal((await request('/state', null, stale)).status, 401);
  service.issueCredential(lead.id); service.issueCredential(worker.id);
  const inbox = await (await asWorker(`/inbox`)).json();
  assert.equal(inbox.length, 2);
  assert.equal((await asLead('/ack', { agentId: lead.id, messageId: inbox[0].id })).status, 400);
  assert.equal((await asWorker('/ack', { agentId: worker.id, messageId: inbox[0].id })).status, 200);
});

test('CLI help documents queued delivery without requiring credentials', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/murmurplex-agent'), 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /does not wake another agent/);
  assert.match(result.stdout, /task <title> \[status\] \[owner-id\] \[task-id\] \[branch\] \[worktree-path\] \[--clear-branch\]/);
});

test('agent helper reads refreshed credentials after a service restart and never needs a token in its environment', async t => {
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const directory = temporary(t);
  const credentialsDirectory = path.join(directory, 'private', 'credentials');
  let service = await startService(path.join(directory, '.murmurplex'), credentialsDirectory);
  t.after(async () => { if (service) await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const agent = service.store.register({ name: 'Restored worker', kind: 'shell' });
  service.store.coordinator(agent.id);
  service.issueCredential(agent.id);
  const environment = { ...process.env, MURMURPLEX_AGENT_ID: agent.id, MURMURPLEX_CREDENTIALS: service.credentialFile(agent.id) };
  assert.equal(Object.keys(environment).some(key => /TOKEN/.test(key) && key.startsWith('MURMURPLEX')), false);
  await service.close(); service = undefined;
  service = await startService(path.join(directory, '.murmurplex'), credentialsDirectory);
  service.issueCredential(agent.id);
  const helper = path.join(__dirname, '../bin/murmurplex-agent');
  const sent = await execFile(process.execPath, [helper, 'send', agent.id, 'Message after restart'], { env: environment });
  const message = JSON.parse(sent.stdout);
  assert.equal(message.from, agent.id);
  const received = await execFile(process.execPath, [helper, 'inbox'], { env: environment });
  assert.equal(JSON.parse(received.stdout)[0].id, message.id);
  await execFile(process.execPath, [helper, 'status', 'needs-input'], { env: environment });
  assert.equal(service.store.agent(agent.id).attention, 'needs-input');
  const taskResult = await execFile(process.execPath, [helper, 'task', 'Tracked work', 'in-progress', '-', '-', 'null', 'null'], { env: environment });
  const task = JSON.parse(taskResult.stdout);
  assert.equal(task.branch, 'null', 'literal null is accepted as a branch name');
  assert.equal(task.worktreePath, 'null', 'literal null is accepted as a worktree path');
  const taskUpdate = await execFile(process.execPath, [helper, 'task', 'Tracked work', 'review', '-', task.id], { env: environment });
  assert.equal(JSON.parse(taskUpdate.stdout).branch, 'null', 'omitted task references survive CLI updates');
  const taskClear = await execFile(process.execPath, [helper, 'task', 'Tracked work', 'review', '-', task.id, '-', '-', '--clear-branch', '--clear-worktree'], { env: environment });
  assert.equal(JSON.parse(taskClear.stdout).branch, null);
  assert.equal(JSON.parse(taskClear.stdout).worktreePath, null);
  await execFile(process.execPath, [helper, 'ack', message.id], { env: environment });
  assert.equal(service.store.inbox(agent.id).length, 0);
  service.revokeCredential(agent.id);
  await assert.rejects(execFile(process.execPath, [helper, 'status', 'idle'], { env: environment }), /ENOENT/);
  await assert.rejects(execFile(process.execPath, [helper, 'status', 'idle'], { env: { ...process.env, MURMURPLEX_AGENT_ID: agent.id } }), /No Murmurplex credentials/);
});

test('compaction drops only the oldest resolved messages and decisions, never unacknowledged mail', t => {
  const directory = temporary(t);
  let store = new Store(directory, undefined, { retainResolved: 2 });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const lead = store.register({ name: 'Lead', kind: 'shell' });
  const worker = store.register({ name: 'Worker', kind: 'shell' });
  const pending = store.send({ from: lead.id, to: worker.id, body: 'pending-oldest' });
  const resolved = ['one', 'two', 'three', 'four'].map(body => {
    const message = store.send({ from: lead.id, to: worker.id, body });
    store.acknowledge(worker.id, message.id);
    return message;
  });
  for (const body of ['d1', 'd2', 'd3']) store.decision(body);
  const state = store.snapshot();
  assert.deepEqual(state.messages.map(m => m.body), ['pending-oldest', 'three', 'four']);
  assert.ok(state.messages.some(m => m.id === pending.id && !m.acknowledgedAt));
  assert.equal(state.messages.some(m => m.id === resolved[0].id), false);
  assert.deepEqual(state.decisions.map(d => d.body), ['d2', 'd3']);
  store.close();
  store = new Store(directory, undefined, { retainResolved: 2 });
  assert.deepEqual(store.snapshot().messages.map(m => m.body), ['pending-oldest', 'three', 'four']);
});

test('a read-only view reads the owner\'s state without taking the lock, writing, or migrating', t => {
  const directory = temporary();
  const owner = new Store(directory);
  t.after(() => { owner.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  owner.register({ name: 'Lead', kind: 'shell' });
  const view = Store.readOnly(directory);
  assert.equal(view.snapshot().agents[0].name, 'Lead');
  assert.equal(view.update, undefined);
  owner.register({ name: 'Worker', kind: 'shell' });
  assert.equal(view.snapshot().agents.length, 1);
  view.reload();
  assert.equal(view.snapshot().agents.length, 2);
  assert.equal(Store.lockOwner(directory).pid, process.pid);
  const before = fs.readdirSync(directory).sort();
  fs.writeFileSync(path.join(directory, 'state.json'), '{broken');
  assert.throws(() => view.reload());
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ version: 99 }));
  assert.throws(() => view.reload());
  assert.deepEqual(fs.readdirSync(directory).sort(), before);
});
