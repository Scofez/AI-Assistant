const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

// Actions that the owner allowed again and again. Only exact actions are kept
// (the same command in the same folder, or the same tool on the same file),
// never patterns, so a learned OK can never cover a different action.
const MEMORY_FILE = path.join(CONFIG_DIR, 'approvals.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return data && typeof data.actions === 'object' ? data : { actions: {} };
  } catch {
    return { actions: {} };
  }
}

function save(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** A key for one exact action. Bash commands also keep the folder they run in. */
function signature(toolName, input = {}, cwd = '') {
  let detail;
  if (toolName === 'Bash') detail = `${cwd}\u0000${String(input.command ?? '').trim().replace(/\s+/g, ' ')}`;
  else if (input.file_path || input.notebook_path) detail = path.resolve(cwd || '/', input.file_path ?? input.notebook_path);
  else detail = JSON.stringify(input);
  return crypto.createHash('sha256').update(`${toolName}\u0000${detail}`).digest('hex').slice(0, 32);
}

function isLearned(sig) {
  return Boolean(load().actions[sig]?.isLearned);
}

/** Counts an Allow. Returns true when this Allow makes the action learned. */
function recordAllow(sig, { description, reason, threshold }) {
  const data = load();
  const entry = data.actions[sig] ?? { count: 0, isLearned: false };
  entry.count += 1;
  entry.description = description;
  entry.reason = reason;
  entry.lastAllowedAt = new Date().toISOString();
  const isNewlyLearned = !entry.isLearned && entry.count >= threshold;
  if (isNewlyLearned) entry.isLearned = true;
  data.actions[sig] = entry;
  save(data);
  return isNewlyLearned;
}

/** A Deny removes the action, so it asks again from zero. */
function recordDeny(sig) {
  const data = load();
  if (!data.actions[sig]) return;
  delete data.actions[sig];
  save(data);
}

/** Learned actions, newest first: [{ sig, description, reason, count, lastAllowedAt }]. */
function listLearned() {
  return Object.entries(load().actions)
    .filter(([, e]) => e.isLearned)
    .map(([sig, e]) => ({ sig, ...e }))
    .sort((a, b) => String(b.lastAllowedAt).localeCompare(String(a.lastAllowedAt)));
}

/** Forgets one learned action (by its number in listLearned, from 1) or all of them. Returns how many. */
function forget(which) {
  const data = load();
  const learned = listLearned();
  const targets = which === 'all' ? learned : [learned[Number(which) - 1]].filter(Boolean);
  for (const t of targets) delete data.actions[t.sig];
  save(data);
  return targets.length;
}

module.exports = { MEMORY_FILE, signature, isLearned, recordAllow, recordDeny, listLearned, forget };
