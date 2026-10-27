'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { Store } = require('./store');

async function startService(directory, onChange = () => {}) {
  const store = new Store(directory);
  const token = randomBytes(32).toString('hex');
  const runtimePath = path.join(directory, 'runtime.json');
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return respond(401, { error: 'Unauthorized' });
    let payload = '';
    try {
      for await (const chunk of req) {
        payload += chunk;
        if (Buffer.byteLength(payload) > 65536) return respond(413, { error: 'Request too large' });
      }
      const body = payload ? JSON.parse(payload) : {};
      const url = new URL(req.url, 'http://127.0.0.1');
      let result;
      if (req.method === 'GET' && url.pathname === '/state') return respond(200, store.snapshot());
      if (req.method === 'GET' && url.pathname === '/inbox') return respond(200, store.inbox(url.searchParams.get('agentId')));
      if (req.method !== 'POST') return respond(404, { error: 'Unknown endpoint' });
      switch (url.pathname) {
        case '/agents': result = store.register(body); break;
        case '/status': result = store.status(body.agentId, body.status); break;
        case '/hooks/claude': result = store.claudeHook(body.agentId, body.event); break;
        case '/hooks/codex': result = store.codexHook(body.agentId, body.event); break;
        case '/hooks/copilot': result = store.copilotHook(body.agentId, body.event); break;
        case '/coordinator': result = store.coordinator(body.agentId); break;
        case '/messages': result = store.send(body); break;
        case '/ack': result = store.acknowledge(body.agentId, body.messageId); break;
        case '/tasks': result = store.task(body); break;
        case '/decisions': result = store.decision(body.body); break;
        default: return respond(404, { error: 'Unknown endpoint' });
      }
      // UI notifications must never turn a committed write into an apparent failure.
      try { onChange(store.snapshot()); } catch { /* State remains authoritative. */ }
      respond(200, result);
    } catch (error) { respond(400, { error: error.message }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(runtimePath, JSON.stringify({ url, token, pid: process.pid }), { mode: 0o600 });
    return {
      url, token, store,
      async close() {
        server.closeIdleConnections();
        await new Promise(resolve => server.close(resolve));
        try { fs.unlinkSync(runtimePath); } finally { store.close(); }
      }
    };
  } catch (error) { server.close(); store.close(); throw error; }
}
module.exports = { startService };
