'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { claudeEvent, applyClaudeEvent } = require('./claude');
const { codexEvent, applyCodexEvent } = require('./codex');
const { copilotEvent, applyCopilotEvent } = require('./copilot');
const { CURRENT_VERSION, migrate, validateTaskRecords } = require('./migrations');
const { assertNoSecrets, parseJSON } = require('./security');
const STATES = new Set(['working', 'idle', 'needs-input', 'needs-permission', 'finished', 'disconnected', 'unknown']);
const TASK_STATES = new Set(['backlog', 'in-progress', 'blocked', 'review', 'done']);
const copy = value => JSON.parse(JSON.stringify(value));
const TEMPORARY_STATE = /^state\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
function writerOperation(directory, operation) {
  const guard = path.join(directory, 'writer-operation.lock');
  try { fs.mkdirSync(guard, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A writer operation is in progress. Retry later. If writer-operation.lock persists after a crash, stop all Murmurplex windows and containers for this project before manually removing that empty directory.');
    throw error;
  }
  try { return operation(); }
  finally { fs.rmdirSync(guard); }
}
function sameLock(left, right) {
  return left && right && left.device === right.device && left.inode === right.inode && left.raw === right.raw;
}
const RETAINED_RESOLVED = 500;
// Drops only the oldest resolved records; unacknowledged messages are never removed.
function compact(state, keep) {
  let excess = state.messages.filter(m => m.acknowledgedAt).length - keep;
  if (excess > 0) state.messages = state.messages.filter(m => !(m.acknowledgedAt && excess-- > 0));
  if (state.decisions.length > keep) state.decisions = state.decisions.slice(-keep);
}
function text(value, name, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text of at most ${max} characters.`);
  return value;
}

class Store {
  constructor(directory, checkSecrets = assertNoSecrets, { retainResolved = RETAINED_RESOLVED } = {}) {
    this.directory = directory;
    this.retainResolved = retainResolved;
    this.checkSecrets = checkSecrets;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(directory, 'writer.lock');
    try {
      writerOperation(directory, () => {
        this.lockFd = fs.openSync(this.lock, 'wx', 0o600);
        try {
          fs.writeFileSync(this.lockFd, JSON.stringify({ id: randomUUID(), pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }) + '\n');
          this.owner = Store.lockOwner(directory);
        } catch (error) {
          fs.closeSync(this.lockFd); this.lockFd = undefined;
          fs.unlinkSync(this.lock);
          throw error;
        }
      });
    }
    catch (error) {
      if (error.code === 'EEXIST') {
        const owner = Store.lockOwner(directory);
        const detail = owner ? ` Lock held by ${owner.description}.` : '';
        throw Object.assign(new Error(`Another Murmurplex service owns this project, or a stale writer.lock remains.${detail} A lock is never reclaimed automatically; if you are sure no service is running, use "Murmurplex: Recover Stale Project Lock".`), { code: 'PROJECT_LOCKED' });
      }
      throw error;
    }
    try {
      this.filename = path.join(directory, 'state.json');
      // Holding the lock means no other writer exists, so leftovers are from an interrupted write.
      for (const name of fs.readdirSync(directory)) {
        if (TEMPORARY_STATE.test(name) && fs.lstatSync(path.join(directory, name)).isFile()) fs.unlinkSync(path.join(directory, name));
      }
      const loaded = Store.load(this.filename, checkSecrets);
      if (loaded === undefined) this.state = { version: CURRENT_VERSION, revision: 0, coordinatorId: null, agents: [], tasks: [], messages: [], decisions: [] };
      else {
        const { state, from, raw } = loaded;
        // Keep the pre-migration file once per source version; never overwrite an earlier backup.
        if (from !== CURRENT_VERSION) {
          try { fs.writeFileSync(`${this.filename}.v${from}.bak`, raw, { flag: 'wx', mode: 0o600 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        this.state = state;
      }
      // A restored project record does not prove the old process is still running.
      this.update(next => { for (const agent of next.agents) agent.status = 'disconnected'; });
    } catch (error) { this.close(); throw error; }
  }
  // Reads, validates and migrates in memory only; never writes, so it is safe without the writer lock.
  static load(filename, checkSecrets = assertNoSecrets) {
    let raw;
    try { raw = fs.readFileSync(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    const parsed = parseJSON(raw, 'Project state');
    checkSecrets(parsed);
    return { ...migrate(parsed, STATES), raw };
  }
  // A view for a window that does not own the project: it cannot update, lock, back up or migrate on disk.
  static readOnly(directory, checkSecrets = assertNoSecrets) {
    const filename = path.join(directory, 'state.json');
    let state;
    const reload = () => { const loaded = Store.load(filename, checkSecrets); state = loaded ? loaded.state : { version: CURRENT_VERSION, revision: 0, coordinatorId: null, agents: [], tasks: [], messages: [], decisions: [] }; };
    reload();
    return { readOnly: true, filename, reload, snapshot: () => copy(state) };
  }
  // Describes the lock holder without judging liveness: PIDs are reused and may belong to another container.
  static lockOwner(directory) {
    let fd, raw, stat;
    try {
      fd = fs.openSync(path.join(directory, 'writer.lock'), 'r');
      stat = fs.fstatSync(fd);
      raw = fs.readFileSync(fd, 'utf8');
    }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    let info = {};
    try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') info = parsed; else if (Number.isInteger(parsed)) info = { pid: parsed }; } catch { /* unreadable lock: report unknown owner */ }
    const pid = Number.isSafeInteger(info.pid) && info.pid > 0 ? info.pid : undefined;
    const hostname = typeof info.hostname === 'string' ? info.hostname : undefined;
    const startedAt = typeof info.startedAt === 'string' ? info.startedAt : undefined;
    const parts = [pid ? `process ${pid}` : 'an unknown process'];
    if (hostname) parts.push(`on ${hostname}`);
    if (startedAt) parts.push(`since ${startedAt}`);
    return { device: stat.dev, inode: stat.ino, raw, description: parts.join(' '), pid, hostname, startedAt };
  }
  // Explicit, user-confirmed recovery only; callers must not use this automatically.
  static breakLock(directory, expected) {
    writerOperation(directory, () => {
      if (!sameLock(expected, Store.lockOwner(directory))) throw new Error('The project lock changed since confirmation. Inspect the current owner and retry recovery.');
      fs.unlinkSync(path.join(directory, 'writer.lock'));
    });
  }
  snapshot() { return copy(this.state); }
  snapshotFor(agentId) {
    this.agent(agentId);
    const snapshot = this.snapshot();
    if (snapshot.coordinatorId !== agentId) snapshot.messages = snapshot.messages.filter(message => message.from === agentId || message.to === agentId);
    return snapshot;
  }
  update(fn) {
    const next = copy(this.state);
    const result = fn(next);
    compact(next, this.retainResolved);
    this.checkSecrets(next);
    next.revision++;
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      writerOperation(this.directory, () => {
        if (!sameLock(this.owner, Store.lockOwner(this.directory))) throw new Error('Project writer lock ownership was lost. Stop this service before recovering the project.');
        fs.renameSync(temporary, this.filename);
      });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.state = next;
    return copy(result === undefined ? next : result);
  }
  agent(id) {
    const agent = this.state.agents.find(a => a.id === id);
    if (!agent) throw new Error('Unknown agent.');
    return agent;
  }
  register(input) {
    text(input.name, 'name', 120); text(input.kind, 'kind', 40);
    if (!['claude', 'codex', 'copilot', 'shell'].includes(input.kind)) throw new Error('Unsupported agent kind.');
    return this.update(next => {
      const agent = { id: randomUUID(), name: input.name, kind: input.kind, status: 'unknown', attention: null, createdAt: new Date().toISOString() };
      next.agents.push(agent);
      if (!next.coordinatorId) next.coordinatorId = agent.id;
      return agent;
    });
  }
  status(id, status) {
    this.agent(id);
    if (!STATES.has(status)) throw new Error('Invalid agent status.');
    return this.update(next => {
      const agent = next.agents.find(a => a.id === id);
      agent.status = status;
      if (!['unknown', 'disconnected'].includes(status)) for (const key of ['claude', 'codex', 'copilot']) if (agent[key]) agent[key].requests = [];
      if (['needs-input', 'needs-permission'].includes(status)) agent.attention = status;
      else if (['working', 'idle', 'finished'].includes(status)) agent.attention = null;
      return agent;
    });
  }
  claudeHook(id, input) {
    if (this.agent(id).kind !== 'claude') throw new Error('Claude hooks require a Claude agent.');
    const event = claudeEvent(input);
    return this.update(next => {
      const agent = next.agents.find(a => a.id === id);
      applyClaudeEvent(agent, event);
      return agent;
    });
  }
  copilotHook(id, input) {
    if (this.agent(id).kind !== 'copilot') throw new Error('Copilot hooks require a Copilot agent.');
    const event = copilotEvent(input);
    return this.update(next => {
      const agent = next.agents.find(a => a.id === id);
      applyCopilotEvent(agent, event);
      return agent;
    });
  }
  codexHook(id, input) {
    if (this.agent(id).kind !== 'codex') throw new Error('Codex hooks require a Codex agent.');
    const event = codexEvent(input);
    return this.update(next => {
      const agent = next.agents.find(a => a.id === id);
      applyCodexEvent(agent, event);
      return agent;
    });
  }
  coordinator(id) {
    this.agent(id);
    return this.update(next => { next.coordinatorId = id; });
  }
  send(input) {
    if (input.from !== 'user') this.agent(input.from);
    this.agent(input.to); text(input.body, 'body');
    return this.update(next => {
      const message = { id: randomUUID(), from: input.from, to: input.to, body: input.body, createdAt: new Date().toISOString(), acknowledgedAt: null };
      next.messages.push(message); return message;
    });
  }
  inbox(id) { this.agent(id); return copy(this.state.messages.filter(m => m.to === id && !m.acknowledgedAt)); }
  acknowledge(agentId, messageId) {
    this.agent(agentId);
    return this.update(next => {
      const message = next.messages.find(m => m.id === messageId && m.to === agentId);
      if (!message) throw new Error('Message does not belong to this agent.');
      message.acknowledgedAt ||= new Date().toISOString(); return message;
    });
  }
  task(input) {
    text(input.title, 'title', 500);
    const status = input.status || 'backlog';
    if (!TASK_STATES.has(status)) throw new Error('Invalid task status.');
    if (input.ownerId) this.agent(input.ownerId);
    if (input.id && !this.state.tasks.some(t => t.id === input.id)) throw new Error('Unknown task.');
    const existing = input.id && this.state.tasks.find(task => task.id === input.id);
    const reference = (key, name, max) => {
      const value = input[key] === undefined ? existing?.[key] ?? null : input[key];
      return value === null ? null : text(value, name, max);
    };
    const branch = reference('branch', 'branch', 255);
    const worktreePath = reference('worktreePath', 'worktreePath', 4096);
    const priority = input.priority === undefined ? existing?.priority ?? 'normal' : input.priority;
    const acceptanceCriteria = input.acceptanceCriteria === undefined ? existing?.acceptanceCriteria ?? [] : input.acceptanceCriteria;
    const dependsOn = input.dependsOn === undefined ? existing?.dependsOn ?? [] : input.dependsOn;
    const progress = input.progress === undefined ? existing?.progress ?? '' : input.progress;
    const blocker = input.blocker === undefined ? existing?.blocker ?? null : input.blocker;
    if (branch !== null && branch !== branch.trim()) throw new Error('branch cannot have leading or trailing whitespace.');
    for (const [name, value] of [['branch', branch], ['worktreePath', worktreePath]]) {
      if (value !== null && /[\u0000-\u001f]/.test(value)) throw new Error(`${name} contains invalid control characters.`);
    }
    return this.update(next => {
      const task = input.id ? next.tasks.find(t => t.id === input.id) : {
        id: randomUUID(), priority: 'normal', acceptanceCriteria: [], dependsOn: [], progress: '', blocker: null
      };
      Object.assign(task, {
        title: input.title, status, ownerId: input.ownerId || null, branch, worktreePath,
        priority, acceptanceCriteria, dependsOn, progress, blocker, updatedAt: new Date().toISOString()
      });
      if (!input.id) next.tasks.push(task);
      validateTaskRecords(next.tasks, new Set(next.agents.map(agent => agent.id)));
      return task;
    });
  }
  decision(body) {
    text(body, 'body');
    return this.update(next => { const item = { id: randomUUID(), body, createdAt: new Date().toISOString() }; next.decisions.push(item); return item; });
  }
  close() {
    if (this.lockFd === undefined) return;
    try {
      writerOperation(this.directory, () => {
        if (!sameLock(this.owner, Store.lockOwner(this.directory))) throw new Error('Project writer lock ownership was lost; the current lock was not removed.');
        fs.unlinkSync(this.lock);
      });
    } finally { fs.closeSync(this.lockFd); this.lockFd = undefined; }
  }
}
module.exports = { Store, STATES };
