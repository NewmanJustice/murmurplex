'use strict';
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'Stop', 'SessionEnd', 'ErrorOccurred'
];
// PascalCase PreToolUse reports Copilot's ask_user tool under its Claude name.
const QUESTION_TOOL = 'AskUserQuestion';

function copilotEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !EVENTS.includes(input.hook_event_name)) throw new Error('Unsupported Copilot hook event.');
  const event = { hook_event_name: input.hook_event_name };
  for (const key of ['session_id', 'agent_id', 'tool_name']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 500) throw new Error(`Invalid Copilot ${key}.`);
      event[key] = input[key];
    }
  }
  if (!event.session_id) throw new Error('Copilot hook requires session_id.');
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name) && !event.tool_name) throw new Error('Copilot tool hook requires tool_name.');
  if (event.hook_event_name === 'ErrorOccurred') {
    if (typeof input.recoverable !== 'boolean') throw new Error('Copilot error hook requires recoverable.');
    event.recoverable = input.recoverable;
  }
  return event;
}

function applyCopilotEvent(agent, event) {
  const lifecycle = agent.copilot ||= { sessionId: null, requests: [] };
  const main = !event.agent_id;
  if (!(main && event.hook_event_name === 'SessionStart') && lifecycle.sessionId && lifecycle.sessionId !== event.session_id) throw new Error('Copilot hook belongs to an inactive conversation.');
  for (const request of lifecycle.requests) request.sessionId ??= lifecycle.sessionId;
  const scope = event.agent_id || '';
  const sameScope = item => item.sessionId === event.session_id && item.scope === scope;
  let status;
  let resolved = false;
  switch (event.hook_event_name) {
    case 'SessionStart':
      if (!main) return;
      lifecycle.sessionId = event.session_id;
      status = 'unknown';
      break;
    case 'UserPromptSubmit':
      if (main) status = 'working';
      break;
    case 'PreToolUse':
      if (event.tool_name === QUESTION_TOOL) {
        if (!lifecycle.requests.some(sameScope)) lifecycle.requests.push({ sessionId: event.session_id, scope, attention: 'needs-input' });
        status = 'needs-input';
      } else if (main) status = 'working';
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (event.tool_name === QUESTION_TOOL) {
        const before = lifecycle.requests.length;
        lifecycle.requests = lifecycle.requests.filter(item => !sameScope(item));
        resolved = before !== lifecycle.requests.length;
      }
      if (main || resolved) status = 'working';
      break;
    case 'Stop':
      if (main) status = 'finished';
      break;
    case 'ErrorOccurred':
      if (main && !event.recoverable) status = 'unknown';
      break;
    case 'SessionEnd':
      if (main && lifecycle.sessionId === event.session_id) status = 'disconnected';
      break;
  }
  if (lifecycle.requests.length) agent.attention = 'needs-input';
  else if (resolved) agent.attention = null;
  if (status) agent.status = status;
  if (agent.attention && !['unknown', 'disconnected'].includes(agent.status)) agent.status = agent.attention;
}

module.exports = { copilotEvent, applyCopilotEvent };
