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
  const store = new Store(directory, text => assertNoSecrets(text, token => byDigest.has(digest(token))));
  let url;
  const credentialFile = agentId => path.join(credentialsDirectory, `${agentId}.json`);
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const header = req.headers.authorization || '';
    const caller = header.startsWith('Bearer ') ? byDigest.get(digest(header.slice(7))) : undefined;
    if (req.headers.origin || !caller) return respond(401, { error: 'Unauthorized' });
    let payload = '';
    try {
      for await (const chunk of req) {
        payload += chunk;
        if (Buffer.byteLength(payload) > 65536) return respond(413, { error: 'Request too large' });
      }
      const body = payload ? parseJSON(payload, 'Request body') : {};
      const route = new URL(req.url, 'http://127.0.0.1');
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
      if (req.method === 'GET' && route.pathname === '/inbox') return respond(200, store.inbox(own(route.searchParams.get('agentId') || undefined, 'agentId')));
      if (req.method !== 'POST') return respond(404, { error: 'Unknown endpoint' });
      switch (route.pathname) {
        case '/agents':
        case '/coordinator': throw new ForbiddenError('Only the user can manage agents and coordinator selection through VS Code.');
        case '/status': result = store.status(own(body.agentId, 'agentId'), body.status); break;
        case '/hooks/claude': result = store.claudeHook(own(body.agentId, 'agentId'), body.event); break;
        case '/hooks/codex': result = store.codexHook(own(body.agentId, 'agentId'), body.event); break;
        case '/hooks/copilot': result = store.copilotHook(own(body.agentId, 'agentId'), body.event); break;
        case '/messages': result = store.send({ ...body, from: own(body.from, 'from') }); break;
        case '/ack': result = store.acknowledge(own(body.agentId, 'agentId'), body.messageId); break;
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
    // Remove credentials left in the checkout by older releases.
    fs.rmSync(path.join(directory, 'credentials'), { recursive: true, force: true });
    fs.rmSync(path.join(directory, 'runtime.json'), { force: true });
    fs.rmSync(credentialsDirectory, { recursive: true, force: true });
    fs.mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
    return {
      url, store,
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
