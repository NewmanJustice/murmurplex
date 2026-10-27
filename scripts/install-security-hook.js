'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function git(...args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
try {
  execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
  let existing;
  try { existing = git('config', '--get', 'core.hooksPath'); }
  catch (error) { if (error.status !== 1) throw error; }
  if (existing && existing !== '.githooks') throw new Error('An existing hooksPath is configured. Integrate the scanner into your existing pre-commit hook instead of replacing it.');
  const hooks = git('rev-parse', '--git-path', 'hooks');
  if (!existing && fs.existsSync(hooks) && fs.readdirSync(hooks).some(name => !name.endsWith('.sample'))) {
    throw new Error('Existing Git hooks found. Integrate the scanner into your existing pre-commit hook instead of replacing them.');
  }
  git('config', '--local', 'core.hooksPath', '.githooks');
  console.log('Staged secret scanning enabled for this checkout.');
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Install Gitleaks 8.30.1 or later before enabling the hook.' : error.message);
  process.exitCode = 1;
}
