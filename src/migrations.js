'use strict';
const KINDS = ['claude', 'codex', 'copilot', 'shell'];
const PROVIDERS = ['claude', 'codex', 'copilot'];
const ATTENTION = [null, 'needs-input', 'needs-permission'];
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const COLLECTIONS = ['agents', 'tasks', 'messages', 'decisions'];
const CURRENT_VERSION = 6;

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
  },
  2(state) {
    for (const task of state.tasks) {
      if (!isObject(task)) continue;
      if (task.branch === undefined) task.branch = null;
      if (task.worktreePath === undefined) task.worktreePath = null;
    }
  },
  3(state) {
    for (const task of state.tasks) {
      if (!isObject(task)) continue;
      if (task.ownerId === undefined) task.ownerId = null;
      if (task.priority === undefined) task.priority = 'normal';
      if (task.acceptanceCriteria === undefined) task.acceptanceCriteria = [];
      if (task.dependsOn === undefined) task.dependsOn = [];
      if (task.progress === undefined) task.progress = '';
      if (task.blocker === undefined) task.blocker = null;
    }
  },
  4(state) {
    for (const task of state.tasks) {
      if (!isObject(task)) continue;
      if (task.nextAction === undefined) task.nextAction = '';
    }
  },
  5(state) {
    for (const message of state.messages) {
      if (!isObject(message)) continue;
      if (message.taskId === undefined) message.taskId = null;
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
  validateTaskRecords(state.tasks, ids);
  const taskIds = new Set(state.tasks.map(task => task.id));
  for (const message of state.messages) {
    if (!isObject(message)) throw new Error('Project state has an invalid message.');
    validateMessageTask(message.taskId, taskIds);
  }
  if (state.coordinatorId !== null && !ids.has(state.coordinatorId)) throw new Error('Project state coordinator is not a known agent.');
}

function validateMessageTask(taskId, taskIds) {
  if (taskId !== null && (typeof taskId !== 'string' || !taskIds.has(taskId))) {
    throw new Error('Message taskId must be null or an existing task ID.');
  }
}

function validateTaskRecords(tasks, agentIds) {
  const taskIds = new Set();
  for (const task of tasks) {
    if (!isObject(task) || typeof task.id !== 'string' || !task.id) throw new Error('Project state has an invalid task.');
    if (taskIds.has(task.id)) throw new Error(`Project state has duplicate task ${task.id}.`);
    taskIds.add(task.id);
  }
  for (const task of tasks) {
    if (task.branch !== null && (typeof task.branch !== 'string' || !task.branch.trim() || task.branch !== task.branch.trim() || task.branch.length > 255 || /[\u0000-\u001f]/.test(task.branch))) {
      throw new Error(`Project state task ${task.id} has an invalid branch reference.`);
    }
    if (task.worktreePath !== null && (typeof task.worktreePath !== 'string' || !task.worktreePath.trim() || task.worktreePath.length > 4096 || /[\u0000-\u001f]/.test(task.worktreePath))) {
      throw new Error(`Project state task ${task.id} has an invalid worktree path.`);
    }
    if (!TASK_PRIORITIES.includes(task.priority)) throw new Error(`Project state task ${task.id} has an invalid priority.`);
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length > 50
      || task.acceptanceCriteria.some(criterion => typeof criterion !== 'string' || !criterion.trim() || criterion.length > 1000)) {
      throw new Error(`Project state task ${task.id} has invalid acceptance criteria.`);
    }
    if (typeof task.progress !== 'string' || task.progress.length > 4000) throw new Error(`Project state task ${task.id} has invalid progress.`);
    if (typeof task.nextAction !== 'string' || task.nextAction.length > 4000) throw new Error(`Project state task ${task.id} has an invalid next action.`);
    if (task.blocker !== null && (typeof task.blocker !== 'string' || !task.blocker.trim() || task.blocker.length > 2000)) {
      throw new Error(`Project state task ${task.id} has an invalid blocker.`);
    }
    if (!Array.isArray(task.dependsOn) || task.dependsOn.length > 100
      || task.dependsOn.some(id => typeof id !== 'string' || !id || id === task.id || !taskIds.has(id))
      || new Set(task.dependsOn).size !== task.dependsOn.length) {
      throw new Error(`Project state task ${task.id} has invalid dependencies.`);
    }
    if (task.ownerId !== null && (typeof task.ownerId !== 'string' || !agentIds.has(task.ownerId))) {
      throw new Error(`Project state task ${task.id} has an invalid owner.`);
    }
  }
  const byId = new Map(tasks.map(task => [task.id, task]));
  const dependents = new Map([...taskIds].map(id => [id, []]));
  const remaining = new Map();
  for (const task of tasks) {
    remaining.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency).push(task.id);
  }
  const ready = [...taskIds].filter(id => remaining.get(id) === 0);
  let processed = 0;
  while (ready.length) {
    const id = ready.pop();
    processed++;
    for (const dependent of dependents.get(id)) {
      remaining.set(dependent, remaining.get(dependent) - 1);
      if (remaining.get(dependent) === 0) ready.push(dependent);
    }
  }
  if (processed !== taskIds.size) throw new Error('Project state task dependencies contain a cycle.');
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

module.exports = { CURRENT_VERSION, migrate, validate, validateTaskRecords, validateMessageTask };
