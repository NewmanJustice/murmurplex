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

const tokenOf = (service, id) => JSON.parse(fs.readFileSync(service.credentialFile(id), 'utf8')).token;

test('service authentication, mailbox, invalid requests and restart recovery', async t => {
  const directory = temporary(t);
  let service = await startService(directory);
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
  assert.equal(fs.existsSync(path.join(directory, 'credentials')), false);
  service = await startService(directory);
  assert.equal(fs.readdirSync(path.join(directory, 'credentials')).length, 0, 'credentials never survive a restart');
  assert.equal((await request('/state', null, stale)).status, 401);
  service.issueCredential(lead.id); service.issueCredential(worker.id);
  const inbox = await (await asWorker(`/inbox`)).json();
  assert.equal(inbox.length, 2);
  assert.equal((await asLead('/ack', { agentId: lead.id, messageId: inbox[0].id })).status, 400);
  assert.equal((await asWorker('/ack', { agentId: worker.id, messageId: inbox[0].id })).status, 200);
});

test('CLI help documents queued delivery without requiring credentials', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/murmurplex-agent'), 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /does not wake another agent/);
});

test('agent helper reads refreshed credentials after a service restart and never needs a token in its environment', async t => {
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const directory = temporary(t);
  let service = await startService(path.join(directory, '.murmurplex'));
  t.after(async () => { if (service) await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const agent = service.store.register({ name: 'Restored worker', kind: 'shell' });
  service.issueCredential(agent.id);
  const environment = { ...process.env, MURMURPLEX_AGENT_ID: agent.id, MURMURPLEX_CREDENTIALS: service.credentialFile(agent.id) };
  assert.equal(Object.keys(environment).some(key => /TOKEN/.test(key) && key.startsWith('MURMURPLEX')), false);
  await service.close(); service = undefined;
  service = await startService(path.join(directory, '.murmurplex'));
  service.issueCredential(agent.id);
  const helper = path.join(__dirname, '../bin/murmurplex-agent');
  const sent = await execFile(process.execPath, [helper, 'send', agent.id, 'Message after restart'], { env: environment });
  const message = JSON.parse(sent.stdout);
  assert.equal(message.from, agent.id);
  const received = await execFile(process.execPath, [helper, 'inbox'], { env: environment });
  assert.equal(JSON.parse(received.stdout)[0].id, message.id);
  await execFile(process.execPath, [helper, 'status', 'needs-input'], { env: environment });
  assert.equal(service.store.agent(agent.id).attention, 'needs-input');
  await execFile(process.execPath, [helper, 'ack', message.id], { env: environment });
  assert.equal(service.store.inbox(agent.id).length, 0);
  service.revokeCredential(agent.id);
  await assert.rejects(execFile(process.execPath, [helper, 'status', 'idle'], { env: environment }), /ENOENT/);
  await assert.rejects(execFile(process.execPath, [helper, 'status', 'idle'], { env: { ...process.env, MURMURPLEX_AGENT_ID: agent.id } }), /No Murmurplex credentials/);
});
