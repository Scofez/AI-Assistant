const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

// Groups of actions that can need the owner's OK. Only the groups in the config
// (confirmActions) ask; the default is 'delete' and 'large-change'.
const GROUPS = ['delete', 'large-change', 'publish', 'network', 'system', 'inline-code', 'secrets', 'messages'];

// Bash patterns, each with its group. Best effort: a command can hide its intent.
const COMMANDS = [
  ['delete', /\b(rm|rmdir|unlink|trash|shred|srm)\b|\s-delete\b|\bgit\s+(rm\b|clean\s+-\w*f)/, 'delete files or folders'],
  ['delete', /\bgit\s+(branch\s+-D|tag\s+-d|stash\s+(drop|clear))\b/, 'delete Git branches, tags, or stashes'],
  ['large-change', /\bgit\s+(reset\s+--hard\b|checkout\s+(--\s+)?\.(\s|$)|restore\s+(\S+\s+)*\.(\s|$)|rebase\b|filter-branch\b|filter-repo\b)/, 'discard changes or rewrite Git history'],
  ['publish', /\bgit\s+push\b/, 'push to a remote Git repository'],
  ['publish', /\bgh\s+(?!(?:\S+\s+)?(?:view|list|status|diff|checks|search)\b)\S+/, 'change something on GitHub'],
  ['publish', /\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\b(gcloud|aws|az|kubectl|terraform|vercel|netlify|heroku|firebase)\b/, 'publish or change cloud resources'],
  ['network', /\bcurl\b[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|\s-F\s|--form|--upload-file|-T\s)/i, 'send data to the internet'],
  ['network', /\b(wget|scp|sftp|ftp|rsync|ssh|nc|telnet)\b/, 'transfer data over the network'],
  ['system', /\bsudo\b|\bsu\s/, 'run a command as administrator'],
  ['system', /\b(brew|pip3?|gem|cargo)\s+(install|uninstall|remove)\b|\bnpm\s+(i|install)\s+(-g|--global)\b/, 'install or remove software'],
  ['system', /\b(kill|killall|pkill|launchctl|shutdown|reboot|halt|diskutil|dd|mkfs|chmod|chown|csrutil|spctl|systemsetup|pmset|tmutil|crontab)\b/, 'change the system or stop processes'],
  ['system', /\bdefaults\s+(write|delete)\b|\bsecurity\s/, 'change system settings or the keychain'],
  ['system', /\bosascript\b|\bautomator\b|\bshortcuts\s+run\b/, 'control other apps'],
  ['inline-code', /\b(eval|exec)\b|\|\s*(sh|bash|zsh)\b|\b(sh|bash|zsh|python3?|node|ruby|perl)\s+-[ce]\b/, 'run inline code that I cannot check'],
];

const SECRET_PATHS = [
  '.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.docker/config.json', 'Library/Keychains',
  '.claude-avatar/mcp', '.claude-avatar/mcp.json', '.claude-avatar/voiceprint.json', '.claude-avatar/config.json',
];
const PROTECTED_PATHS = [
  ...SECRET_PATHS,
  '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md',
  '.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.gitconfig',
  'Library/LaunchAgents',
];
const SYSTEM_PREFIXES = ['/etc', '/System', '/Library', '/usr', '/bin', '/sbin', '/private/etc', '/Applications'];

// MCP tool names: deletes, and other changes outside the Mac (Slack, Jira, GitHub, Figma, ...).
const MCP_DELETE = /(delete|remove|archive|destroy|purge)/i;
const MCP_WRITE = /(create|update|send|post|comment|publish|write|edit|transition|merge|upload|add|move|reply|react|schedule|execute|share|invite|use_figma)/i;
const FERN_SAFE_TOOLS = new Set(['list_sessions', 'read_session_output', 'find_project', 'start_job', 'get_job', 'cancel_job']);

function resolvePath(p, cwd) {
  if (typeof p !== 'string' || !p) return undefined;
  const expanded = p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
  return path.resolve(cwd ?? HOME, expanded);
}

function isUnder(file, base) {
  return file === base || file.startsWith(`${base}${path.sep}`);
}

