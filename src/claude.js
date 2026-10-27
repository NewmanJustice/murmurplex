'use strict';
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd'
];

function claudeSettings(helperPath) {
  return {
    hooks: Object.fromEntries(EVENTS.map(event => [event, [{
      hooks: [{ type: 'command', command: 'node', args: [helperPath, 'claude-hook'], timeout: 6 }]
    }]]))
  };
}

function claudeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !EVENTS.includes(input.hook_event_name)) throw new Error('Unsupported Claude hook event.');
  const event = { hook_event_name: input.hook_event_name };
  for (const key of ['session_id', 'agent_id', 'tool_name', 'tool_use_id']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 500) throw new Error(`Invalid Claude ${key}.`);
      event[key] = input[key];
    }
  }
  if (!event.session_id) throw new Error('Claude hook requires session_id.');
  if (['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name) && !event.tool_name) throw new Error('Claude tool hook requires tool_name.');
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name) && !event.tool_use_id) throw new Error('Claude tool hook requires tool_use_id.');
  if (event.hook_event_name === 'Stop') {
    for (const key of ['background_tasks', 'session_crons']) {
      if (input[key] !== undefined && !Array.isArray(input[key])) throw new Error(`Invalid Claude ${key}.`);
    }
    event.background_tasks = input.background_tasks?.length ? [{}] : [];
    event.session_crons = input.session_crons?.length ? [{}] : [];
  }
  return event;
}

function applyClaudeEvent(agent, event) {
  const lifecycle = agent.claude ||= { sessionId: null, tools: [], requests: [] };
  const main = !event.agent_id;
  if (!(main && event.hook_event_name === 'SessionStart') && lifecycle.sessionId && lifecycle.sessionId !== event.session_id) throw new Error('Claude hook belongs to an inactive conversation.');
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
      if (tool.name === 'AskUserQuestion' && !lifecycle.requests.some(item => sameScope(item) && item.id === tool.id)) {
        lifecycle.requests.push({ ...tool, attention: 'needs-input' });
        status = 'needs-input';
      }
      if (main && !status) status = 'working';
      break;
    case 'PermissionRequest': {
      // This event has no tool_use_id. Wait for every possible matching call,
      // so an unrelated parallel call cannot clear the permission indicator.
      const candidates = lifecycle.tools.filter(item => sameScope(item) && item.name === tool.name).map(item => item.id);
      lifecycle.requests.push({ ...tool, attention: 'needs-permission', candidates });
      status = 'needs-permission';
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      lifecycle.tools = lifecycle.tools.filter(item => !sameScope(item) || item.id !== tool.id);
      const before = lifecycle.requests.length;
      lifecycle.requests = lifecycle.requests.filter(item => {
        if (!sameScope(item)) return true;
        if (item.attention === 'needs-input') return item.id !== tool.id;
        if (item.name !== tool.name || !item.candidates.includes(tool.id)) return true;
        item.candidates = item.candidates.filter(id => id !== tool.id);
        return item.candidates.length > 0;
      });
      resolved = before !== lifecycle.requests.length;
      if (main || resolved) status = 'working';
      break;
    }
    case 'Stop':
      if (main) status = event.background_tasks.length || event.session_crons.length ? 'idle' : 'finished';
      break;
    case 'StopFailure':
      if (main) status = 'unknown';
      break;
    case 'SessionEnd':
      if (main && lifecycle.sessionId === event.session_id) status = 'disconnected';
      break;
  }
  const attention = lifecycle.requests.some(item => item.attention === 'needs-permission') ? 'needs-permission'
    : lifecycle.requests.length ? 'needs-input' : null;
  if (attention) agent.attention = attention;
  else if (resolved) agent.attention = null;
  if (status) agent.status = status;
  if (agent.attention && !['unknown', 'disconnected'].includes(agent.status)) agent.status = agent.attention;
}

module.exports = { claudeSettings, claudeEvent, applyClaudeEvent };
