const { execFile, spawn } = require('child_process');
const kokoro = require('./kokoro');

const MAX_QUEUE = 3;
const REPEAT_WINDOW_MS = 20 * 1000;

/** Returns the name of the frontmost app, or undefined when the check fails. */
function frontmostApp() {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 1000 },
      (err, stdout) => resolve(err ? undefined : stdout.trim()),
    );
  });
}

/** Lists `say` voices, English voices first. */
function listVoices() {
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      const voices = stdout.split('\n').map((line) => {
        const m = line.match(/^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s/);
        return m && { name: m[1].trim(), lang: m[2] };
      }).filter(Boolean);
      const english = voices.filter((v) => v.lang.startsWith('en'));
      const others = voices.filter((v) => !v.lang.startsWith('en'));
      resolve([...english, ...others]);
    });
  });
}

/**
 * Speech queue on top of macOS `say`. One utterance at a time.
 * `getConfig` is read on every utterance so tray changes apply at once.
 */
function createSpeech({ getConfig, onStart, onEnd }) {
  const queue = [];
  const recent = new Map();
  let child;
  let isBusy = false;
  // Increases on stop(), so a voice that is still being generated is not played.
  let stopCount = 0;
  let hasWarnedFrontmost = false;
  let hasWarnedKokoro = false;

  function isRepeat(item) {
    const key = `${item.sessionId}\u0000${item.text}`;
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > REPEAT_WINDOW_MS) recent.delete(k);
    if (recent.has(key)) return true;
    recent.set(key, now);
    return false;
  }

  async function shouldSpeak(item) {
    const cfg = getConfig();
    if (cfg.quietMode && !item.force) return false;
    if (item.force || item.kind === 'reply' || cfg.speakWhenTerminalFocused) return true;
    const front = await frontmostApp();
    if (front === undefined) {
      if (!hasWarnedFrontmost) {
        hasWarnedFrontmost = true;
        console.warn('[speech] Frontmost app check failed. Grant Automation permission for System Events. Speaking anyway.');
      }
      return true;
    }
    return front.toLowerCase() !== cfg.terminalApp.toLowerCase();
  }

  /** Returns the command that plays `text`. Kokoro first when it is on, `say` when it fails. */
  async function playCommand(text) {
    const cfg = getConfig();
    if (cfg.ttsEngine === 'kokoro') {
      try {
        const { file, cleanup } = await kokoro.synthesize(cfg, text);
        return { cmd: 'afplay', args: [file], cleanup };
      } catch (err) {
        if (!hasWarnedKokoro) {
          hasWarnedKokoro = true;
          console.warn(`[speech] Kokoro failed: ${err.message}. Using say.`);
        }
      }
    }
    const args = ['-r', String(cfg.rate)];
    if (cfg.voice) args.push('-v', cfg.voice);
    args.push('--', text);
    return { cmd: 'say', args, cleanup: async () => {} };
  }

  function play({ cmd, args }) {
    return new Promise((resolve) => {
      child = spawn(cmd, args, { stdio: 'ignore' });
      onStart();
      const finish = () => {
        if (!child) return;
        child = undefined;
        onEnd();
        resolve();
      };
      child.on('exit', finish);
      child.on('error', finish);
    });
  }

  async function next() {
    if (isBusy || queue.length === 0) return;
    isBusy = true;
    const item = queue.shift();
    try {
      if (await shouldSpeak(item)) {
        const stopsBefore = stopCount;
        const command = await playCommand(item.text);
        if (stopCount === stopsBefore) await play(command);
        await command.cleanup();
      }
    } catch (err) {
      console.warn(`[speech] ${err.message}`);
    } finally {
      isBusy = false;
    }
    next();
  }

  return {
    /** Adds text. kind: 'attention' jumps the queue; 'done' items are dropped first. */
    say(text, { kind = 'info', sessionId = '', force = false } = {}) {
      const item = { text, kind, sessionId, force };
      if (!force && isRepeat(item)) return;
      if (kind === 'attention' || force) queue.unshift(item);
      else queue.push(item);
      while (queue.length > MAX_QUEUE) {
        const doneIndex = queue.findIndex((q) => q.kind === 'done');
        queue.splice(doneIndex >= 0 ? doneIndex : 0, 1);
      }
      next();
    },
    stop() {
      queue.length = 0;
      stopCount++;
      child?.kill();
    },
  };
}

module.exports = { createSpeech, listVoices, frontmostApp };
