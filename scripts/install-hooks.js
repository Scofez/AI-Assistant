#!/usr/bin/env node
// Adds avatar hooks to ~/.claude/settings.json. Safe to run again: no duplicates.
const {
  SETTINGS_FILE, FORWARD_SCRIPT, EVENTS, TOOL_EVENTS, readSettings, backupSettings, writeSettings, isOurHook,
} = require('./hooks-common');

const settings = readSettings();
const hooks = { ...(settings.hooks ?? {}) };
const command = `'${FORWARD_SCRIPT.replace(/'/g, `'\\''`)}'`;
let added = 0;

for (const event of EVENTS) {
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
  const isInstalled = groups.some((group) => (group.hooks ?? []).some(isOurHook));
  if (isInstalled) continue;
  const entry = { hooks: [{ type: 'command', command, timeout: 1 }] };
  hooks[event] = [...groups, TOOL_EVENTS.has(event) ? { matcher: '*', ...entry } : entry];
  added++;
}

if (added === 0) {
  console.log('Avatar hooks are already installed. Nothing changed.');
} else {
  const backup = backupSettings();
  writeSettings({ ...settings, hooks });
  if (backup) console.log(`Backup: ${backup}`);
  console.log(`Added avatar hooks for ${added} event(s) in ${SETTINGS_FILE}. Restart Claude Code to load them.`);
}
