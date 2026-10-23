const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.claude-avatar');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  port: 47823,
  terminalApp: 'Terminal',
  voice: 'Samantha',
  rate: 190,
  quietMode: false,
  speakWhenTerminalFocused: false,
  speakOnSessionStart: false,
  summarizeWithClaude: false,
  scale: 3,
  position: null,
  spritesDir: 'sprites/default',
  phrases: {
    greet: 'Claude is ready in {project}.',
    attention: '{project} needs you. {message}',
    done: 'Claude finished in {project}. {summary}',
  },
  // An empty folder, so every file outside it goes through Fern's permission check.
  assistantCwd: path.join(CONFIG_DIR, 'workspace'),
  claudePath: 'claude',
  whisperPath: 'whisper-cli',
  whisperModel: path.join(CONFIG_DIR, 'models', 'ggml-base.en.bin'),
  whisperLanguage: 'en',
  listenForWakeWord: true,
  wakeWords: ['fern', 'firn', 'fearn', 'ferne'],
  speakerModel: path.join(CONFIG_DIR, 'models', 'wespeaker_en_voxceleb_resnet34.onnx'),
  voiceMatchThreshold: 0.6,
  voiceFeedback: true,
  phraseEndSilenceMs: 1500,
  classifierModel: 'haiku',
  // Must stay under MCP_TOOL_TIMEOUT (10 minutes) in lib/assistant.js.
  approvalTimeoutSeconds: 300,
  // Groups that ask first (see lib/guard.js GROUPS): delete, large-change, publish, network,
  // system, inline-code, secrets, messages.
  confirmActions: ['delete', 'large-change'],
  largeChangeLines: 300,
  // After this many Allows of the same exact action, Fern stops asking for it. 0 turns it off.
  learnAfterApprovals: 3,
  ttsEngine: 'say',
  kokoroDir: path.join(CONFIG_DIR, 'models', 'kokoro-multi-lang-v1_0'),
  kokoroVoice: 'jf_alpha',
  kokoroSpeed: 1,
  panelShortcut: 'CommandOrControl+Shift+K',
  speakTypedReplies: false,
  projectRoots: ['~/personal', '~/work'],
  jobPermissionMode: '',
  jobTimeoutMinutes: 30,
  // Fern only. Empty means the Claude default. Set with /model and /effort in the panel.
  fernModel: '',
  fernEffort: '',
  checkClaudeUpdates: true,
};

let current = structuredClone(DEFAULTS);
const listeners = new Set();

/** Merges a parsed file over the defaults. Unknown keys stay, so user notes survive. */
function merge(parsed) {
  return {
    ...DEFAULTS,
    ...parsed,
    phrases: { ...DEFAULTS.phrases, ...(parsed.phrases ?? {}) },
  };
}

/** Reads the config file. Creates it with defaults when it does not exist. */
function load() {
  try {
    current = merge(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') {
      current = structuredClone(DEFAULTS);
      save(current);
    } else {
      console.warn(`[config] Cannot read ${CONFIG_FILE}: ${err.message}. Using last good config.`);
    }
  }
  return current;
}

function save(next) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

function get() {
  return current;
}

/** Applies a partial change, writes it to disk, and tells listeners. */
function update(patch) {
  current = merge({ ...current, ...patch });
  save(current);
  listeners.forEach((fn) => fn(current));
}

/** Reloads the file when it changes on disk, for example after a manual edit. */
function watch(onChange) {
  listeners.add(onChange);
  let timer;
  fs.watch(CONFIG_DIR, (_type, name) => {
    if (name !== path.basename(CONFIG_FILE)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const before = JSON.stringify(current);
      load();
      if (JSON.stringify(current) !== before) listeners.forEach((fn) => fn(current));
    }, 200);
  });
}

module.exports = { CONFIG_DIR, CONFIG_FILE, load, get, update, watch };
