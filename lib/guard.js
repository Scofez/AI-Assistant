const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Bash patterns that need the owner's OK. Best effort: a command can hide its
// intent, so inline code and pipes into a shell also count as critical.
const CRITICAL_COMMANDS = [
  [/\bgit\s+push\b/, 'push to a remote Git repository'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|branch\s+-D|tag\s+-d|filter-branch|rebase)\b/, 'rewrite or delete Git history'],
  [/\bgh\s+(?!(?:\S+\s+)?(?:view|list|status|diff|checks|search)\b)\S+/, 'change something on GitHub'],
  [/\b(rm|rmdir|unlink|trash|shred|srm)\b|\s-delete\b/, 'delete files or folders'],
  [/\bmv\b/, 'move or rename files'],
  [/\bsudo\b|\bsu\s/, 'run a command as administrator'],
  [/\bcurl\b[^|;&]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|\s-F\s|--form|--upload-file|-T\s)/i, 'send data to the internet'],
  [/\b(wget|scp|sftp|ftp|rsync|ssh|nc|telnet)\b/, 'transfer data over the network'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\b(gcloud|aws|az|kubectl|terraform|vercel|netlify|heroku|firebase)\b/, 'publish or change cloud resources'],
  [/\b(brew|pip3?|gem|cargo)\s+(install|uninstall|remove)\b|\bnpm\s+(i|install)\s+(-g|--global)\b/, 'install or remove software'],
  [/\b(kill|killall|pkill|launchctl|shutdown|reboot|halt|diskutil|dd|mkfs|chmod|chown|csrutil|spctl|systemsetup|pmset|tmutil)\b/, 'change the system or stop processes'],
  [/\bdefaults\s+(write|delete)\b|\bsecurity\s/, 'change system settings or the keychain'],
  [/\bosascript\b|\bautomator\b|\bshortcuts\s+run\b/, 'control other apps'],
  [/\bcrontab\b/, 'change scheduled tasks'],
  [/\b(eval|exec)\b|\|\s*(sh|bash|zsh)\b|\b(sh|bash|zsh|python3?|node|ruby|perl|osascript)\s+-[ce]\b/, 'run inline code that I cannot check'],
];

// Places where a write, or a read of secrets, needs the owner's OK.
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

// MCP tool names that change something outside the Mac (Slack, Jira, GitHub, Figma, ...).
const MCP_WRITE = /(create|update|delete|remove|send|post|comment|publish|write|edit|transition|merge|upload|add|move|archive|reply|react|schedule|execute|share|invite|use_figma)/i;
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

/**
 * Decides if a tool call needs the owner's confirmation.
 * `cwd` is the caller's project folder. Jobs may only write inside it.
 * Returns { critical, reason }. The reason completes "I need your OK to …".
 */
function check(toolName, input = {}, { cwd, isJob = false } = {}) {
  const ok = { critical: false, reason: '' };

  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    for (const [pattern, reason] of CRITICAL_COMMANDS) {
      if (pattern.test(command)) return { critical: true, reason };
    }
    if (SECRET_PATHS.some((rel) => command.includes(rel)) || /(^|[\s/'"])\.env\b/.test(command)) {
      return { critical: true, reason: 'touch files that hold secrets' };
    }
    return ok;
  }

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const file = resolvePath(input.file_path ?? input.notebook_path, cwd);
    if (!file) return ok;
    if (isSecretFile(file) || matchesHomePath(file, PROTECTED_PATHS)) return { critical: true, reason: `change a protected file (${file})` };
    if (SYSTEM_PREFIXES.some((p) => isUnder(file, p)) || !isUnder(file, HOME)) return { critical: true, reason: `write outside your home folder (${file})` };
    if (isJob && cwd && !isUnder(file, cwd)) return { critical: true, reason: `write outside the job's project (${file})` };
    return ok;
  }

  if (['Read', 'Glob', 'Grep'].includes(toolName)) {
    const file = resolvePath(input.file_path ?? input.path, cwd);
    if (file && isSecretFile(file)) return { critical: true, reason: `read a file that holds secrets (${file})` };
    return ok;
  }

  if (toolName === 'SendMessage') return { critical: true, reason: 'send a message to another Claude session' };

  const mcp = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    const [, server, name] = mcp;
    if (server === 'fern' && FERN_SAFE_TOOLS.has(name)) return ok;
    if (MCP_WRITE.test(name)) return { critical: true, reason: `make a change through ${server} (${name})` };
    return ok;
  }

  return ok;
}

/** One line that shows the user what the tool call does. */
function describe(toolName, input = {}) {
  if (toolName === 'Bash') return `$ ${String(input.command ?? '').slice(0, 400)}`;
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (file) return `${toolName} ${file}`;
  return `${toolName} ${JSON.stringify(input).slice(0, 300)}`;
}

module.exports = { check, describe };
