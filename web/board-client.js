'use strict';
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
const element = id => document.getElementById(id);
let revision = -1;
let snapshot;
let stopped = false;

async function api(route, body) {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) stopped = true;
    throw new Error(value.error || 'Board request failed.');
  }
  return value;
}

function options(id, values, placeholder) {
  const select = element(id);
  const selected = new Set([...select.selectedOptions].map(option => option.value));
  select.replaceChildren();
  if (placeholder) select.add(new Option(placeholder, ''));
  for (const [value, label] of values) {
    const option = new Option(label, value);
    option.selected = selected.has(value);
    select.add(option);
  }
}

function render() {
  const name = id => id === 'user' ? 'User' : snapshot.agents.find(agent => agent.id === id)?.name || id;
  const taskName = id => snapshot.tasks.find(task => task.id === id)?.title || id;
  const people = [['user', 'User'], ...snapshot.agents.map(agent => [agent.id, agent.name])];
  options('task', snapshot.tasks.map(task => [task.id, task.title]), 'No task');
  options('request', people, 'Not a request');
  options('mentions', people);
  const posts = snapshot.posts.map(post => {
    const article = document.createElement('article');
    const heading = document.createElement('strong');
    heading.textContent = `${name(post.from)} - ${post.createdAt}`;
    const text = document.createElement('p');
    text.textContent = post.body;
    const context = document.createElement('small');
    context.textContent = [
      post.taskId && `Task: ${taskName(post.taskId)}`,
      post.mentions.length && `Mentions: ${post.mentions.map(name).join(', ')}`,
      post.requestTo && `Request to ${name(post.requestTo)}: ${post.acknowledgedAt ? 'acknowledged (not task completion)' : 'awaiting acknowledgement'}`
    ].filter(Boolean).join(' | ');
    article.append(heading, text, context);
    if (post.requestTo === 'user' && !post.acknowledgedAt) {
      const button = document.createElement('button');
      button.textContent = 'Acknowledge request';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await api('/board/ack', { postId: post.id }); await refresh(); }
        catch (error) { element('error').textContent = error.message; button.disabled = false; }
      });
      article.append(document.createElement('br'), button);
    }
    return article;
  });
  element('posts').replaceChildren(...posts);
}

async function refresh() {
  snapshot = await api('/board');
  if (snapshot.revision !== revision) { render(); revision = snapshot.revision; }
  element('connection').textContent = 'Connected - shared board refreshes every second. Agents must read the board; no automatic wakeup.';
}

element('compose').addEventListener('submit', async event => {
  event.preventDefault();
  element('submit').disabled = true;
  element('error').textContent = '';
  try {
    await api('/board', {
      body: element('body').value, taskId: element('task').value || null,
      requestTo: element('request').value || null,
      mentions: [...element('mentions').selectedOptions].map(option => option.value)
    });
    element('body').value = '';
    await refresh();
  } catch (error) { element('error').textContent = error.message; }
  finally { element('submit').disabled = stopped; }
});

element('legacy').addEventListener('toggle', async () => {
  if (!element('legacy').open) return;
  try {
    const messages = await api('/board/archive');
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(messages, null, 2);
    element('archive').replaceChildren(pre);
  } catch (error) { element('error').textContent = error.message; }
});

async function poll() {
  try { await refresh(); }
  catch (error) {
    element('connection').textContent = `Disconnected: ${error.message} Reopen Notice Board from VS Code if the service restarted.`;
  }
  if (!stopped) setTimeout(poll, 1000);
}
if (token) poll();
else {
  stopped = true;
  element('connection').textContent = 'Open this board using Murmurplex: Open Notice Board in VS Code.';
  element('submit').disabled = true;
}
