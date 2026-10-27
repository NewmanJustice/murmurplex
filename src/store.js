'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { claudeEvent, applyClaudeEvent } = require('./claude');
const { copilotEvent, applyCopilotEvent } = require('./copilot');
const STATES = new Set(['working', 'idle', 'needs-input', 'needs-permission', 'finished', 'disconnected', 'unknown']);
const TASK_STATES = new Set(['backlog', 'in-progress', 'blocked', 'review', 'done']);
const copy = value => JSON.parse(JSON.stringify(value));
function text(value, name, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty text of at most ${max} characters.`);
  return value;
}

class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(directory, 'writer.lock');
    try { this.lockFd = fs.openSync(this.lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another Murmurplex service owns this project, or a stale writer.lock remains. Stop the owner before removing a stale lock.');
      throw error;
    }
    try {
      fs.writeFileSync(this.lockFd, `${process.pid}\n`);
      this.filename = path.join(directory, 'state.json');
      try { this.state = JSON.parse(fs.readFileSync(this.filename, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.state = { version: 1, revision: 0, coordinatorId: null, agents: [], tasks: [], messages: [], decisions: [] };
      }
      if (this.state.version !== 1 || !['agents', 'tasks', 'messages', 'decisions'].every(key => Array.isArray(this.state[key]))) throw new Error('Unsupported or invalid project state; original file has been preserved.');
      // A restored project record does not prove the old process is still running.
      this.update(next => { for (const agent of next.agents) agent.status = 'disconnected'; });
    } catch (error) { this.close(); throw error; }
  }
  snapshot() { return copy(this.state); }
  update(fn) {
    const next = copy(this.state);
    const result = fn(next);
    next.revision++;
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.filename);
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
      if (!['unknown', 'disconnected'].includes(status)) for (const key of ['claude', 'copilot']) if (agent[key]) agent[key].requests = [];
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
    return this.update(next => {
      const task = input.id ? next.tasks.find(t => t.id === input.id) : { id: randomUUID() };
      Object.assign(task, { title: input.title, status, ownerId: input.ownerId || null, updatedAt: new Date().toISOString() });
      if (!input.id) next.tasks.push(task);
      return task;
    });
  }
  decision(body) {
    text(body, 'body');
    return this.update(next => { const item = { id: randomUUID(), body, createdAt: new Date().toISOString() }; next.decisions.push(item); return item; });
  }
  close() {
    if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); this.lockFd = undefined; fs.unlinkSync(this.lock); }
  }
}
module.exports = { Store, STATES };
