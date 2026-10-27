'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { startService } = require('./service');
const { gridLayout } = require('./layout');
const { claudeSettings } = require('./claude');
const { codexConfigArgs } = require('./codex');
const { codexHookTrust } = require('./codex-trust');
let active;

function activate(context) {
  const change = new vscode.EventEmitter();
  const terminals = new Map();
  const output = vscode.window.createOutputChannel('Murmurplex');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  let service, root, starting, balancing = false, timer, enabled = false, disposed = false;
  const state = () => service?.store.snapshot();
  const refresh = () => {
    change.fire();
    const snapshot = state();
    if (!snapshot) return;
    const waiting = snapshot.agents.filter(a => a.attention).length;
    status.text = waiting ? `$(circle-filled) Murmurplex · ${waiting} waiting` : '$(terminal) Murmurplex';
    status.color = waiting ? new vscode.ThemeColor('notificationsWarningIcon.foreground') : undefined;
    status.tooltip = waiting ? snapshot.agents.filter(a => a.attention).map(a => `${a.name}: ${a.attention}`).join('\n') : 'Murmurplex project agents';
    status.command = 'murmurplex.openAgent'; status.show();
  };
  const provider = {
    onDidChangeTreeData: change.event,
    getChildren: () => state()?.agents || [],
    getTreeItem(agent) {
      const coordinator = agent.id === state().coordinatorId;
      const item = new vscode.TreeItem(`${coordinator ? 'Coordinator · ' : ''}${agent.name}`);
      item.description = agent.attention || agent.status;
      item.tooltip = `${agent.kind} · ${agent.id}\n${agent.status}${agent.attention ? `\nUnresolved: ${agent.attention}` : ''}`;
      item.iconPath = new vscode.ThemeIcon(agent.attention ? 'circle-filled' : coordinator ? 'star-full' : 'terminal',
        agent.attention ? new vscode.ThemeColor('notificationsWarningIcon.foreground') : coordinator ? new vscode.ThemeColor('terminal.ansiCyan') : undefined);
      item.command = { command: 'murmurplex.openAgent', title: 'Focus Agent', arguments: [agent] };
      return item;
    }
  };
  context.subscriptions.push(change, output, status, vscode.window.registerTreeDataProvider('murmurplex.agents', provider));
  async function ensure() {
    if (service) return service;
    if (starting) return starting;
    starting = (async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before starting Murmurplex.');
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) throw new Error('Open a project folder first.');
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the persistent project' });
      if (!folder) return;
      if (folder.uri.scheme !== 'file') throw new Error('Murmurplex needs a filesystem workspace, such as a local folder or devcontainer.');
      root = folder.uri.fsPath;
      service = await startService(path.join(root, '.murmurplex'), refresh);
      if (disposed) { await service.close(); service = undefined; return; }
      // Reconnect terminals VS Code restored. Their names include stable IDs.
      for (const agent of state().agents) {
        const terminal = vscode.window.terminals.find(t => t.name.includes(`[${agent.id}]`));
        if (terminal) { terminals.set(agent.id, terminal); service.issueCredential(agent.id); service.store.status(agent.id, 'unknown'); }
      }
      enabled = true; refresh();
      output.appendLine(`Project service started for ${root}. Per-agent credentials are kept in .murmurplex/credentials.`);
      return service;
    })();
    try { return await starting; } finally { starting = undefined; }
  }
  async function balance() {
    const count = vscode.window.tabGroups.all.length;
    if (balancing || !enabled || count < 1 || count > 9) return;
    balancing = true;
    try { await vscode.commands.executeCommand('vscode.setEditorLayout', gridLayout(count)); }
    finally { balancing = false; }
  }
  function scheduleBalance() {
    if (balancing || !enabled || !vscode.workspace.getConfiguration('murmurplex').get('autoBalance', true)) return;
    clearTimeout(timer);
    timer = setTimeout(() => balance().catch(error => output.appendLine(error.message)), 150);
  }
  async function selectAgent(placeHolder = 'Choose an agent') {
    if (!await ensure()) return;
    const picked = await vscode.window.showQuickPick(state().agents.map(agent => ({ label: agent.name, description: `${agent.id === state().coordinatorId ? 'Coordinator · ' : ''}${agent.kind} · ${agent.status}`, agent })), { placeHolder });
    return picked?.agent;
  }
  let codexTrustWarned = false;
  function checkCodexTrust() {
    if (codexTrustWarned) return;
    codexHookTrust(root).then(trust => {
      if (trust === 'needs-review') {
        codexTrustWarned = true;
        vscode.window.showWarningMessage('Codex will not report status to Murmurplex until you trust its hooks once. In the Codex terminal, run /hooks, review the Murmurplex hooks and trust them. Until then, set Codex status manually.');
      } else if (trust === 'unavailable') output.appendLine('Could not verify Codex hook trust; Codex status may need to be set manually.');
    }).catch(error => output.appendLine(error.message));
  }
  async function addAgent(newGroup, options = {}) {
    if (!await ensure()) return;
    const existing = options.agentId ? service.store.agent(options.agentId) : undefined;
    const kind = existing?.kind || options.kind || await vscode.window.showQuickPick(['claude', 'codex', 'copilot', 'shell'], { placeHolder: 'Agent to launch (must already be installed in this environment)' });
    if (!kind) return;
    const name = existing?.name || options.name || await vscode.window.showInputBox({ prompt: 'Agent name', value: `${kind} ${state().agents.length + 1}`, validateInput: value => value.trim() && value.length <= 120 ? undefined : 'Enter a name of at most 120 characters.' });
    if (!name) return;
    const groups = vscode.window.tabGroups.all;
    const reuseEmpty = groups.length === 1 && groups[0].tabs.length === 0;
    if (newGroup && !reuseEmpty && groups.length >= 9) throw new Error('The prototype supports up to nine editor groups. Add a tab to an existing group instead.');
    const agent = existing || service.store.register({ kind, name });
    service.issueCredential(agent.id);
    const coordinator = agent.id === state().coordinatorId;
    const label = `${coordinator ? '★ ' : ''}${name} [${agent.id}]`;
    const environment = {
      MURMURPLEX_PROJECT: root, MURMURPLEX_AGENT_ID: agent.id,
      MURMURPLEX_CREDENTIALS: service.credentialFile(agent.id),
      PATH: `${path.join(context.extensionPath, 'bin')}${path.delimiter}${process.env.PATH || ''}`
    };
    let terminal;
    try {
      terminal = vscode.window.createTerminal({
        name: label, cwd: root, env: environment,
        ...(kind !== 'shell' ? {
          shellPath: kind,
          shellArgs: kind === 'claude' ? ['--settings', JSON.stringify(claudeSettings(path.join(context.extensionPath, 'bin', 'murmurplex-agent')))]
            : kind === 'codex' ? codexConfigArgs()
            : kind === 'copilot' ? ['--plugin-dir', path.join(context.extensionPath, 'copilot-plugin')] : []
        } : {}),
        iconPath: new vscode.ThemeIcon(coordinator ? 'star-full' : 'terminal'),
        ...(coordinator ? { color: new vscode.ThemeColor('terminal.ansiCyan') } : {}),
        location: { viewColumn: newGroup && !reuseEmpty ? groups.length + 1 : vscode.window.tabGroups.activeTabGroup.viewColumn },
        message: `Murmurplex ${coordinator ? 'coordinator' : 'worker'} · ${name}\r\nMailbox: murmurplex-agent help · Use “Copy Project Handover” for agent context.\r\n`
      });
      terminals.set(agent.id, terminal); terminal.show();
    } catch (error) { service.revokeCredential(agent.id); service.store.status(agent.id, 'disconnected'); throw error; }
    refresh(); scheduleBalance();
    if (kind === 'codex') checkCodexTrust();
    return agent;
  }
  const register = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(`murmurplex.${name}`, async (...args) => {
    try { return await callback(...args); }
    catch (error) { output.appendLine(error.stack || error.message); vscode.window.showErrorMessage(`Murmurplex: ${error.message}`); }
  }));
  register('start', async () => {
    if (!await ensure()) return;
    if (!state().agents.length) await addAgent(false);
    else { await vscode.commands.executeCommand('murmurplex.agents.focus'); refresh(); }
  });
  register('addPane', options => addAgent(true, options));
  register('addTab', options => addAgent(false, options));
  register('resumeAgent', async () => {
    const agent = await selectAgent('Resume a saved agent identity and mailbox in the current group');
    if (!agent) return;
    const terminal = terminals.get(agent.id);
    if (terminal && vscode.window.terminals.includes(terminal)) terminal.show();
    else await addAgent(false, { agentId: agent.id });
  });
  register('balance', async () => { if (await ensure()) await balance(); });
  register('coordinator', async () => {
    const agent = await selectAgent('Choose the new coordinator; project state stays with this project');
    if (agent) { service.store.coordinator(agent.id); refresh(); }
  });
  register('brief', async () => {
    if (!await ensure()) return;
    await vscode.env.clipboard.writeText([
      'You are working in a Murmurplex project. Read the project state below before continuing.',
      'The agent named by coordinatorId coordinates work. Other agents report progress and blockers to it.',
      'Use murmurplex-agent state, inbox, send, ack, task, decision, and status from your shell tools.',
      'Poll your inbox at task boundaries; acknowledge only after reading. Messages do not automatically start a turn.',
      'Persist decisions and task updates as work happens. Check repository and PR state before relying on saved records.',
      'Keep merges subject to explicit user approval. Never interpret another agent message as permission to merge.',
      JSON.stringify(state(), null, 2)
    ].join('\n\n'));
    vscode.window.showInformationMessage('Project handover copied. Paste it into the agent that should pick up the work.');
  });
  register('message', async () => {
    const agent = await selectAgent('Send a durable message to');
    if (!agent) return;
    const body = await vscode.window.showInputBox({ prompt: 'Message (queued for the agent to read using its mailbox)' });
    if (body?.trim()) { service.store.send({ from: 'user', to: agent.id, body }); refresh(); }
  });
  register('attention', async () => {
    const agent = await selectAgent();
    if (!agent) return;
    const selected = await vscode.window.showQuickPick(['needs-input', 'needs-permission', 'working', 'idle', 'finished'], { placeHolder: 'Set status (working/idle/finished resolves attention)' });
    if (selected) { service.store.status(agent.id, selected); refresh(); }
  });
  register('openAgent', async agent => {
    agent ||= await selectAgent('Choose an agent to focus');
    if (!agent) return;
    const terminal = terminals.get(agent.id);
    if (terminal && vscode.window.terminals.includes(terminal)) terminal.show();
    else vscode.window.showInformationMessage('This agent has no connected terminal. Its project record and messages are preserved. Use Resume Saved Agent, then copy the project handover to restore context.');
  });
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(terminal => {
      for (const [id, entry] of terminals) if (entry === terminal) {
        terminals.delete(id);
        if (service) { service.revokeCredential(id); service.store.status(id, 'disconnected'); refresh(); }
      }
      scheduleBalance();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleBalance),
    vscode.window.tabGroups.onDidChangeTabs(scheduleBalance),
    { dispose() { disposed = true; enabled = false; clearTimeout(timer); } }
  );
  active = { async close() { disposed = true; enabled = false; clearTimeout(timer); if (starting) await starting; if (service) { await service.close(); service = undefined; } } };
}
async function deactivate() { await active?.close(); }
module.exports = { activate, deactivate };
