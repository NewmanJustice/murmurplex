'use strict';
const KINDS = ['claude', 'codex', 'copilot', 'shell'];
const PROVIDERS = ['claude', 'codex', 'copilot'];
const ATTENTION = [null, 'needs-input', 'needs-permission'];
const COLLECTIONS = ['agents', 'tasks', 'messages', 'decisions'];
const CURRENT_VERSION = 2;

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

// Each entry upgrades a state from version N to N + 1 and must be idempotent.
const MIGRATIONS = {
  // Version 1 gained provider lifecycle records (agent.claude/codex/copilot) without a version bump.
  // Version 2 makes them part of the schema: only on the matching agent kind, and well formed.
  1(state) {
    for (const agent of state.agents) {
      if (!isObject(agent)) continue;
      if (agent.attention === undefined) agent.attention = null;
      for (const provider of PROVIDERS) {
        if (agent[provider] === undefined) continue;
        if (agent.kind !== provider || !isObject(agent[provider])) { delete agent[provider]; continue; }
        const lifecycle = agent[provider];
        if (typeof lifecycle.sessionId !== 'string') lifecycle.sessionId = null;
        if (!Array.isArray(lifecycle.requests)) lifecycle.requests = [];
        if (provider !== 'copilot' && !Array.isArray(lifecycle.tools)) lifecycle.tools = [];
      }
    }
  }
};

function validate(state, states) {
  if (!isObject(state)) throw new Error('Project state must be an object.');
  for (const key of COLLECTIONS) if (!Array.isArray(state[key])) throw new Error(`Project state field ${key} must be a list.`);
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('Project state revision is invalid.');
  const ids = new Set();
  for (const agent of state.agents) {
    if (!isObject(agent) || typeof agent.id !== 'string' || !agent.id || ids.has(agent.id)) throw new Error('Project state has an invalid or duplicate agent.');
    ids.add(agent.id);
    if (typeof agent.name !== 'string' || !KINDS.includes(agent.kind) || !states.has(agent.status) || !ATTENTION.includes(agent.attention ?? null)) throw new Error(`Project state agent ${agent.id} is invalid.`);
  }
  if (state.coordinatorId !== null && !ids.has(state.coordinatorId)) throw new Error('Project state coordinator is not a known agent.');
}

// Returns the migrated state and the version it started from. Never mutates the input.
function migrate(input, states) {
  if (!isObject(input) || !Number.isInteger(input.version) || input.version < 1) throw new Error('Unsupported or invalid project state; original file has been preserved.');
  if (input.version > CURRENT_VERSION) throw new Error(`Project state version ${input.version} was written by a newer Murmurplex (this one supports up to ${CURRENT_VERSION}); original file has been preserved. Update Murmurplex.`);
  const state = JSON.parse(JSON.stringify(input));
  for (const key of COLLECTIONS) if (!Array.isArray(state[key])) throw new Error('Unsupported or invalid project state; original file has been preserved.');
  const from = state.version;
  while (state.version < CURRENT_VERSION) {
    MIGRATIONS[state.version](state);
    state.version++;
  }
  validate(state, states);
  return { state, from };
}

module.exports = { CURRENT_VERSION, migrate, validate };
