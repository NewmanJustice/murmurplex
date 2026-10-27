'use strict';
const { spawnSync } = require('node:child_process');

const result = spawnSync('gh', [
  'api', '--method', 'PATCH', 'repos/{owner}/{repo}', '--input', '-', '--jq', '.security_and_analysis'
], {
  input: JSON.stringify({
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' }
    }
  }),
  encoding: 'utf8'
});
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error('GitHub protection could not be configured. Install gh, authenticate and retry.');
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  const settings = JSON.parse(result.stdout);
  if (settings?.secret_scanning?.status === 'enabled' && settings?.secret_scanning_push_protection?.status === 'enabled') {
    console.log('GitHub secret scanning and push protection are enabled.');
  } else {
    console.error('GitHub did not confirm both protections enabled. Check repository settings and feature availability.');
    process.exitCode = 1;
  }
} else console.error('Push protection was not enabled. Authenticate with repository-admin access and check repository feature availability.');
