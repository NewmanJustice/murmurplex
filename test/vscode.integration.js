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
  throw new Error(message);
}
async function run() {
  const extension = vscode.extensions.getExtension('murmurplex.murmurplex');
  assert.ok(extension, 'extension is installed in the development host');
  await extension.activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;

  try {
    const lead = await vscode.commands.executeCommand('murmurplex.addTab', { kind: 'shell', name: 'Integration lead' });
    assert.ok(lead?.id);
    await waitFor(() => vscode.window.tabGroups.all[0].tabs.length === 1, 'first terminal tab did not open');
    const worker = await vscode.commands.executeCommand('murmurplex.addPane', { kind: 'shell', name: 'Integration worker' });
    assert.ok(worker?.id);
    await waitFor(() => vscode.window.tabGroups.all.length === 2, 'second terminal group did not open');
    const reviewer = await vscode.commands.executeCommand('murmurplex.addTab', { kind: 'shell', name: 'Integration reviewer' });
    assert.ok(reviewer?.id);
    await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.length === 2), 'second tab did not remain in the same group');
    assert.equal(vscode.window.tabGroups.all.length, 2);
    await vscode.commands.executeCommand('murmurplex.balance');
    const layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
    fs.writeFileSync(path.join(root, 'layout-result.json'), JSON.stringify(layout, null, 2));
    const leaves = node => node.groups ? node.groups.flatMap(leaves) : [node];
    const panes = leaves(layout);
    assert.equal(panes.length, 2);
    assert.ok(Math.abs(panes[0].size - panes[1].size) / Math.max(panes[0].size, panes[1].size) < 0.02);
    vscode.window.terminals.find(t => t.name.includes(lead.id)).show();
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.tabs.some(tab => tab.label.includes(lead.id)), 'lead group did not receive focus');
    const extra = await vscode.commands.executeCommand('murmurplex.addPane', { kind: 'shell', name: 'Integration extra' });
    await waitFor(() => vscode.window.tabGroups.all.length === 3, 'adding from an earlier group reused a neighbour instead of creating a group');
    vscode.window.terminals.find(t => t.name.includes(extra.id)).dispose();
    await waitFor(() => vscode.window.tabGroups.all.length === 2, 'extra group did not close');
    const runtime = JSON.parse(fs.readFileSync(path.join(root, '.murmurplex/runtime.json'), 'utf8'));
    const result = await fetch(runtime.url + '/status', { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}` }, body: JSON.stringify({ agentId: worker.id, status: 'needs-permission' }) });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.murmurplex/state.json'), 'utf8')).agents.find(a => a.id === worker.id).attention, 'needs-permission');
    const terminal = vscode.window.terminals.find(t => t.name.includes(worker.id));
    terminal.dispose();
    await waitFor(() => !vscode.window.terminals.includes(terminal), 'terminal did not close');
    // The reviewer tab must survive closing its neighbour.
    assert.ok(vscode.window.terminals.some(t => t.name.includes(reviewer.id)));
    const reviewerTerminal = vscode.window.terminals.find(t => t.name.includes(reviewer.id));
    reviewerTerminal.dispose();
    await waitFor(() => vscode.window.tabGroups.all.length === 1, 'empty terminal group did not close');
    fs.writeFileSync(path.join(root, 'integration-result.json'), JSON.stringify({ passed: true, checks: ['grid', 'tabs', 'balance', 'attention', 'removal'] }));
    console.log('MURMURPLEX INTEGRATION PASS: terminal grid, nested tabs, balance, persisted attention, removal.');
  } catch (error) {
    fs.writeFileSync(path.join(root, 'integration-result.json'), JSON.stringify({ passed: false, error: error.stack }));
    throw error;
  } finally {
    for (const terminal of vscode.window.terminals) if (terminal.name.includes('Integration')) terminal.dispose();
  }
}
module.exports = { run };
