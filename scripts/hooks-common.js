const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const FORWARD_SCRIPT = path.resolve(__dirname, '..', 'hooks', 'forward.sh');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${SETTINGS_FILE}: ${err.message}. Nothing was changed.`);
  }
}

/** Copies settings.json to settings.json.bak-<timestamp> before any change. */
function backupSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${SETTINGS_FILE}.bak-${stamp}`;
  fs.copyFileSync(SETTINGS_FILE, backup);
  return backup;
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

/** True when a hook command runs our forward.sh, at any path. */
function isOurHook(hook) {
  return typeof hook?.command === 'string' && hook.command.includes('forward.sh') && hook.command.includes('avatar');
}

module.exports = { SETTINGS_FILE, FORWARD_SCRIPT, EVENTS, TOOL_EVENTS, readSettings, backupSettings, writeSettings, isOurHook };
