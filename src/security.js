'use strict';

const secretPatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  /\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?access[_-]?key|private[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/gi
];

function assertNoSecrets(value, isLocalToken = () => false) {
  const check = text => {
    const suspicious = secretPatterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(text); });
    if (suspicious || [...text.matchAll(/[a-f0-9]{64}/g)].some(match => isLocalToken(match[0]))) {
      throw new Error('Potential secret detected. Keep credentials out of Murmurplex project records.');
    }
  };
  if (typeof value === 'string') check(value);
  else {
    JSON.stringify(value, (key, entry) => {
      if (typeof entry === 'string') { check(entry); check(`${key}=${entry}`); }
      return entry;
    });
  }
}

function redact(text) {
  let safe = String(text);
  for (const pattern of secretPatterns) safe = safe.replace(pattern, '[REDACTED]');
  return safe.replace(/[a-f0-9]{64}/g, '[REDACTED]');
}

function parseJSON(text, label) {
  try { return JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${label} contains invalid JSON.`);
  }
}

const authenticationVariables = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
  'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'MURMURPLEX_TOKEN', 'MURMURPLEX_URL'
];

function authenticationEnvironment(inherit, source = process.env) {
  if (inherit) return { MURMURPLEX_TOKEN: null, MURMURPLEX_URL: null };
  const names = new Set(authenticationVariables);
  for (const name of Object.keys(source)) {
    if (/(?:^|_)(?:API_?KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET|SECRET_ACCESS_KEY)$/i.test(name)) names.add(name);
  }
  return Object.fromEntries([...names].map(name => [name, null]));
}

module.exports = { assertNoSecrets, redact, parseJSON, authenticationEnvironment };
