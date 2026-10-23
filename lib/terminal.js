const { execFile } = require('child_process');

const MAX_ANCESTORS = 4;
const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

function ps(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], { timeout: 1000 }, (err, out) => {
      if (err) return resolve(undefined);
      const m = out.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      resolve(m && { ppid: Number(m[1]), tty: m[2], comm: m[3] });
    });
  });
}

/**
 * Finds the `claude` process and its terminal, from the pid that the hook sent.
 * The hook's parent can be a shell, so a few ancestors are checked.
 * Returns { pid, tty } or undefined.
 */
async function resolveSessionProcess(hookParentPid) {
  let pid = hookParentPid;
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const info = await ps(pid);
    if (!info) return undefined;
    if (info.tty !== '??' && /claude/i.test(info.comm)) return { pid, tty: `/dev/${info.tty}` };
    pid = info.ppid;
  }
  return undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function osascript(lines, args) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', lines.join('\n'), ...args], { timeout: 5000 }, (err, out) => {
      resolve(err ? undefined : out.trim());
    });
  });
}

// Values go in as osascript arguments, never inside the script source.
const FOCUS_SCRIPTS = {
  Terminal: [
    'on run argv',
    '  tell application "Terminal"',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    '        if tty of t is (item 1 of argv) then',
    '          set selected of t to true',
    '          set index of w to 1',
    '          activate',
    '          return "found"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  return "missing"',
    'end run',
  ],
  iTerm2: [
    'on run argv',
    '  tell application "iTerm2"',
    '    repeat with w in windows',
    '      repeat with t in tabs of w',
    '        repeat with s in sessions of t',
    '          if tty of s is (item 1 of argv) then',
    '            select w',
    '            select t',
    '            select s',
    '            activate',
    '            return "found"',
    '          end if',
    '        end repeat',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  return "missing"',
    'end run',
  ],
};

const OPEN_SCRIPTS = {
  Terminal: [
    'on run argv',
    '  tell application "Terminal"',
    '    do script ("cd " & quoted form of (item 1 of argv) & " && claude --resume " & quoted form of (item 2 of argv))',
    '    activate',
    '  end tell',
    'end run',
  ],
  iTerm2: [
    'on run argv',
    '  tell application "iTerm2"',
    '    set w to (create window with default profile)',
    '    tell current session of w to write text ("cd " & quoted form of (item 1 of argv) & " && claude --resume " & quoted form of (item 2 of argv))',
    '    activate',
    '  end tell',
    'end run',
  ],
};

/** Brings the tab with this tty to the front. Returns true when it was found. */
async function focusTty(terminalApp, tty) {
  const script = FOCUS_SCRIPTS[terminalApp];
  if (!script || !tty) return false;
  return (await osascript(script, [tty])) === 'found';
}

/** Opens a new terminal window that resumes the session in its folder. */
async function openSession(terminalApp, cwd, sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error('Bad session id');
  const script = OPEN_SCRIPTS[terminalApp];
  if (!script) throw new Error(`Opening a session is not supported in ${terminalApp}. Use Terminal or iTerm2.`);
  await osascript(script, [cwd, sessionId]);
}

module.exports = { resolveSessionProcess, isAlive, focusTty, openSession };
