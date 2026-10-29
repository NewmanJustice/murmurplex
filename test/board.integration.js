'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { startService } = require('../src/service');

test('localhost browser board posts as the user, refreshes, acknowledges requests and renders text safely', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-browser-'));
  const service = await startService(path.join(root, 'project'), path.join(root, 'credentials'));
  let browser;
  t.after(async () => {
    if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      await exited;
    }
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const agent = service.store.register({ name: 'Worker', kind: 'shell' });
  const task = service.store.task({ title: 'Review browser board', ownerId: agent.id });
  service.store.update(next => {
    next.legacyMessages.push({
      id: 'legacy', from: 'user', to: agent.id, body: 'Private historical note',
      taskId: null, createdAt: '2026-10-29T10:00:00Z', acknowledgedAt: null
    });
  });
  const incoming = service.store.post({ from: agent.id, body: '<img src=x onerror="window.injected=true">', requestTo: 'user', taskId: task.id });
  browser = spawn(process.env.CHROMIUM_CLI || 'chromium', [
    '--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-pipe', `--user-data-dir=${path.join(root, 'profile')}`,
    ...(process.env.CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean), 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  browser.stderr.on('data', chunk => { diagnostics += chunk; });
  const pending = new Map();
  let browserFailure;
  let sequence = 0;
  let buffer = '';
  const fail = error => {
    browserFailure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  browser.on('error', fail);
  browser.on('exit', () => fail(new Error(`Chromium exited: ${diagnostics}`)));
  browser.stdio[3].on('error', fail);
  browser.stdio[4].on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const value = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(value.id);
      if (request) {
        pending.delete(value.id);
        if (value.error) request.reject(new Error(JSON.stringify(value.error)));
        else request.resolve(value.result);
      }
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (browserFailure) { reject(browserFailure); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const wait = async expression => {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Browser condition timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
  };
  await call('Page.navigate', { url: service.boardUrl() }, sessionId);
  await wait("document.getElementById('connection')?.textContent.startsWith('Connected')");
  assert.equal(await evaluate('location.hash'), '', 'credential removed from the visible URL');
  assert.equal(await evaluate("document.querySelectorAll('#posts img').length"), 0);
  assert.equal(await evaluate('window.injected === undefined'), true);
  assert.match(await evaluate("document.getElementById('posts').textContent"), /<img src=x/);
  assert.doesNotMatch(await evaluate("document.getElementById('posts').textContent"), /Private historical note/);
  await evaluate("document.getElementById('legacy').open = true");
  await wait("document.getElementById('archive').textContent.includes('Private historical note')");
  await evaluate("document.querySelector('#posts button').click()");
  await wait("!document.querySelector('#posts button')");
  assert.ok(service.store.board().find(post => post.id === incoming.id).acknowledgedAt);
  await evaluate(`document.getElementById('body').value = 'Human request';
    document.getElementById('task').value = ${JSON.stringify(task.id)};
    document.getElementById('request').value = ${JSON.stringify(agent.id)};
    document.getElementById('mentions').options[1].selected = true;
    document.getElementById('compose').requestSubmit();`);
  await wait("document.querySelectorAll('#posts article').length === 2");
  const human = service.store.board()[1];
  assert.equal(human.from, 'user');
  assert.equal(human.taskId, task.id);
  assert.equal(human.requestTo, agent.id);
  assert.deepEqual(human.mentions, [agent.id]);
  // A concurrent agent post updates the feed without erasing a human's draft.
  await evaluate("document.getElementById('body').value = 'Unsaved draft'");
  service.store.post({ from: agent.id, body: 'Agent update' });
  await wait("document.querySelectorAll('#posts article').length === 3");
  assert.equal(await evaluate("document.getElementById('body').value"), 'Unsaved draft');
  assert.deepEqual(service.store.snapshot().tasks[0], task);
  // Model the differing browser/container origins with an actual loopback reverse proxy.
  const proxy = http.createServer((request, response) => {
    const upstream = http.request(service.url + request.url, {
      method: request.method, headers: request.headers
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeIdleConnections(); proxy.close(resolve); }));
  const forwarded = `http://127.0.0.1:${proxy.address().port}`;
  service.allowBoardOrigin(forwarded);
  await call('Page.navigate', { url: forwarded + '/' + new URL(service.boardUrl()).hash }, sessionId);
  await wait("document.getElementById('connection')?.textContent.startsWith('Connected')");
  await evaluate("document.getElementById('body').value = 'Posted through local forward'; document.getElementById('compose').requestSubmit()");
  await wait("document.querySelectorAll('#posts article').length === 4");
  assert.equal(service.store.board()[3].from, 'user');
  await call('Target.closeTarget', { targetId });
});
