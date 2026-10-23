#!/usr/bin/env node
// Removes only the hook entries that run the avatar's forward.sh.
const { SETTINGS_FILE, readSettings, backupSettings, writeSettings, isOurHook } = require('./hooks-common');

const settings = readSettings();
const hooks = { ...(settings.hooks ?? {}) };
let removed = 0;

for (const [event, groups] of Object.entries(hooks)) {
  if (!Array.isArray(groups)) continue;
  const kept = groups
    .map((group) => {
      const inner = (group.hooks ?? []).filter((hook) => !isOurHook(hook));
      removed += (group.hooks ?? []).length - inner.length;
      return { ...group, hooks: inner };
    })
    .filter((group) => group.hooks.length > 0);
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
}

if (removed === 0) {
  console.log('No avatar hooks found. Nothing changed.');
} else {
  const backup = backupSettings();
  const next = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  writeSettings(next);
  if (backup) console.log(`Backup: ${backup}`);
  console.log(`Removed ${removed} avatar hook(s) from ${SETTINGS_FILE}.`);
}
