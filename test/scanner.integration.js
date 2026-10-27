'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('the installed pre-commit hook accepts clean commits, blocks staged secrets and redacts scanner output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-scanner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  const git = (...args) => run('git', args);
  assert.equal(git('init', '--quiet').status, 0);
  fs.mkdirSync(path.join(root, '.githooks'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['.gitleaks.toml', '.githooks/pre-commit', 'scripts/scan-secrets.js']) {
    fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(root, file));
  }
  fs.chmodSync(path.join(root, '.githooks/pre-commit'), 0o755);
  const installed = run(process.execPath, [path.resolve(__dirname, '../scripts/install-security-hook.js')]);
  assert.equal(installed.status, 0, installed.stderr);
  fs.writeFileSync(path.join(root, 'example.txt'), 'Ordinary project content.\n');
  assert.equal(git('add', 'example.txt').status, 0);
  const commit = () => git('-c', 'user.name=Scanner Test', '-c', 'user.email=scanner@example.invalid', 'commit', '-m', 'Test staged scanning');
  const clean = commit();
  assert.equal(clean.status, 0, clean.stderr);
  for (const secret of [
    ['ghp', randomBytes(18).toString('hex')].join('_'),
    randomBytes(32).toString('hex')
  ]) {
    fs.writeFileSync(path.join(root, 'example.txt'), JSON.stringify({ token: secret }));
    assert.equal(git('add', 'example.txt').status, 0);
    const blocked = commit();
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /leaks found/i);
    assert.ok(!(blocked.stdout + blocked.stderr).includes(secret), 'scanner output must not expose the secret');
  }
  const unavailable = spawnSync(process.execPath, [path.join(root, 'scripts/scan-secrets.js'), 'staged'], {
    cwd: root, env: { ...process.env, PATH: root }, encoding: 'utf8'
  });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /could not run/);
});
