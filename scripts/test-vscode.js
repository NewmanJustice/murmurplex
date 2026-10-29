'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
// MURMURPLEX_TEST_LOAD=N runs N busy processes to measure layout settling under CPU load.
const burners = Array.from({ length: Number(process.env.MURMURPLEX_TEST_LOAD) || 0 }, () => spawn(process.execPath, ['-e', 'for(;;);'], { stdio: 'ignore' }));
const stopBurners = () => burners.forEach(burner => burner.kill());
async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'murmurplex-vscode-'));
  const workspace = path.join(temporary, 'project');
  fs.mkdirSync(workspace);
  const root = path.resolve(__dirname, '..');
  // Extra launch flags, such as --no-sandbox on CI runners without user namespaces.
  const extra = (process.env.VSCODE_ARGS || '').split(/\s+/).filter(Boolean);
  const child = spawn(process.env.VSCODE_CLI || 'code', [
    ...extra, '--new-window', `--user-data-dir=${path.join(temporary, 'profile')}`,
    `--extensions-dir=${path.join(temporary, 'extensions')}`, '--disable-extensions',
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'test/vscode.integration.js')}`, workspace
  ], { stdio: 'inherit', shell: false });
  let failure;
  child.on('error', error => { failure = error; });
  child.on('exit', code => { if (code) failure = new Error(`VS Code exited with code ${code}`); });
  // The CLI detaches on macOS, so the test host records its own explicit result.
  const resultPath = path.join(workspace, 'integration-result.json');
  for (let attempt = 0; attempt < 300; attempt++) {
    if (failure) throw failure;
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      if (!result.passed) throw new Error(`${result.error}\nLogs: ${temporary}`);
      console.log(`VS Code integration passed: ${result.checks.join(', ')}.\nIsolated test profile and logs: ${temporary}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`VS Code test timed out. Inspect ${temporary}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(stopBurners);
