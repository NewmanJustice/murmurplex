'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startService } = require('../src/service');
const { Store } = require('../src/store');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-board-'));
  const directory = path.join(root, 'project');
  const credentials = path.join(root, 'private');
  let service = await startService(directory, credentials);
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    directory, service,
    restart: async () => { await service.close(); service = await startService(directory, credentials); return service; }
  };
}

function request(service, token, route, body, origin) {
  return fetch(service.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test('browser board authenticates the human separately from agents and rejects foreign origins', async t => {
  const f = await fixture(t);
  const { service } = f;
  const token = new URL(service.boardUrl()).hash.slice('#token='.length);
  const agent = service.store.register({ name: 'Worker', kind: 'shell' });
  service.issueCredential(agent.id);
  const agentToken = JSON.parse(fs.readFileSync(service.credentialFile(agent.id), 'utf8')).token;
  const page = await request(service, null, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!(await page.text()).includes(token));
  assert.equal((await request(service, null, '/board')).status, 401);
  assert.equal((await request(service, token, '/state')).status, 401);
  assert.equal((await request(service, agentToken, '/board/archive')).status, 403);
  assert.equal((await request(service, token, '/board', { body: 'Foreign' }, 'https://example.com')).status, 401);
  assert.equal((await request(service, agentToken, '/board', { body: 'Browser agent' }, service.url)).status, 401);
  assert.equal((await request(service, token, '/board', { from: agent.id, body: 'Spoofed' }, service.url)).status, 403);
  const post = await (await request(service, token, '/board', { body: 'Human request', requestTo: agent.id }, service.url)).json();
  assert.equal(post.from, 'user');
  assert.equal((await request(service, agentToken, '/board/ack', { postId: post.id })).status, 200);
  assert.equal((await request(service, token, '/board', { body: token }, service.url)).status, 400, 'browser credentials are secret-scanned');
  assert.throws(() => service.allowBoardOrigin('https://public.example.com'), /localhost/);
  service.allowBoardOrigin('http://localhost:45555/');
  assert.equal((await request(service, token, '/board', { body: 'Local forward' }, 'http://localhost:45555')).status, 200);
  const invalidHost = await new Promise((resolve, reject) => {
    require('node:http').get(service.url + '/board', { headers: { Host: 'attacker.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(invalidHost, 403);
  const restarted = await f.restart();
  assert.equal((await request(restarted, token, '/board')).status, 401, 'browser credentials do not survive restart');
  assert.equal(restarted.store.board().length, 2);
});

test('migration archives old private mail without publishing or exposing it to any agent', async t => {
  const f = await fixture(t);
  const agent = f.service.store.register({ name: 'Lead', kind: 'shell' });
  const old = f.service.store.snapshot();
  await f.service.close();
  old.version = 6;
  delete old.posts;
  delete old.legacyMessages;
  old.messages = [{ id: 'legacy', from: 'user', to: agent.id, body: 'Previously private', taskId: null, createdAt: '2026-10-29T10:00:00Z', acknowledgedAt: null }];
  const raw = JSON.stringify(old);
  fs.writeFileSync(path.join(f.directory, 'state.json'), raw);
  // Restart is safe after close; credentials and lock have already been released.
  const restored = await f.restart();
  assert.deepEqual(restored.store.board(), []);
  assert.deepEqual(restored.store.snapshot().legacyMessages, old.messages);
  assert.equal(restored.store.snapshotFor(agent.id).legacyMessages, undefined, 'even the coordinator cannot fetch legacy mail');
  const token = new URL(restored.boardUrl()).hash.slice('#token='.length);
  const archive = await (await request(restored, token, '/board/archive')).json();
  assert.deepEqual(archive, old.messages);
  restored.store.post({ from: agent.id, body: 'New shared context' });
  assert.deepEqual(restored.store.snapshot().legacyMessages, old.messages);
  assert.equal(fs.readFileSync(path.join(f.directory, 'state.json.v6.bak'), 'utf8'), raw);
});

test('invalid board references and persisted post shapes fail without rewriting committed data', async t => {
  const f = await fixture(t);
  const store = f.service.store;
  const agent = store.register({ name: 'Worker', kind: 'shell' });
  const before = fs.readFileSync(store.filename, 'utf8');
  for (const invalid of [
    { mentions: ['missing'] }, { mentions: [agent.id, agent.id] }, { mentions: 'user' },
    { requestTo: '' }, { taskId: 5 }, { body: '' }, { body: 'x'.repeat(16001) }
  ]) assert.throws(() => store.post({ from: agent.id, body: 'Test', ...invalid }));
  assert.equal(fs.readFileSync(store.filename, 'utf8'), before);
  const mentions = ['user'];
  const post = store.post({ from: agent.id, body: 'Notice', mentions });
  mentions.push('missing');
  assert.deepEqual(store.board()[0].mentions, ['user'], 'caller-owned arrays cannot change committed memory');
  assert.throws(() => store.acknowledge('user', post.id), /addressed/);
  const state = store.snapshot();
  state.posts[0].requestTo = 'missing';
  fs.writeFileSync(store.filename, JSON.stringify(state));
  const invalid = fs.readFileSync(store.filename, 'utf8');
  assert.throws(() => Store.readOnly(f.directory), /invalid notice board/);
  assert.equal(fs.readFileSync(store.filename, 'utf8'), invalid);
});
