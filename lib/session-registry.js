const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { isAlive } = require('./terminal');

// Claude Code writes one <pid>.json per running session here. The .key files
// next to them hold a local peer token, so they are never read.
const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions');
const FILE_NAME = /^\d+\.json$/;

/**
 * Returns the Claude Code sessions that run now in a terminal:
 * [{ pid, sessionId, cwd, version, name, status }]. Missing or bad files are skipped.
 */
async function runningSessions() {
  let names = [];
  try {
    names = (await fs.readdir(REGISTRY_DIR)).filter((n) => FILE_NAME.test(n));
  } catch {
    return [];
  }
  const entries = await Promise.all(names.map(async (name) => {
    try {
      const d = JSON.parse(await fs.readFile(path.join(REGISTRY_DIR, name), 'utf8'));
      // Headless `claude -p` runs (Fern, her jobs, scripts) are also "interactive", with entrypoint "sdk-cli".
      // Only "cli" is a session in a terminal.
      if (d.kind !== 'interactive' || d.entrypoint !== 'cli' || !Number.isInteger(d.pid) || typeof d.sessionId !== 'string' || !isAlive(d.pid)) return undefined;
      return { pid: d.pid, sessionId: d.sessionId, cwd: d.cwd, version: d.version, name: d.name, status: d.status };
    } catch {
      return undefined;
    }
  }));
  return entries.filter(Boolean);
}

module.exports = { runningSessions };
