'use strict';
// Codex hook trust is recorded against a hash of the exact definition. Keep these
// definitions free of per-launch or per-install values so one trust survives launches.
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'SubagentStop', 'Interrupt', 'Stop', 'SessionEnd'
];
// Codex limits these two events to a three second timeout.
const SHORT_TIMEOUT = new Set(['Interrupt', 'SessionEnd']);
const COMMAND = 'murmurplex-agent codex-hook';

function codexConfigArgs() {
  return EVENTS.flatMap(event => ['-c', `hooks.${event}=[{hooks=[{type="command",command="${COMMAND}",timeout=${SHORT_TIMEOUT.has(event) ? 3 : 6}}]}]`]);
}

function codexEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !EVENTS.includes(input.hook_event_name)) throw new Error('Unsupported Codex hook event.');
  const event = { hook_event_name: input.hook_event_name };
  for (const key of ['session_id', 'agent_id', 'tool_name', 'tool_use_id']) {
    if (input[key] !== undefined && input[key] !== null) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 500) throw new Error(`Invalid Codex ${key}.`);
      event[key] = input[key];
    }
  }
  if (!event.session_id) throw new Error('Codex hook requires session_id.');
  if (['PreToolUse', 'PermissionRequest', 'PostToolUse'].includes(event.hook_event_name) && !event.tool_name) throw new Error('Codex tool hook requires tool_name.');
  if (['PreToolUse', 'PostToolUse'].includes(event.hook_event_name) && !event.tool_use_id) throw new Error('Codex tool hook requires tool_use_id.');
  if (event.hook_event_name === 'SubagentStop' && !event.agent_id) throw new Error('Codex SubagentStop requires agent_id.');
  return event;
}

function applyCodexEvent(agent, event) {
  const lifecycle = agent.codex ||= { sessionId: null, tools: [], requests: [] };
  const main = !event.agent_id;
  if (!(main && event.hook_event_name === 'SessionStart') && lifecycle.sessionId && lifecycle.sessionId !== event.session_id) throw new Error('Codex hook belongs to an inactive conversation.');
  const scope = event.agent_id || '';
  const sameScope = item => item.sessionId === event.session_id && item.scope === scope;
  const tool = { sessionId: event.session_id, scope, name: event.tool_name, id: event.tool_use_id };
  let status;
  let resolved = false;
  switch (event.hook_event_name) {
    case 'SessionStart':
      if (!main) return;
      lifecycle.sessionId = event.session_id;
      lifecycle.tools = [];
      status = 'unknown';
      break;
    case 'UserPromptSubmit':
      if (main) status = 'working';
      break;
    case 'PreToolUse':
      if (!lifecycle.tools.some(item => sameScope(item) && item.id === tool.id)) lifecycle.tools.push(tool);
      if (main) status = 'working';
      break;
    case 'PermissionRequest': {
      // The event carries no tool_use_id: wait for every in-flight call of that tool.
      const candidates = lifecycle.tools.filter(item => sameScope(item) && item.name === tool.name).map(item => item.id);
      lifecycle.requests.push({ ...tool, attention: 'needs-permission', candidates });
      status = 'needs-permission';
      break;
    }
    case 'PostToolUse': {
      lifecycle.tools = lifecycle.tools.filter(item => !sameScope(item) || item.id !== tool.id);
      const before = lifecycle.requests.length;
      lifecycle.requests = lifecycle.requests.filter(item => {
        if (!sameScope(item) || item.name !== tool.name) return true;
        if (!item.candidates.length) return false;
        item.candidates = item.candidates.filter(id => id !== tool.id);
        return item.candidates.length > 0;
      });
      resolved = before !== lifecycle.requests.length;
      if (main || resolved) status = 'working';
      break;
    }
    case 'SubagentStop': {
      lifecycle.tools = lifecycle.tools.filter(item => !sameScope(item));
      const before = lifecycle.requests.length;
      lifecycle.requests = lifecycle.requests.filter(item => !sameScope(item));
      resolved = before !== lifecycle.requests.length;
      if (resolved) status = 'working';
      break;
    }
    case 'Interrupt':
      // An interrupt cancels the whole turn, including any approval prompt.
      lifecycle.tools = [];
      lifecycle.requests = [];
      resolved = true;
      status = 'idle';
      break;
    case 'Stop':
      if (main) status = 'finished';
      break;
    case 'SessionEnd':
      if (main && lifecycle.sessionId === event.session_id) status = 'disconnected';
      break;
  }
  const attention = lifecycle.requests.length ? 'needs-permission' : null;
  if (attention) agent.attention = attention;
  else if (resolved) agent.attention = null;
  if (status) agent.status = status;
  if (agent.attention && !['unknown', 'disconnected'].includes(agent.status)) agent.status = agent.attention;
}

module.exports = { codexConfigArgs, codexEvent, applyCodexEvent, COMMAND };
