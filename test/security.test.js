'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startService } = require('../src/service');
const { Store } = require('../src/store');
const { authenticationEnvironment, redact } = require('../src/security');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-security-'));
  const directory = path.join(root, 'project', '.murmurplex');
  const credentials = path.join(root, 'private', 'credentials');
  const service = await startService(directory, credentials);
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agents = ['Coordinator', 'Worker', 'Other'].map(name => service.store.register({ name, kind: 'shell' }));
  for (const agent of agents) service.issueCredential(agent.id);
  const request = (agent, route, body) => fetch(service.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${JSON.parse(fs.readFileSync(service.credentialFile(agent.id), 'utf8')).token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { root, directory, credentials, service, agents, request };
}

test('only the user manages membership; coordinator authority follows handover and workers cannot reassign tasks', async t => {
  const { service, agents: [lead, worker, other], request } = await fixture(t);
  const assigned = await (await request(lead, '/tasks', {
    title: 'Review', ownerId: worker.id, priority: 'high',
    acceptanceCriteria: ['Changes are covered by tests']
  })).json();
  const others = service.store.task({ title: 'Other work', ownerId: other.id });
  const before = service.store.snapshot();
  for (const [agent, route, body] of [
    [worker, '/agents', { name: 'Unexpected', kind: 'shell' }],
    [lead, '/agents', { name: 'Unexpected', kind: 'shell' }],
    [worker, '/coordinator', { agentId: worker.id }],
    [lead, '/coordinator', { agentId: worker.id }],
    [worker, '/decisions', { body: 'Not authorised' }],
    [worker, '/tasks', { title: 'New task', ownerId: worker.id }],
    [worker, '/tasks', { id: others.id, title: 'Stolen', ownerId: worker.id }],
    [worker, '/tasks', { id: assigned.id, title: 'Reassigned', ownerId: other.id }],
    [worker, '/tasks', { id: assigned.id, title: 'Unassigned', ownerId: null }],
    [worker, '/tasks', { id: assigned.id, priority: 'urgent' }],
    [worker, '/tasks', { id: assigned.id, acceptanceCriteria: [] }],
    [worker, '/tasks', { id: assigned.id, dependsOn: [others.id] }]
  ]) {
    assert.equal((await request(agent, route, body)).status, 403, route);
    assert.deepEqual(service.store.snapshot(), before, 'denied operations cannot mutate state');
  }
  const updated = await (await request(worker, '/tasks', {
    id: assigned.id, status: 'review', progress: 'Review complete',
    nextAction: 'Request coordinator review', blocker: 'Waiting for approval'
  })).json();
  assert.equal(updated.ownerId, worker.id);
  assert.equal(updated.title, 'Review');
  assert.equal(updated.status, 'review');
  assert.equal(updated.priority, 'high', 'workers cannot change coordinator-owned planning metadata');
  assert.equal(updated.progress, 'Review complete');
  assert.equal(updated.nextAction, 'Request coordinator review');
  assert.equal(updated.blocker, 'Waiting for approval');
  assert.deepEqual(updated.acceptanceCriteria, ['Changes are covered by tests']);
  assert.equal((await request(lead, '/decisions', { body: 'Review required' })).status, 200);
  service.store.coordinator(worker.id);
  assert.equal((await request(lead, '/decisions', { body: 'Former coordinator' })).status, 403);
  assert.equal((await request(lead, '/tasks', { title: 'Former coordinator' })).status, 403);
  assert.equal((await request(worker, '/decisions', { body: 'New coordinator' })).status, 200);
  assert.equal((await request(worker, '/tasks', { title: 'Assigned by new coordinator', ownerId: other.id })).status, 200);
});

test('all agents share the board while legacy mail is excluded from agent state', async t => {
  const { service, agents: [lead, worker, other], request } = await fixture(t);
  service.store.post({ from: lead.id, requestTo: other.id, body: 'Shared request' });
  service.store.post({ from: 'user', body: 'User post' });
  service.store.post({ from: worker.id, body: 'Worker post' });
  service.store.post({ from: lead.id, requestTo: worker.id, body: 'Another request' });
  const own = await (await request(worker, '/state')).json();
  assert.equal(own.posts.length, 4);
  assert.equal(own.legacyMessages, undefined);
  assert.equal((await (await request(lead, '/state')).json()).legacyMessages, undefined);
  service.store.coordinator(other.id);
  assert.deepEqual((await (await request(other, '/state')).json()).posts, own.posts);
  assert.deepEqual((await (await request(lead, '/state')).json()).posts, own.posts);
});

test('task-linked board requests preserve sender identity and task ownership', async t => {
  const { service, agents: [lead, worker, other], request } = await fixture(t);
  const task = service.store.task({ title: 'Review', ownerId: other.id });
  const response = await request(worker, '/board', { requestTo: lead.id, mentions: [other.id], taskId: task.id, body: 'Can I help review?' });
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.equal(message.from, worker.id);
  assert.equal(message.taskId, task.id);
  assert.deepEqual(service.store.snapshot().tasks[0], task);
  assert.equal((await (await request(worker, '/state')).json()).posts[0].taskId, task.id);
  assert.equal((await (await request(other, '/state')).json()).posts[0].id, message.id, 'requests are public even to other agents');
  const before = service.store.snapshot();
  assert.equal((await request(worker, '/board', { from: other.id, taskId: task.id, body: 'Spoofed sender' })).status, 403);
  assert.equal((await request(worker, '/board', { taskId: 'missing', body: 'Invalid link' })).status, 400);
  assert.equal((await request(worker, '/board/ack', { postId: message.id })).status, 400);
  assert.deepEqual(service.store.snapshot(), before);
  assert.equal((await request(lead, '/board/ack', { postId: message.id })).status, 200);
});

test('secret-bearing writes fail without persistence or diagnostic leaks, including live Murmurplex tokens', async t => {
  const { root, directory, service, agents: [lead, worker], request } = await fixture(t);
  const providerKey = ['sk', 'proj', randomBytes(24).toString('base64url')].join('-');
  const token = JSON.parse(fs.readFileSync(service.credentialFile(worker.id), 'utf8')).token;
  const before = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  for (const [route, body] of [
    ['/board', { body: `Please use ${providerKey}` }],
    ['/board', { body: `Please use ${token}` }],
    ['/tasks', { title: providerKey }],
    ['/decisions', { body: providerKey }],
    ['/board', { body: JSON.stringify({ password: randomBytes(24).toString('base64url') }) }],
    ['/board', { body: `AWS_SECRET_ACCESS_KEY=${randomBytes(24).toString('base64')}` }]
  ]) {
    const response = await request(lead, route, body);
    assert.equal(response.status, 400);
    const diagnostic = await response.text();
    assert.match(diagnostic, /Potential secret detected/);
    assert.ok(!diagnostic.includes(providerKey) && !diagnostic.includes(token));
    assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), before);
  }
  assert.throws(() => service.store.register({ name: providerKey, kind: 'shell' }), /Potential secret/);
  const malformed = path.join(root, 'malformed.json');
  fs.writeFileSync(malformed, `{"token":"${token}", "broken": ${providerKey}}`);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/murmurplex-agent'), 'state'], {
    env: { ...process.env, MURMURPLEX_CREDENTIALS: malformed }, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Credential file contains invalid JSON/);
  assert.ok(!result.stderr.includes(token.slice(0, 12)) && !result.stderr.includes(providerKey.slice(0, 18)));
  assert.equal(result.stdout, '');
  const diagnostic = redact(`Failure with ${providerKey} and ${token}`);
  assert.ok(!diagnostic.includes(providerKey) && !diagnostic.includes(token));
});

