'use strict';
// Invoked by VS Code's --extensionTestsPath; no test-runner dependencies required.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    const extra = await vscode.commands.executeCommand('murmurplex.addPane', { kind: 'shell', name: 'Integration extra' });
    await waitFor(() => vscode.window.tabGroups.all.length === 3, 'adding from an earlier group reused a neighbour instead of creating a group');
    vscode.window.terminals.find(t => t.name.includes(extra.id)).dispose();
    await waitFor(() => vscode.window.tabGroups.all.length === 2, 'extra group did not close');
    const credentials = JSON.parse(fs.readFileSync(path.join(root, '.murmurplex/credentials', `${worker.id}.json`), 'utf8'));
    const result = await fetch(credentials.url + '/status', { method: 'POST', headers: { Authorization: `Bearer ${credentials.token}` }, body: JSON.stringify({ agentId: worker.id, status: 'needs-permission' }) });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.murmurplex/state.json'), 'utf8')).agents.find(a => a.id === worker.id).attention, 'needs-permission');
    const terminal = vscode.window.terminals.find(t => t.name.includes(worker.id));
    const environment = terminal.creationOptions.env;
    assert.ok(environment.MURMURPLEX_CREDENTIALS.endsWith(`${worker.id}.json`));
    assert.ok(!Object.keys(environment).some(key => /TOKEN/.test(key)), 'no secret in the terminal environment');
    terminal.dispose();
    await waitFor(() => !vscode.window.terminals.includes(terminal), 'terminal did not close');
    await waitFor(() => !fs.existsSync(environment.MURMURPLEX_CREDENTIALS), 'closing the terminal did not revoke its credential');
    assert.equal((await fetch(credentials.url + '/status', { method: 'POST', headers: { Authorization: `Bearer ${credentials.token}` }, body: JSON.stringify({ status: 'working' }) })).status, 401);
    // The reviewer tab must survive closing its neighbour.
    assert.ok(vscode.window.terminals.some(t => t.name.includes(reviewer.id)));
    const reviewerTerminal = vscode.window.terminals.find(t => t.name.includes(reviewer.id));
    reviewerTerminal.dispose();
    await waitFor(() => vscode.window.tabGroups.all.length === 1, 'empty terminal group did not close');
    fs.writeFileSync(path.join(root, 'integration-result.json'), JSON.stringify({ passed: true, checks: ['grid', 'tabs', 'balance', 'focus', 'attention', 'credentials', 'removal'] }));
    console.log('MURMURPLEX INTEGRATION PASS: terminal grid, nested tabs, balance, focus, persisted attention, removal.');
  } catch (error) {
    fs.writeFileSync(path.join(root, 'integration-result.json'), JSON.stringify({ passed: false, error: error.stack }));
    throw error;
  } finally {
    for (const terminal of vscode.window.terminals) if (terminal.name.includes('Integration')) terminal.dispose();
  }
}
module.exports = { run };
