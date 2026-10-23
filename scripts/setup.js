#!/usr/bin/env node
// Sets up everything that `npm install` does not: Claude Code check, whisper.cpp,
// the voice models, the hooks, and (optional) a `fern` shell command.
// Asks before each change. `--yes` answers yes to every question.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { EVENTS, SETTINGS_FILE, readSettings, isOurHook } = require('./hooks-common');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(os.homedir(), '.claude-avatar');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MODELS_DIR = path.join(CONFIG_DIR, 'models');
const ZSHRC = path.join(os.homedir(), '.zshrc');
const isYesToAll = process.argv.includes('--yes');
const MIN_NODE_MAJOR = 18;

const MODELS = [
  {
    name: 'whisper speech-to-text model (ggml-base.en.bin, about 150 MB)',
    target: path.join(MODELS_DIR, 'ggml-base.en.bin'),
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  },
  {
    name: 'speaker model for voice ID (about 26 MB)',
    target: path.join(MODELS_DIR, 'wespeaker_en_voxceleb_resnet34.onnx'),
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx',
  },
  {
    name: 'Kokoro neural voice (about 350 MB download, 400 MB on disk)',
    target: path.join(MODELS_DIR, 'kokoro-multi-lang-v1_0', 'model.onnx'),
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
    isArchive: true,
  },
];

const ok = (text) => console.log(`  ✓ ${text}`);
const todo = (text) => console.log(`  ✗ ${text}`);
const note = (text) => console.log(`    ${text}`);
const results = { done: [], skipped: [] };

const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;

/** Asks a yes/no question. Without a terminal (and without --yes), the answer is no. */
async function ask(question) {
  if (isYesToAll) {
    console.log(`  ? ${question} [y/N] y (--yes)`);
    return true;
  }
  if (!rl) {
    console.log(`  ? ${question} [y/N] n (no terminal, run again in a terminal to answer)`);
    return false;
  }
  const answer = await new Promise((resolve) => rl.question(`  ? ${question} [y/N] `, resolve));
  return /^y(es)?$/i.test(answer.trim());
}

/** Runs a command with its output shown. Arguments are never passed through a shell. */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  return result.status === 0;
}

/** Finds a command on PATH or in the usual install folders. */
function which(cmd) {
  const dirs = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  return dirs.map((d) => path.join(d, cmd)).find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function section(title) {
  console.log(`\n${title}`);
}

async function checkSystem() {
  section('1. System');
  if (process.platform !== 'darwin') {
    todo('This app runs on macOS only.');
    process.exit(1);
  }
  ok(`macOS ${os.release()}`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    todo(`Node.js ${process.versions.node} is too old. Install Node ${MIN_NODE_MAJOR} or newer.`);
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}`);
}

async function checkPackages() {
  section('2. npm packages');
  const missing = ['electron', 'sherpa-onnx-node', 'pngjs'].filter((p) => !fs.existsSync(path.join(ROOT, 'node_modules', p)));
  if (!missing.length) return ok('electron, sherpa-onnx-node, pngjs');
  todo(`Missing: ${missing.join(', ')}`);
  if (await ask('Run npm install now?')) {
    if (run('npm', ['install'], { cwd: ROOT })) results.done.push('npm install');
    else todo('npm install failed. See the output above.');
  } else {
    results.skipped.push('npm install');
  }
}

async function checkClaude() {
  section('3. Claude Code');
  const claude = which('claude');
  if (!claude) {
    todo('The claude CLI is not installed.');
    note('Install Claude Code (https://docs.anthropic.com/claude-code), run `claude` once, and log in.');
    note('Fern uses the account that the claude CLI is logged in with.');
    results.skipped.push('Claude Code');
    return;
  }
  ok(`claude found: ${claude}`);
  note('Make sure you ran `claude` once and logged in. Fern uses that account.');
}

async function checkWhisper() {
  section('4. whisper.cpp (speech-to-text)');
  if (which('whisper-cli')) return ok('whisper-cli found');
  const brew = which('brew');
  if (!brew) {
    todo('whisper-cli and Homebrew are not installed.');
    note('Install Homebrew (https://brew.sh), then run: brew install whisper-cpp');
    results.skipped.push('whisper.cpp');
    return;
  }
  todo('whisper-cli is not installed.');
  if (await ask('Run brew install whisper-cpp now?')) {
    if (run(brew, ['install', 'whisper-cpp'])) results.done.push('whisper.cpp');
    else todo('brew install failed. See the output above.');
  } else {
    results.skipped.push('whisper.cpp');
  }
}

/** Downloads to a temporary name first, so a stopped download never looks complete. */
function download(url, target) {
  const partial = `${target}.partial`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const isOk = run('curl', ['-L', '--fail', '--progress-bar', '-o', partial, url]);
  if (!isOk) {
    fs.rmSync(partial, { force: true });
    return undefined;
  }
  return partial;
}

async function checkModels() {
  section('5. Voice models (in ~/.claude-avatar/models)');
  for (const model of MODELS) {
    if (fs.existsSync(model.target)) {
      ok(model.name);
      continue;
    }
    todo(`${model.name} is missing.`);
    if (!(await ask(`Download the ${model.name}?`))) {
      results.skipped.push(model.name);
      continue;
    }
    if (model.isArchive) {
      const archive = download(model.url, path.join(MODELS_DIR, path.basename(model.url)));
      if (!archive) {
        todo('Download failed.');
        continue;
      }
      const isExtracted = run('tar', ['xjf', archive, '-C', MODELS_DIR]);
      fs.rmSync(archive, { force: true });
      if (isExtracted && fs.existsSync(model.target)) results.done.push(model.name);
      else todo('Could not unpack the archive.');
    } else {
      const partial = download(model.url, model.target);
      if (!partial) {
        todo('Download failed.');
        continue;
      }
      fs.renameSync(partial, model.target);
      results.done.push(model.name);
    }
  }
}

async function checkVoice() {
  section('6. Fern\'s voice');
  const kokoroModel = MODELS.find((m) => m.isArchive).target;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // No config yet. The app creates the rest with defaults on first launch.
  }
  if (cfg.ttsEngine === 'kokoro') return ok('Kokoro voice is on.');
  if (!fs.existsSync(kokoroModel)) return note('Kokoro is not installed, so Fern uses the macOS `say` voice.');
  if (await ask('Use the Kokoro voice jf_alpha (anime-like, Japanese accent)?')) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...cfg, ttsEngine: 'kokoro', kokoroVoice: cfg.kokoroVoice ?? 'jf_alpha' }, null, 2)}\n`);
    results.done.push('Kokoro voice in config');
  }
}