function matchesHomePath(file, list) {
  return list.some((rel) => isUnder(file, path.join(HOME, rel)));
}

function isSecretFile(file) {
  return matchesHomePath(file, SECRET_PATHS) || /(^|\/)\.env(\.|$)/.test(file) || /\.(pem|key|p12)$/.test(file);
}

function lineCount(text) {
  return String(text ?? '').split('\n').length;
}

/** Lines in an existing file, or 0 when it does not exist or is too large to read. */
function existingLines(file) {
  try {
    if (fs.statSync(file).size > MAX_SCAN_BYTES) return Infinity;
    return lineCount(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
}

/** Every group that the tool call belongs to, as [{ group, reason }]. */
function findGroups(toolName, input, { cwd, isJob, largeChangeLines }) {
  const found = [];
  const add = (group, reason) => found.push({ group, reason });

  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    for (const [group, pattern, reason] of COMMANDS) if (pattern.test(command)) add(group, reason);
    if (SECRET_PATHS.some((rel) => command.includes(rel)) || /(^|[\s/'"])\.env\b/.test(command)) add('secrets', 'touch files that hold secrets');
    return found;
  }

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const file = resolvePath(input.file_path ?? input.notebook_path, cwd);
    if (!file) return found;
    if (isSecretFile(file) || matchesHomePath(file, PROTECTED_PATHS)) add('secrets', `change a protected file (${file})`);
    if (SYSTEM_PREFIXES.some((p) => isUnder(file, p)) || !isUnder(file, HOME)) add('secrets', `write outside your home folder (${file})`);
    if (isJob && cwd && !isUnder(file, cwd)) add('secrets', `write outside the job's project (${file})`);
    if (toolName === 'Write') {
      const lines = existingLines(file);
      if (lines >= largeChangeLines) add('large-change', `overwrite ${file} (${lines === Infinity ? 'a very large file' : `${lines} lines`})`);
    } else {
      const edits = toolName === 'MultiEdit' ? (input.edits ?? []) : [input];
      const replaced = edits.reduce((sum, e) => sum + (e?.old_string ? lineCount(e.old_string) : 0), 0);
      if (replaced >= largeChangeLines) add('large-change', `replace ${replaced} lines in ${file}`);
    }
    return found;
  }

  if (['Read', 'Glob', 'Grep'].includes(toolName)) {
    const file = resolvePath(input.file_path ?? input.path, cwd);
    if (file && isSecretFile(file)) add('secrets', `read a file that holds secrets (${file})`);
    return found;
  }

  if (toolName === 'SendMessage') add('messages', 'send a message to another Claude session');

  const mcp = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    const [, server, name] = mcp;
    if (server === 'fern' && FERN_SAFE_TOOLS.has(name)) return found;
    if (MCP_DELETE.test(name)) add('delete', `delete something through ${server} (${name})`);
    else if (MCP_WRITE.test(name)) add('messages', `make a change through ${server} (${name})`);
  }
  return found;
}

/**
 * Decides if a tool call needs the owner's confirmation.
 * `groups` are the groups that ask (config confirmActions). `cwd` is the caller's
 * folder; jobs may only write inside it. Returns { critical, reason, group }.
 * The reason completes "… wants to <reason>".
 */
function check(toolName, input = {}, { cwd, isJob = false, groups = ['delete', 'large-change'], largeChangeLines = 300 } = {}) {
  // A hand-edited config can hold a bad value. Then the safe default applies.
  const enabled = new Set(Array.isArray(groups) ? groups : ['delete', 'large-change']);
  const hit = findGroups(toolName, input, { cwd, isJob, largeChangeLines }).find((f) => enabled.has(f.group));
  return hit ? { critical: true, reason: hit.reason, group: hit.group } : { critical: false, reason: '', group: '' };
}

/** One line that shows the user what the tool call does. */
function describe(toolName, input = {}) {
  if (toolName === 'Bash') return `$ ${String(input.command ?? '').slice(0, 400)}`;
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (file) return `${toolName} ${file}`;
  return `${toolName} ${JSON.stringify(input).slice(0, 300)}`;
}

module.exports = { GROUPS, check, describe };
