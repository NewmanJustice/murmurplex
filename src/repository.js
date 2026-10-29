'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');

const git = (root, args) => new Promise((resolve, reject) => {
  execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true
  }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    if (error.code === 'ENOENT') return reject(new Error('Git is not installed or is not available on PATH.'));
    if (error.killed) return reject(new Error(`Git ${args[0]} inspection timed out; repository state is unverified.`));
    const detail = String(stderr || error.message).trim().split(/\r?\n/).slice(0, 2).join(' ');
    reject(new Error(`Git ${args[0]} failed${error.code ? ` (${error.code})` : ''}${detail ? `: ${detail}` : '.'}`));
  });
});

function parseStatus(output) {
  let branch = '';
  let head = null;
  const changes = [];
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length);
      branch = name === '(detached)' ? '' : name;
    }
    else if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length);
      if (oid !== '(initial)') head = oid;
    } else if (record.startsWith('? ')) changes.push({ status: '??', path: record.slice(2) });
    else if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      changes.push({ status: fields[1], path: fields.slice(8).join(' ') });
    } else if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      changes.push({ status: fields[1], path: fields.slice(9).join(' ') });
      index++;
    } else if (record.startsWith('u ')) {
      const fields = record.split(' ');
      changes.push({ status: fields[1], path: fields.slice(10).join(' ') });
    } else if (record) throw new Error('Git returned an unrecognized status record.');
  }
  return { branch, head, changes };
}

function parseWorktrees(output) {
  const worktrees = [];
  let current;
  const finish = () => {
    if (current) worktrees.push(current);
    current = undefined;
  };
  for (const field of output.split('\0')) {
    if (!field) { finish(); continue; }
    const separator = field.indexOf(' ');
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? '' : field.slice(separator + 1);
    if (key === 'worktree') {
      finish();
      current = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (current && key === 'HEAD') current.head = value;
    else if (current && key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (current && key === 'detached') current.detached = true;
    else if (current && key === 'bare') current.bare = true;
    else if (current && key === 'locked') current.locked = true;
    else if (current && key === 'prunable') current.prunable = true;
  }
  finish();
  return worktrees;
}

async function inspectRepository(root) {
  const statusText = await git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  const [repositoryRoot, worktreeText] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel']),
    git(root, ['worktree', 'list', '--porcelain', '-z'])
  ]);
  return {
    root: repositoryRoot.trim(),
    ...parseStatus(statusText),
    worktrees: parseWorktrees(worktreeText).map(worktree => ({
      ...worktree,
      current: path.resolve(worktree.path) === path.resolve(repositoryRoot.trim())
    }))
  };
}

module.exports = { inspectRepository, parseStatus, parseWorktrees };