async function checkHooks() {
  section('7. Claude Code hooks');
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    todo(err.message);
    results.skipped.push('hooks');
    return;
  }
  const missing = EVENTS.filter((event) => !(settings.hooks?.[event] ?? []).some((g) => (g.hooks ?? []).some(isOurHook)));
  if (!missing.length) return ok(`All ${EVENTS.length} hooks are in ${SETTINGS_FILE}`);
  todo(`Missing hooks: ${missing.join(', ')}`);
  note(`This changes ${SETTINGS_FILE}. A backup is made first. Undo with: npm run uninstall-hooks`);
  if (await ask('Install the hooks now?')) {
    if (run(process.execPath, [path.join(__dirname, 'install-hooks.js')])) results.done.push('hooks');
  } else {
    results.skipped.push('hooks');
  }
}

/** The same start/stop/status command as in the README, for this folder. */
function fernFunction() {
  const pattern = `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `
# Start, stop, or check Fern (added by npm run setup). Start runs detached from the terminal.
fern() {
  local app_pattern='${pattern} \\.$'
  case "\${1:-start}" in
    start)
      if pgrep -f "$app_pattern" >/dev/null; then
        echo "Fern is already running."
      else
        (cd '${ROOT}' && nohup npm start >/tmp/fern.log 2>&1 &)
        echo "Fern started. Log: /tmp/fern.log"
      fi
      ;;
    stop)
      if pkill -f "$app_pattern"; then
        pkill -f 'claude -p .*--name Fern'
        echo "Fern stopped."
      else
        echo "Fern is not running."
      fi
      ;;
    status)
      pgrep -f "$app_pattern" >/dev/null && echo "Fern is running." || echo "Fern is not running."
      ;;
    *)
      echo "Usage: fern [start|stop|status]"
      return 1
      ;;
  esac
}
`;
}

async function checkShellCommand() {
  section('8. `fern` shell command (optional)');
  let zshrc = '';
  try {
    zshrc = fs.readFileSync(ZSHRC, 'utf8');
  } catch {
    // No ~/.zshrc yet.
  }
  if (/^\s*fern\s*\(\)/m.test(zshrc)) return ok('A fern() command is already in ~/.zshrc');
  note('Adds fern / fern stop / fern status to the end of ~/.zshrc.');
  if (await ask('Add the fern command to ~/.zshrc?')) {
    fs.appendFileSync(ZSHRC, fernFunction());
    results.done.push('fern command in ~/.zshrc (open a new terminal tab to use it)');
  } else {
    results.skipped.push('fern command');
  }
}

async function main() {
  console.log(`Fern setup (${ROOT})${isYesToAll ? ' --yes' : ''}`);
  await checkSystem();
  await checkPackages();
  await checkClaude();
  await checkWhisper();
  await checkModels();
  await checkVoice();
  await checkHooks();
  await checkShellCommand();
  rl?.close();

  section('Summary');
  if (results.done.length) results.done.forEach((d) => ok(`Done: ${d}`));
  if (results.skipped.length) results.skipped.forEach((s) => todo(`Skipped: ${s}`));
  if (!results.done.length && !results.skipped.length) ok('Everything is ready.');
  section('Next');
  note('1. Start Fern: npm start (or fern, if you added the command).');
  note('2. Restart your Claude Code sessions, so they load the hooks.');
  note('3. Tray menu > Set up my voice… and read the 3 sentences.');
  note('4. Allow Microphone and Automation when macOS asks.');
}

main().catch((err) => {
  rl?.close();
  console.error(`Setup stopped: ${err.message}`);
  process.exit(1);
});
