'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectRepository } = require('../src/repository');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('repository inspection reports current branch, changes and worktrees without writing', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-repository-'));
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Murmurplex test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial commit');
  const head = git(root, 'rev-parse', 'HEAD');
  const linked = path.join(parent, 'linked-worktree');
  git(root, 'worktree', 'add', '-b', 'feature', linked);

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'modified\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged change\n');
  git(root, 'add', 'staged.txt');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
  const indexBefore = fs.readFileSync(path.join(root, '.git', 'index'));

  const observed = await inspectRepository(root);

  assert.equal(observed.root, root);
  assert.equal(observed.branch, 'main');
  assert.equal(observed.head, head);
  assert.deepEqual(observed.changes, [
    { status: 'M.', path: 'staged.txt' },
    { status: '.M', path: 'tracked.txt' },
    { status: '??', path: 'untracked.txt' }
  ]);
  assert.equal(observed.worktrees.length, 2);
  assert.deepEqual(observed.worktrees.map(worktree => [worktree.path, worktree.branch, worktree.current]), [
    [root, 'main', true],
    [linked, 'feature', false]
  ]);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), indexBefore, 'inspection must not refresh or rewrite the Git index');

  git(root, 'checkout', '--detach');
  const detached = await inspectRepository(root);
  assert.equal(detached.branch, '');
  assert.equal(detached.head, head);
});

test('repository inspection reports non-repository failures explicitly', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-not-repo-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(inspectRepository(directory), /not a git repository/i);
});
