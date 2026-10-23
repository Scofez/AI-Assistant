const { execFile, spawn } = require('child_process');
const https = require('https');
const { childEnv } = require('./assistant');

const LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const VERSION = /(\d+)\.(\d+)\.(\d+)/;

/** -1, 0, or 1, like a sort compare. Versions without a number compare as equal. */
function compareVersions(a, b) {
  const pa = String(a).match(VERSION);
  const pb = String(b).match(VERSION);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The installed Claude Code version, from `claude --version`. */
function installedVersion(claudePath) {
  return new Promise((resolve) => {
    execFile(claudePath, ['--version'], { timeout: 10000, env: childEnv() }, (err, out) => {
      resolve(err ? undefined : out.match(VERSION)?.[0]);
    });
  });
}

/** The newest published version. Only the version number is read from the reply. */
function latestVersion() {
  return new Promise((resolve) => {
    const req = https.get(LATEST_URL, { timeout: 8000, headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(undefined);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve(String(JSON.parse(body).version).match(VERSION)?.[0]);
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}

/** Runs `claude update`. Each output line goes to `onLine`. Resolves with the exit code. */
function runUpdate(claudePath, onLine) {
  return new Promise((resolve) => {
    const child = spawn(claudePath, ['update'], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (chunk) => String(chunk).split('\n').map((l) => l.trim()).filter(Boolean).forEach(onLine);
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => {
      onLine(err.message);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

module.exports = { compareVersions, installedVersion, latestVersion, runUpdate };
