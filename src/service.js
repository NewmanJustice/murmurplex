'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { Store } = require('./store');
const { assertNoSecrets, redact, parseJSON } = require('./security');

class ForbiddenError extends Error {}
const digest = token => createHash('sha256').update(token).digest('hex');

async function startService(directory, credentialsDirectory, onChange = () => {}) {
  if (!path.isAbsolute(credentialsDirectory)) throw new Error('An absolute private credential directory is required.');
  const byDigest = new Map();
  const digestByAgent = new Map();
  const browserToken = randomBytes(32).toString('hex');
  const browserDigest = digest(browserToken);
  const assets = new Map([
    ['/', ['board.html', 'text/html; charset=utf-8']],
    ['/board-client.js', ['board-client.js', 'text/javascript; charset=utf-8']],
    ['/board.css', ['board.css', 'text/css; charset=utf-8']]
  ]);
  const assetContents = new Map([...assets].map(([route, [file, type]]) => [route, { type, body: fs.readFileSync(path.join(__dirname, '../web', file)) }]));
  const store = new Store(directory, text => assertNoSecrets(text, token => byDigest.has(digest(token)) || digest(token) === browserDigest));
  const browserOrigins = new Set();
  let url;
  const credentialFile = agentId => path.join(credentialsDirectory, `${agentId}.json`);
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    // Exact Host validation also blocks DNS-rebinding access to loopback services.
    const permittedHosts = [new URL(url).host, ...[...browserOrigins].map(origin => new URL(origin).host)];
    if (!permittedHosts.includes(req.headers.host)) return respond(403, { error: 'Invalid host.' });
    const route = new URL(req.url, url);
    if (req.method === 'GET' && assetContents.has(route.pathname)) {
      const asset = assetContents.get(route.pathname);
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
      res.end(asset.body); return;
    }
    const header = req.headers.authorization || '';
    const tokenDigest = header.startsWith('Bearer ') ? digest(header.slice(7)) : undefined;
    const human = tokenDigest === browserDigest;
    const caller = human ? 'user' : byDigest.get(tokenDigest);
    if (!caller || (req.headers.origin && (!human || !browserOrigins.has(req.headers.origin)))
      || (human && !['/board', '/board/ack', '/board/archive'].includes(route.pathname))) {
      return respond(401, { error: 'Unauthorized' });
    }
    let payload = '';
    try {
      for await (const chunk of req) {
        payload += chunk;
        if (Buffer.byteLength(payload) > 65536) return respond(413, { error: 'Request too large' });
      }
      const body = payload ? parseJSON(payload, 'Request body') : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be an object.');
      // An agent acts only as itself: a claimed identity must match its credential.
      const own = (claimed, name) => {
        if (claimed !== undefined && claimed !== null && claimed !== caller) throw new ForbiddenError(`${name} must be the calling agent.`);
        return caller;
      };
      const requireCoordinator = () => {
        if (store.snapshot().coordinatorId !== caller) throw new ForbiddenError('Only the coordinator can perform this operation.');
      };
      let result;
      if (req.method === 'GET' && route.pathname === '/state') return respond(200, store.snapshotFor(caller));
      if (req.method === 'GET' && route.pathname === '/board') {
        const snapshot = store.snapshot();
        return respond(200, { revision: snapshot.revision, agents: snapshot.agents.map(({ id, name }) => ({ id, name })), tasks: snapshot.tasks.map(({ id, title }) => ({ id, title })), posts: snapshot.posts });
      }
      if (req.method === 'GET' && route.pathname === '/board/archive') {
        if (!human) throw new ForbiddenError('The legacy archive is human-only.');
        return respond(200, store.snapshot().legacyMessages);
      }
      if (req.method !== 'POST') return respond(404, { error: 'Unknown endpoint' });
      switch (route.pathname) {
        case '/agents':
        case '/coordinator': throw new ForbiddenError('Only the user can manage agents and coordinator selection through VS Code.');
        case '/status': result = store.status(own(body.agentId, 'agentId'), body.status); break;
        case '/hooks/claude': result = store.claudeHook(own(body.agentId, 'agentId'), body.event); break;
        case '/hooks/codex': result = store.codexHook(own(body.agentId, 'agentId'), body.event); break;
        case '/hooks/copilot': result = store.copilotHook(own(body.agentId, 'agentId'), body.event); break;
        case '/board':
          if (Object.hasOwn(body, 'to')) throw new Error('The board is shared; private recipient fields are not supported. Use requestTo for a public request.');
          result = store.post({ ...body, from: own(body.from, 'from') }); break;
        case '/board/ack': result = store.acknowledge(own(body.agentId, 'agentId'), body.postId); break;
        case '/tasks': {
          if (store.snapshot().coordinatorId === caller) result = store.task(body);
          else {
            const task = store.snapshot().tasks.find(task => task.id === body.id);
            if (!task || task.ownerId !== caller || (body.ownerId !== undefined && body.ownerId !== caller)) {
              throw new ForbiddenError('Workers can update only tasks assigned to themselves and cannot reassign them.');
            }
            if (['priority', 'acceptanceCriteria', 'dependsOn'].some(field => Object.hasOwn(body, field))) {
              throw new ForbiddenError('Only the coordinator can change task priority, acceptance criteria or dependencies.');
            }
            result = store.task({ ...task, ...body, ownerId: caller });
          }
          break;
        }
        case '/decisions': requireCoordinator(); result = store.decision(body.body); break;
        default: return respond(404, { error: 'Unknown endpoint' });
      }
      // UI notifications must never turn a committed write into an apparent failure.
      try { onChange(store.snapshot()); } catch { /* State remains authoritative. */ }
      respond(200, result);
    } catch (error) { respond(error instanceof ForbiddenError ? 403 : 400, { error: redact(error.message) }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
    browserOrigins.add(url);
    // Remove credentials left in the checkout by older releases.
    fs.rmSync(path.join(directory, 'credentials'), { recursive: true, force: true });
    fs.rmSync(path.join(directory, 'runtime.json'), { force: true });
    fs.rmSync(credentialsDirectory, { recursive: true, force: true });
    fs.mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
    return {
      url, store,
      boardUrl: () => `${url}/#token=${browserToken}`,
      allowBoardOrigin(origin) {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
          throw new Error('The notice board requires a private localhost HTTP forward, not a public tunnel.');
        }
        browserOrigins.add(parsed.origin);
      },
      // Issues a fresh credential for the agent, revoking any earlier one. The helper reads the
      // file on every call, so rotation and service restarts need no change to a running terminal.
      issueCredential(agentId) {
        store.agent(agentId);
        const token = randomBytes(32).toString('hex');
        const file = credentialFile(agentId);
        const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ url, token }), { mode: 0o600 });
        fs.renameSync(temporary, file);
        const previous = digestByAgent.get(agentId);
        if (previous) byDigest.delete(previous);
        byDigest.set(digest(token), agentId);
        digestByAgent.set(agentId, digest(token));
        return { file };
      },
      revokeCredential(agentId) {
        const previous = digestByAgent.get(agentId);
        if (previous) byDigest.delete(previous);
        digestByAgent.delete(agentId);
        fs.rmSync(credentialFile(agentId), { force: true });
      },
      credentialFile,
      async close() {
        server.closeIdleConnections();
        await new Promise(resolve => server.close(resolve));
        byDigest.clear(); digestByAgent.clear();
        try { fs.rmSync(credentialsDirectory, { recursive: true, force: true }); } finally { store.close(); }
      }
    };
  } catch (error) { server.close(); store.close(); throw error; }
}
module.exports = { startService };