test('native-login environments strip common secrets without copying credentials; compatibility preserves provider inheritance', () => {
  const source = { HOME: '/home/example', PATH: '/bin', OPENAI_API_KEY: 'example', GH_TOKEN: 'example', CUSTOM_PASSWORD: 'example' };
  const native = authenticationEnvironment(false, source);
  assert.equal(native.OPENAI_API_KEY, null);
  assert.equal(native.GH_TOKEN, null);
  assert.equal(native.CUSTOM_PASSWORD, null);
  assert.equal(native.HOME, undefined);
  assert.equal(native.PATH, undefined);
  const inherited = authenticationEnvironment(true, source);
  assert.equal(inherited.OPENAI_API_KEY, undefined);
  assert.equal(inherited.GH_TOKEN, undefined);
  assert.equal(inherited.MURMURPLEX_TOKEN, null);
});

test('existing secret-bearing state is refused unchanged before backups or migration writes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-secret-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'state');
  const store = new Store(directory);
  const state = store.snapshot();
  store.close();
  state.version = 1;
  state.decisions.push({ id: 'existing', body: ['ghp', randomBytes(18).toString('hex')].join('_'), createdAt: new Date().toISOString() });
  const raw = JSON.stringify(state);
  fs.writeFileSync(path.join(directory, 'state.json'), raw);
  await assert.rejects(startService(directory, path.join(root, 'credentials')), /Potential secret detected/);
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), raw);
  assert.equal(fs.existsSync(path.join(directory, 'state.json.v1.bak')), false);
  assert.equal(fs.existsSync(path.join(directory, 'writer.lock')), false);
});
