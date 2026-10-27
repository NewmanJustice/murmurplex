'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2] || 'history';
if (!['history', 'staged', 'files'].includes(mode)) {
  console.error('Use history, staged or files.');
  process.exit(1);
}
const result = spawnSync('gitleaks', [
  mode === 'files' ? 'dir' : 'git', '--redact', '--no-banner', '--ignore-gitleaks-allow',
  '--config', path.resolve(__dirname, '../.gitleaks.toml'),
  ...(mode === 'staged' ? ['--staged'] : mode === 'history' ? ['--log-opts=--all'] : [])
], { stdio: 'inherit' });
if (result.error) {
  console.error('Secret scanning could not run. Install Gitleaks 8.30.1 or later and ensure it is on PATH.');
}
process.exitCode = result.status ?? 1;
