'use strict';
// Invoked by VS Code's --extensionTestsPath; no test-runner dependencies required.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store');
async function waitFor(predicate, message) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}
async function run() {
  const extension = vscode.extensions.getExtension('murmurplex.murmurplex');
  assert.ok(extension, 'extension is installed in the development host');
  await extension.activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const focusState = () => JSON.stringify({
    activeTerminal: vscode.window.activeTerminal?.name,
    terminals: vscode.window.terminals.map(terminal => terminal.name),
    groups: vscode.window.tabGroups.all.map(group => ({
      active: group.isActive, viewColumn: group.viewColumn,
      tabs: group.tabs.map(tab => ({ label: tab.label, active: tab.isActive, input: tab.input?.constructor.name }))
    }))
  });

  try {
    // Another owner holds the project: this window must stay read-only, and take over once the lock is released.
    const directory = path.join(root, '.murmurplex');
    const otherOwner = new Store(directory);
    otherOwner.register({ name: 'Other window agent', kind: 'shell' });
    const lockBefore = fs.readFileSync(path.join(directory, 'writer.lock'), 'utf8');
    assert.equal(await vscode.commands.executeCommand('murmurplex.addTab', { kind: 'shell', name: 'Blocked' }), undefined);
    assert.equal(vscode.window.terminals.length, 0, 'read-only window must not launch agents');
    assert.equal(fs.readFileSync(path.join(directory, 'writer.lock'), 'utf8'), lockBefore, 'read-only window must not touch the owner lock');
    otherOwner.close();
    const lead = await vscode.commands.executeCommand('murmurplex.addTab', { kind: 'shell', name: 'Integration lead' });
    assert.ok(lead?.id);
    await waitFor(() => vscode.window.tabGroups.all[0].tabs.length === 1, 'first terminal tab did not open');
    const leadGroup = vscode.window.tabGroups.all[0];
    const leadTerminal = vscode.window.terminals.find(terminal => terminal.name.includes(lead.id));
    const worker = await vscode.commands.executeCommand('murmurplex.addPane', { kind: 'shell', name: 'Integration worker' });
    assert.ok(worker?.id);
    await waitFor(() => vscode.window.tabGroups.all.length === 2, 'second terminal group did not open');
    const workerGroup = vscode.window.tabGroups.all.find(group => group !== leadGroup);
    const workerTerminal = vscode.window.terminals.find(terminal => terminal.name.includes(worker.id));
    await waitFor(() => vscode.window.activeTerminal === workerTerminal
      && vscode.window.tabGroups.activeTabGroup === workerGroup
      && workerGroup.activeTab?.input instanceof vscode.TabInputTerminal,
    () => `worker terminal did not open in the new group: ${focusState()}`);
    const reviewer = await vscode.commands.executeCommand('murmurplex.addTab', { kind: 'shell', name: 'Integration reviewer' });
    assert.ok(reviewer?.id);
    await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.length === 2), 'second tab did not remain in the same group');
    assert.equal(vscode.window.tabGroups.all.length, 2);
    await vscode.commands.executeCommand('murmurplex.balance');
    const leaves = node => node.groups ? node.groups.flatMap(leaves) : [node];
    // VS Code reports a transient mix of fractional and pixel sizes until the new layout settles.
    let layout, panes;
    const balanced = () => panes.length === 2 && Math.abs(panes[0].size - panes[1].size) / Math.max(panes[0].size, panes[1].size) < 0.02;
    for (let n = 0; n < 50; n++) {
      layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
      panes = leaves(layout);
      if (balanced()) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fs.writeFileSync(path.join(root, 'layout-result.json'), JSON.stringify(layout, null, 2));
    assert.ok(balanced(), `layout did not settle to equal panes within 5 seconds: ${JSON.stringify(layout)}`);
    const focused = (terminal, group) => vscode.window.activeTerminal === terminal
      && vscode.window.tabGroups.activeTabGroup === group
      && group.activeTab?.input instanceof vscode.TabInputTerminal;
    // Terminal tab labels can be empty even while the named terminal is active.
    for (let attempt = 0; attempt < 5; attempt++) {
      workerTerminal.show();
      await waitFor(() => focused(workerTerminal, workerGroup), () => `worker group did not receive focus: ${focusState()}`);
      const pendingBalance = vscode.commands.executeCommand('murmurplex.balance');
      leadTerminal.show();
      await pendingBalance;
      await waitFor(() => focused(leadTerminal, leadGroup), () => `lead group did not receive focus: ${focusState()}`);
    }
    // Settle time and equal areas for one to nine groups, including odd counts.
    const settle = async count => {
      const started = Date.now();
      for (;;) {
        const sizes = leaves(await vscode.commands.executeCommand('vscode.getEditorLayout')).map(pane => pane.size);
        if (sizes.length === count && Math.abs(Math.max(...sizes) - Math.min(...sizes)) / Math.max(...sizes) < 0.02) return Date.now() - started;
        if (Date.now() - started > 1000) throw new Error(`${count} groups did not settle to equal panes: ${JSON.stringify(await vscode.commands.executeCommand('vscode.getEditorLayout'))} ${focusState()}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const settleTimes = [];
    while (vscode.window.tabGroups.all.length < 9) {
      const count = vscode.window.tabGroups.all.length + 1;
      await vscode.commands.executeCommand('murmurplex.addPane', { kind: 'shell', name: `Integration grid ${count}` });
      await waitFor(() => vscode.window.tabGroups.all.length === count, 'grid group did not open');
      settleTimes.push([count, await settle(count)]);
    }
    fs.writeFileSync(path.join(root, 'settle-times.json'), JSON.stringify(settleTimes));
    // A tenth agent becomes a tab instead of a tenth group.
    const tenth = await vscode.commands.executeCommand('murmurplex.addPane', { kind: 'shell', name: 'Integration tenth' });
    assert.ok(tenth?.id);
    await waitFor(() => vscode.window.terminals.some(t => t.name.includes(tenth.id)), 'tenth agent terminal did not open');
    assert.equal(vscode.window.tabGroups.all.length, 9);
    // Maximise keeps every terminal alive, and restore returns to the balanced grid.
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand('murmurplex.maximize');
    assert.equal(vscode.window.tabGroups.all.length, 9);
    assert.equal(vscode.window.terminals.length, before);
    await vscode.commands.executeCommand('murmurplex.maximize');
    assert.equal(await settle(9) >= 0, true);
    assert.equal(vscode.window.terminals.length, before);
    for (const terminal of vscode.window.terminals) {
      if (/Integration (grid|tenth)/.test(terminal.name)) terminal.dispose();
    }
    await waitFor(() => vscode.window.tabGroups.all.length === 2, 'grid groups did not close');
    const extra = await vscode.commands.executeCommand('murmurplex.addPane', { kind: 'shell', name: 'Integration extra' });
    await waitFor(() => vscode.window.tabGroups.all.length === 3, 'adding from an earlier group reused a neighbour instead of creating a group');
    vscode.window.terminals.find(t => t.name.includes(extra.id)).dispose();
    await waitFor(() => vscode.window.tabGroups.all.length === 2, 'extra group did not close');
    const terminal = vscode.window.terminals.find(t => t.name.includes(worker.id));
    const environment = terminal.creationOptions.env;
    const credentialFile = environment.MURMURPLEX_CREDENTIALS;
    const relative = path.relative(root, credentialFile);
    assert.ok(path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`), 'credentials must be outside the project');
    assert.equal(fs.existsSync(path.join(root, '.murmurplex', 'credentials')), false);
    const credentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    const result = await fetch(credentials.url + '/status', { method: 'POST', headers: { Authorization: `Bearer ${credentials.token}` }, body: JSON.stringify({ agentId: worker.id, status: 'needs-permission' }) });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.murmurplex/state.json'), 'utf8')).agents.find(a => a.id === worker.id).attention, 'needs-permission');
    assert.ok(environment.MURMURPLEX_CREDENTIALS.endsWith(`${worker.id}.json`));
    assert.ok(!Object.entries(environment).some(([key, value]) => /TOKEN/.test(key) && value !== null), 'no secret token added to the terminal environment');
    assert.equal(environment.OPENAI_API_KEY, null, 'native login is the default');
    terminal.dispose();
    await waitFor(() => !vscode.window.terminals.includes(terminal), 'terminal did not close');
    await waitFor(() => !fs.existsSync(environment.MURMURPLEX_CREDENTIALS), 'closing the terminal did not revoke its credential');
    assert.equal((await fetch(credentials.url + '/status', { method: 'POST', headers: { Authorization: `Bearer ${credentials.token}` }, body: JSON.stringify({ status: 'working' }) })).status, 401);
    // The reviewer tab must survive closing its neighbour.
    assert.ok(vscode.window.terminals.some(t => t.name.includes(reviewer.id)));
    const reviewerTerminal = vscode.window.terminals.find(t => t.name.includes(reviewer.id));
    reviewerTerminal.dispose();
    await waitFor(() => vscode.window.tabGroups.all.length === 1, 'empty terminal group did not close');
    fs.writeFileSync(path.join(root, 'integration-result.json'), JSON.stringify({ passed: true, checks: ['grid', 'tabs', 'balance', 'focus', 'attention', 'credentials', 'removal', 'grid-1-9', 'tenth-agent-tab', 'maximize-restore', 'read-only-second-window'] }));
    console.log('MURMURPLEX INTEGRATION PASS: terminal grid, nested tabs, balance, focus, persisted attention, removal.');
  } catch (error) {
    fs.writeFileSync(path.join(root, 'integration-result.json'), JSON.stringify({ passed: false, error: error.stack }));
    throw error;
  } finally {
    for (const terminal of vscode.window.terminals) if (terminal.name.includes('Integration')) terminal.dispose();
  }
}
module.exports = { run };
