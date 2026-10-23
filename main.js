const { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, systemPreferences, Tray } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const config = require('./lib/config');
const { createStateMachine } = require('./lib/state');
const { createSpeech, listVoices } = require('./lib/speech');
const { lastAssistantText, sentences, sessionTitle } = require('./lib/transcript');
const { classifyPhrase, createAssistant, summarizeWithClaude, transcribe } = require('./lib/assistant');
const voiceprint = require('./lib/voiceprint');
const kokoro = require('./lib/kokoro');
const { createJobs, describeToolCall } = require('./lib/jobs');
const { createFernTools } = require('./lib/fern-tools');
const fernHistory = require('./lib/fern-history');
const { MCP_CONFIG_FILE, newToken, writeMcpConfig, createMcpHandler } = require('./lib/mcp');
const guard = require('./lib/guard');
const terminal = require('./lib/terminal');

const MAX_BODY = 1024 * 1024;
const BUBBLE_SPACE = 120;
const SIDE_SPACE = 40;
const MIN_WIDTH = 280;
const MARGIN = 24;
// Fern's own activity drives the animation, but she is not a Claude Code session.
// This key is never listed to her as one.
const FERN_SELF = '__fern__';
// Mini avatars left of Fern: one per Claude session, subagent, and Fern job.
const MINI_SLOT_WIDTH = 92;
const MAX_MINIS = 8;
const CROWD_THROTTLE_MS = 150;
const PRUNE_INTERVAL_MS = 30 * 1000;
const STALE_AGENT_MS = 60 * 60 * 1000;
const FINISHED_JOB_VISIBLE_MS = 10 * 1000;
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const PANEL_WIDTH = 640;
const PANEL_HEIGHT = 380;
const STATE_BY_EVENT = {
  SessionStart: 'greet', UserPromptSubmit: 'thinking', PreToolUse: 'working', PostToolUse: 'thinking', Notification: 'attention', Stop: 'done',
};
const FOLLOW_UP_MS = 8000;
const HINT_INTERVAL_MS = 2 * 60 * 1000;
const MIN_ENROLL_SECONDS = 1.5;
const ENROLL_TIMEOUT_MS = 90 * 1000;
const ENROLL_SENTENCES = [
  'Fern, please check whether the tests are passing.',
  'The quick brown fox jumps over the lazy dog near the river.',
  'Tell me when Claude is done, and keep the summary short.',
];

let win;
let panel;
let tray;
let mcpHandler;
let voices = [];
let manifest;
let dragOrigin;
let crowdWidth = 0;
let crowdTimer;
// Set while the user reads the enrollment sentences.
let enrollment;
// After a bare "Fern", the next phrase from the same voice is the command.
let followUpUntil = 0;
let hasShownEnrollHint = false;
let lastHintAt = 0;
let hasWarnedSpeaker = false;
let heardQueue = Promise.resolve();

const send = (channel, data) => {
  if (win && !win.isDestroyed() && !win.webContents.isCrashed()) win.webContents.send(channel, data);
};
const bubble = (who, text) => send('bubble', { who, text });
/** Adds a line to the Fern terminal panel. The panel keeps its history in memory only. */
const sendPanel = (channel, data) => {
  if (panel && !panel.isDestroyed() && !panel.webContents.isCrashed()) panel.webContents.send(channel, data);
};
// `tab` is 'fern' for Fern's own chat, or a job id for that job's tab.
const panelLine = (who, text, tab = 'fern') => sendPanel('panel:line', { who, text, tab });
const jobTab = (job) => sendPanel('panel:tab', { id: job.id, title: `Fern #${job.number} · ${job.project}`, status: job.status });
let isQuitting = false;

/** Logs why a page stopped, then loads it again. */
function reloadWhenGone(window, name) {
  window.webContents.on('render-process-gone', (_e, { reason, exitCode }) => {
    console.warn(`[${name}] Page stopped: ${reason} (exit code ${exitCode}). Reloading.`);
    if (reason !== 'clean-exit') setTimeout(() => !window.isDestroyed() && window.webContents.reload(), 1000);
  });
}
let pendingAsks = 0;
const setPanelBusy = (delta) => {
  pendingAsks += delta;
  sendPanel('panel:busy', pendingAsks > 0);
};
/** Shows a message in the bubble and in the panel. */
const tell = (who, text) => {
  bubble(who, text);
  panelLine(who, text);
};

// Live Claude Code sessions, from hook events. Memory only.
const sessions = new Map();

const state = createStateMachine((name) => send('state', name));
const speech = createSpeech({
  getConfig: config.get,
  onStart: () => send('speaking', true),
  onEnd: () => send('speaking', false),
});
const assistant = createAssistant(config.get, () => MCP_CONFIG_FILE);
const mcpToken = newToken();
const jobs = createJobs({
  getConfig: config.get,
  mcpConfigFor: (id) => {
    const file = writeMcpConfig({
      port: config.get().port, token: mcpToken, caller: `job:${id}`, file: path.join(config.CONFIG_DIR, 'mcp', `job-${id}.json`),
    });
    return { file, cleanup: () => fs.rmSync(file, { force: true }) };
  },
  onLog: (job, { who, text }) => panelLine(who, text, job.id),
  onChange: (job) => {
    jobTab(job);
    scheduleCrowd();
    if (job.status !== 'running') setTimeout(scheduleCrowd, FINISHED_JOB_VISIBLE_MS + 100);
    const key = `job:${job.id}`;
    if (job.status === 'running') state.handle('PreToolUse', key);
    else if (job.status === 'cancelled') state.handle('SessionEnd', key);
    else state.handle('Stop', key);
  },
  onFinish: (job) => {
    const summary = job.result ? sentences(job.result, 1, 160) : '';
    // Human line for the bubble and the voice. Technical record for the panel.
    const spoken = (job.status === 'done'
      ? `The ${job.title} job in ${job.project} is finished. ${summary}`
      : `The ${job.title} job in ${job.project} did not work. ${summary}`).trim();
    bubble('fern', spoken);
    const record = `job ${job.id} ${job.status} · ${job.cwd} · ${Math.round((job.endedAt - job.startedAt) / 1000)}s`;
    panelLine('job', `${record}\n${(job.result ?? '').slice(0, 2000)}`, job.id);
    panelLine('job', `${record} · Fern #${job.number}`);
    speech.say(spoken, { kind: job.status === 'done' ? 'done' : 'attention', sessionId: `job:${job.id}` });
  },
});

// ---------------------------------------------------------------------------
// Window

function packDir(cfg) {
  return path.resolve(__dirname, cfg.spritesDir);
}

function loadManifest(cfg) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packDir(cfg), 'manifest.json'), 'utf8'));
  } catch (err) {
    console.warn(`[sprites] Cannot read manifest in ${cfg.spritesDir}: ${err.message}. Run npm run sprites.`);
    return { frameWidth: 64, frameHeight: 64, states: {} };
  }
}

function windowSize(cfg) {
  const scale = Math.max(1, Math.round(cfg.scale));
  const charW = manifest.frameWidth * scale;
  return {
    width: Math.max(MIN_WIDTH, charW + 2 * SIDE_SPACE),
    height: manifest.frameHeight * scale + BUBBLE_SPACE,
  };
}

/** Uses the saved position when it is on a screen. Otherwise the bottom-right corner. */
function initialPosition(cfg, { width, height }) {
  const pos = cfg.position;
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    const cx = pos.x + width / 2;
    const cy = pos.y + height / 2;
    const isVisible = screen.getAllDisplays().some(({ workArea: a }) => (
      cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height));
    if (isVisible) return pos;
  }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - width - MARGIN,
    y: workArea.y + workArea.height - height - MARGIN,
  };
}

function setupPayload(cfg) {
  return {
    manifest,
    baseUrl: `${pathToFileURL(packDir(cfg)).href}/`,
    scale: Math.max(1, Math.round(cfg.scale)),
    fernWidth: windowSize(cfg).width,
    miniSlotWidth: MINI_SLOT_WIDTH,
  };
}

function createWindow() {
  const cfg = config.get();
  manifest = loadManifest(cfg);
  const size = windowSize(cfg);
  const { x, y } = initialPosition(cfg, size);
  win = new BrowserWindow({
    ...size,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // One level above the panel, so a zoomed panel never covers Fern.
  win.setAlwaysOnTop(true, 'floating', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  reloadWhenGone(win, 'avatar');
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => {
    send('setup', setupPayload(config.get()));
    send('state', state.current());
    sendListen();
    send('crowd', buildCrowd());
  });
}

/** Sizes the window for Fern plus the mini avatars. Fern's right edge and feet stay in place. */
function fitWindow(cfg) {
  if (!win || win.isDestroyed()) return;
  const fern = windowSize(cfg);
  const width = fern.width + crowdWidth;
  const { x, y, width: w, height: h } = win.getBounds();
  if (w === width && h === fern.height) return;
  win.setBounds({ x: x + w - width, y: y + h - fern.height, width, height: fern.height });
}

function applyConfig(cfg) {
  if (!win || win.isDestroyed()) return;
  manifest = loadManifest(cfg);
  fitWindow(cfg);
  send('setup', setupPayload(cfg));
  sendListen();
  buildTrayMenu();
}

// ---------------------------------------------------------------------------
// Hook events

function fill(template, values) {
  return template
    .replace(/\{(\w+)\}/g, (_m, key) => values[key] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopSummary(transcriptPath) {
  try {
    // The Stop hook can fire just before the last line is flushed.
    await delay(300);
    const text = await lastAssistantText(transcriptPath);
    if (!text) return '';
    if (config.get().summarizeWithClaude) {
      try {
        return sentences(await summarizeWithClaude(config.get, text), 1, 160);
      } catch (err) {
        console.warn(`[summary] claude -p failed: ${err.message}`);
      }
    }
    return sentences(text, 1, 160);
  } catch {
    return '';
  }
}

/** Finds the session's claude process and terminal once. Reads the title again on Stop. */
function refreshSessionInfo(entry, event, hookPid) {
  if (!entry.pid && !entry.isResolving && hookPid) {
    entry.isResolving = true;
    terminal.resolveSessionProcess(hookPid).then((found) => {
      Object.assign(entry, found ?? {});
      scheduleCrowd();
    });
  }
  if (entry.transcriptPath && (event === 'Stop' || entry.title === undefined)) {
    entry.title = null;
    sessionTitle(entry.transcriptPath)
      .then((title) => {
        entry.title = title ?? null;
        scheduleCrowd();
      })
      .catch(() => {});
  }
}

/** Counts the subagents of a session, so each one gets a clone with its number. */
function trackAgents(entry, event, raw) {
  entry.agents ??= [];
  entry.lastAgentNumber ??= 0;
  if (event === 'PreToolUse' && AGENT_TOOLS.has(raw.tool_name)) {
    entry.agents.push({ number: ++entry.lastAgentNumber, isBackground: raw.isBackgroundAgent, startedAt: Date.now() });
  } else if (event === 'PostToolUse' && AGENT_TOOLS.has(raw.tool_name)) {
    // A foreground agent ends with its tool call. A background one ends with SubagentStop.
    const i = entry.agents.findIndex((a) => !a.isBackground);
    if (i >= 0) entry.agents.splice(i, 1);
  } else if (event === 'SubagentStop') {
    const i = entry.agents.findIndex((a) => a.isBackground);
    if (i >= 0) entry.agents.splice(i, 1);
  }
}

/** Keeps the session list that Fern reads through her list_sessions tool and that the mini avatars show. */
function trackSession(event, sessionId, raw, project) {
  if (event === 'SessionEnd') {
    sessions.delete(sessionId);
    scheduleCrowd();
    return;
  }
  if (event === 'SubagentStop') {
    const entry = sessions.get(sessionId);
    if (entry) trackAgents(entry, event, raw);
    scheduleCrowd();
    return;
  }
  if (!STATE_BY_EVENT[event]) return;
  const entry = sessions.get(sessionId) ?? { id: sessionId, startedAt: Date.now() };
  entry.project = project;
  if (typeof raw.cwd === 'string') entry.cwd = raw.cwd;
  if (typeof raw.transcript_path === 'string') entry.transcriptPath = raw.transcript_path;
  if (event === 'PreToolUse') entry.tool = raw.tool_name;
  if (event === 'Notification') entry.message = raw.message;
  entry.state = state.stateOf(sessionId) ?? STATE_BY_EVENT[event];
  entry.updatedAt = Date.now();
  sessions.set(sessionId, entry);
  trackAgents(entry, event, raw);
  refreshSessionInfo(entry, event, raw.hookPid);
  scheduleCrowd();
}

// ---------------------------------------------------------------------------
// Mini avatars

function shortPlace(cwd) {
  if (!cwd) return '';
  const home = require('os').homedir();
  const rel = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = rel.split('/');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : rel;
}

/** Left to right: each session and its subagent clones, then Fern's job clones next to Fern. */
function buildCrowd() {
  const minis = [];
  const live = [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const s of live) {
    const title = s.title || s.project;
    minis.push({ key: `s:${s.id}`, kind: 'session', title, place: shortPlace(s.cwd), state: state.stateOf(s.id) ?? s.state, seed: s.id });
    for (const a of s.agents ?? []) {
      minis.push({ key: `a:${s.id}:${a.number}`, kind: 'agent', title: `Agent #${a.number}`, place: title, state: 'working', seed: s.id, number: a.number });
    }
  }
  const now = Date.now();
  for (const j of jobs.list()) {
    if (j.status !== 'running' && now - j.endedAt > FINISHED_JOB_VISIBLE_MS) continue;
    const jobState = { running: 'working', done: 'done' }[j.status] ?? 'attention';
    minis.push({ key: `j:${j.id}`, kind: 'job', title: `Fern #${j.number}`, place: j.project, state: jobState, seed: 'fern', number: j.number });
  }
  if (minis.length <= MAX_MINIS) return minis;
  const hidden = minis.length - (MAX_MINIS - 1);
  return [{ key: 'more', kind: 'more', title: `+${hidden} more`, place: '', state: 'idle', seed: 'more' }, ...minis.slice(-(MAX_MINIS - 1))];
}

/** Sends the mini avatars at most a few times per second. */
function scheduleCrowd() {
  if (crowdTimer) return;
  crowdTimer = setTimeout(() => {
    crowdTimer = undefined;
    const minis = buildCrowd();
    const width = minis.length * MINI_SLOT_WIDTH;
    if (width !== crowdWidth) {
      crowdWidth = width;
      fitWindow(config.get());
    }
    send('crowd', minis);
  }, CROWD_THROTTLE_MS);
}

/** Removes sessions whose claude process ended without SessionEnd, and old agents. */
function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.pid && !terminal.isAlive(s.pid)) sessions.delete(id);
    else if (s.agents) s.agents = s.agents.filter((a) => now - a.startedAt < STALE_AGENT_MS);
  }
  scheduleCrowd();
}

/**
 * A click on a session (or its agent) brings its terminal tab to the front.
 * When the session is closed, it opens a new terminal that resumes it.
 * A click on a Fern job shows it in the panel.
 */
async function onMiniClick(key) {
  const { terminalApp } = config.get();
  const [kind, id] = key.split(':');
  if (kind === 'j') {
    const job = jobs.get(id);
    if (!job) return;
    showPanel();
    sendPanel('panel:select', job.id);
    return;
  }
  if (kind !== 's' && kind !== 'a') return;
  const s = sessions.get(id);
  if (!s) return;
  if (s.tty && await terminal.focusTty(terminalApp, s.tty)) return;
  if (s.pid && terminal.isAlive(s.pid)) {
    // Still running, but in a window that the script cannot find (or another app).
    spawn('open', ['-a', terminalApp], { stdio: 'ignore' }).on('error', () => {});
    tell('info', `${s.title || s.project} is open, but I could not find its tab.`);
    return;
  }
  if (!s.cwd) return;
  await terminal.openSession(terminalApp, s.cwd, s.id);
}

async function onHookEvent(raw) {
  const event = raw.hook_event_name;
  const sessionId = String(raw.session_id ?? 'default');
  const project = (typeof raw.cwd === 'string' && path.basename(raw.cwd)) || 'Claude';
  const { phrases, speakOnSessionStart } = config.get();
  state.handle(event, sessionId);
  trackSession(event, sessionId, raw, project);

  switch (event) {
    case 'SessionStart': {
      const text = fill(phrases.greet, { project });
      bubble('fern', text);
      if (speakOnSessionStart) speech.say(text, { kind: 'greet', sessionId });
      break;
    }
    case 'UserPromptSubmit':
      if (typeof raw.prompt === 'string' && raw.prompt.trim()) bubble('you', sentences(raw.prompt, 2, 160));
      break;
    case 'PreToolUse':
      bubble('info', raw.tool_name ? `Using ${raw.tool_name}` : 'Working…');
      break;
    case 'Notification': {
      const text = fill(phrases.attention, { project, message: String(raw.message ?? 'I need you.') });
      bubble('fern', text);
      speech.say(text, { kind: 'attention', sessionId });
      break;
    }
    case 'Stop': {
      const summary = await stopSummary(raw.transcript_path);
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.lastSummary = summary;
        entry.state = 'done';
      }
      const text = fill(phrases.done, { project, summary });
      bubble('fern', text);
      speech.say(text, { kind: 'done', sessionId });
      break;
    }
    default:
      break;
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    const isMcp = req.url === '/mcp';
    if (isMcp && req.method !== 'POST') return mcpHandler(req, res);
    if (req.method !== 'POST' || (req.url !== '/event' && !isMcp)) {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let ev;
      try {
        ev = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        if (isMcp) {
          res.writeHead(400);
          return res.end();
        }
        ev = undefined;
      }
      if (isMcp) {
        mcpHandler(req, res, ev).catch((err) => {
          console.warn(`[mcp] ${err.message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        return;
      }
      res.writeHead(204);
      res.end();
      if (ev === undefined) return;
      // Keep only the fields the avatar needs. Everything else is dropped here.
      const { hook_event_name, tool_name, message, session_id, cwd, transcript_path, prompt } = ev ?? {};
      const pidHeader = String(req.headers['x-claude-pid'] ?? '');
      const hookPid = /^\d{1,7}$/.test(pidHeader) ? Number(pidHeader) : undefined;
      const isBackgroundAgent = AGENT_TOOLS.has(tool_name) && ev?.tool_input?.run_in_background === true;
      onHookEvent({ hook_event_name, tool_name, message, session_id, cwd, transcript_path, prompt, hookPid, isBackgroundAgent })
        .catch((err) => console.warn(`[event] ${err.message}`));
    });
  });
  server.on('error', (err) => console.error(`[server] ${err.message}`));
  server.listen(config.get().port, '127.0.0.1', () => {
    console.log(`Avatar listening on http://127.0.0.1:${config.get().port}/event`);
  });
}

/**
 * Sends text to Fern's claude -p chat, then shows the reply.
 * Voice questions get a spoken reply. Typed ones only when speakTypedReplies is on.
 */
async function askFern(text, source) {
  state.handle('UserPromptSubmit', FERN_SELF);
  setPanelBusy(1);
  const isTyped = source === 'panel';
  // The tag tells Fern which reply style to use. See FERN_PROMPT.
  const tagged = `${isTyped ? '[Terminal]' : '[Spoken]'} ${text}`;
  try {
    const reply = await assistant.ask(tagged, (tool, input) => {
      state.handle('PreToolUse', FERN_SELF);
      panelLine('tool', describeToolCall(tool, input));
    });
    // A technical reply keeps its Markdown in the panel. The bubble and the voice get a short plain line.
    const short = isTyped ? sentences(reply, 2, 200) : reply;
    state.handle('Stop', FERN_SELF);
    bubble('fern', short);
    panelLine('fern', reply);
    if (!isTyped || config.get().speakTypedReplies) speech.say(short, { kind: 'reply', sessionId: FERN_SELF });
  } catch (err) {
    state.handle('SessionEnd', FERN_SELF);
    tell('info', `claude -p failed: ${err.message}`);
  } finally {
    setPanelBusy(-1);
  }
}

// ---------------------------------------------------------------------------
// Hands-free: wake word and voice identification

/** The renderer listens while the wake word is on or while enrolling. */
function sendListen() {
  const { listenForWakeWord, phraseEndSilenceMs, quietMode } = config.get();
  send('listen', { isOn: Boolean(listenForWakeWord || enrollment), endSilenceMs: phraseEndSilenceMs });
  send('toggles', { isMicOn: Boolean(listenForWakeWord), isVoiceOn: !quietMode });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the phrase has the wake word anywhere, as a whole word. */
function hasWakeWord(text, words) {
  const names = words.map(escapeRegExp).join('|');
  return new RegExp(`\\b(?:${names})\\b`, 'i').test(text);
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** Returns a word that is one letter away from "fern" (for example "vern", "burn"), or undefined. */
function nearMissWord(text) {
  return text.toLowerCase().match(/[a-z']+/g)?.find((w) => w.length >= 3 && w.length <= 5 && editDistance(w, 'fern') === 1);
}

/** Returns the text after the wake word, or undefined when the phrase does not start with it. */
function afterWakeWord(text, words) {
  const names = words.map(escapeRegExp).join('|');
  const match = text.match(new RegExp(`^\\W*(?:(?:hey|hi|ok|okay)\\W+)?(?:${names})\\b[\\s,.!?:;-]*`, 'i'));
  return match ? text.slice(match[0].length).trim() : undefined;
}

/** `append` adds a voiceprint for another microphone and keeps the earlier ones. */
function startEnrollment({ append = false } = {}) {
  enrollment = { samples: [], append, timer: setTimeout(() => endEnrollment('Voice setup timed out.'), ENROLL_TIMEOUT_MS) };
  sendListen();
  bubble('fern', `Voice setup 1/${ENROLL_SENTENCES.length}. Read aloud: "${ENROLL_SENTENCES[0]}"`);
}

function endEnrollment(message) {
  clearTimeout(enrollment?.timer);
  enrollment = undefined;
  sendListen();
  buildTrayMenu();
  bubble('fern', message);
}

function addEnrollmentSample(wav, seconds) {
  if (seconds < MIN_ENROLL_SECONDS) {
    bubble('fern', `Too short. Read again: "${ENROLL_SENTENCES[enrollment.samples.length]}"`);
    return;
  }
  enrollment.samples.push(wav);
  const done = enrollment.samples.length;
  if (done < ENROLL_SENTENCES.length) {
    bubble('fern', `Voice setup ${done + 1}/${ENROLL_SENTENCES.length}. Read aloud: "${ENROLL_SENTENCES[done]}"`);
    return;
  }
  try {
    voiceprint.enroll(config.get().speakerModel, enrollment.samples, { append: enrollment.append });
    endEnrollment(enrollment.append
      ? 'I know your voice on this microphone too.'
      : 'I know your voice now. Say "Fern" and then your question.');
  } catch (err) {
    endEnrollment(`Voice setup failed: ${err.message}`);
  }
}

/**
 * One phrase from the always-on listener. Every phrase is transcribed locally.
 * A phrase with "Fern" anywhere goes to a small model that decides if it is
 * a request to her. Strangers who ask her get a polite refusal.
 */
async function handleHeard(wav, seconds) {
  if (enrollment) return addEnrollmentSample(wav, seconds);
  const cfg = config.get();
  if (!cfg.listenForWakeWord) return;
  if (!voiceprint.hasVoiceprint()) {
    if (!hasShownEnrollHint) {
      hasShownEnrollHint = true;
      bubble('info', 'Teach me your voice first: tray menu > Set up my voice.');
    }
    return;
  }
  let similarity;
  try {
    similarity = voiceprint.score(cfg.speakerModel, wav);
  } catch (err) {
    if (!hasWarnedSpeaker) {
      hasWarnedSpeaker = true;
      console.warn(`[voice] Speaker check failed: ${err.message}`);
    }
    return;
  }
  const isOwner = similarity >= cfg.voiceMatchThreshold;

  let text;
  try {
    text = await transcribe(config.get, wav, { hint: 'The assistant is called Fern.' });
  } catch (err) {
    console.warn(`[voice] ${err.message}`);
    if (isOwner) tell('info', `I could not transcribe that: ${err.message}`);
    return;
  }
  const isFollowUp = isOwner && Date.now() < followUpUntil;
  const isNamed = hasWakeWord(text, cfg.wakeWords);
  // Numbers only. Speech text is never logged.
  console.log(`[voice] phrase ${seconds.toFixed(1)}s, voice score ${similarity.toFixed(2)} (need ${cfg.voiceMatchThreshold}), name ${isNamed ? 'found' : 'not found'}, ${text.length} chars`);

  if (isFollowUp) {
    followUpUntil = 0;
    if (!text) return;
    tell('you', text);
    return askFern(text, 'voice');
  }
  if (!isNamed) {
    // Only a word close to "Fern" gets a hint, and not too often. Bubble only, not spoken.
    const nearMiss = isOwner && cfg.voiceFeedback && nearMissWord(text);
    if (nearMiss && Date.now() - lastHintAt > HINT_INTERVAL_MS) {
      lastHintAt = Date.now();
      tell('info', `Did you call me? I heard "${nearMiss}". Say "Fern" clearly if you want me.`);
    }
    return;
  }

  let verdict;
  try {
    verdict = await classifyPhrase(config.get, text);
  } catch (err) {
    // Without the classifier, only a phrase that starts with the name counts.
    console.warn(`[voice] Classifier failed: ${err.message}`);
    const rest = afterWakeWord(text, cfg.wakeWords);
    verdict = { addressed: rest !== undefined, request: rest ?? '' };
  }
  console.log(`[voice] classifier: ${verdict.addressed ? 'request' : 'not a request'}`);

  if (!verdict.addressed) return;
  if (!isOwner) {
    const line = 'Forgive me, but I only take requests from the person I serve.';
    tell('fern', line);
    speech.say(line, { kind: 'reply', sessionId: FERN_SELF });
    return;
  }
  if (!verdict.request) {
    followUpUntil = Date.now() + FOLLOW_UP_MS;
    tell('fern', 'Yes? I am listening.');
    speech.say('Yes? I am listening.', { kind: 'reply', sessionId: FERN_SELF });
    return;
  }
  tell('you', text);
  await askFern(text, 'voice');
}

// ---------------------------------------------------------------------------
// Fern terminal panel (keyboard way to talk to Fern)

function createPanel() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - PANEL_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height * 0.2),
    show: false,
    // Native macOS buttons: close (hides), minimize, zoom. Zoom fills the screen in the
    // same Space. Real full screen would open a new Space where the panel covers Fern.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    alwaysOnTop: true,
    minWidth: 420,
    minHeight: 240,
    backgroundColor: '#17161F',
    webPreferences: {
      preload: path.join(__dirname, 'panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  reloadWhenGone(panel, 'panel');
  panel.loadFile('panel.html');
  // The red button hides the panel, so the tabs and their logs stay.
  panel.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    panel.hide();
  });
  panel.on('closed', () => { panel = undefined; });
}

function showPanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  if (panel.isMinimized()) panel.restore();
  app.focus({ steal: true });
  panel.show();
  panel.focus();
  sendPanel('panel:focus');
}

function togglePanel() {
  if (panel && !panel.isDestroyed() && panel.isVisible() && panel.isFocused() && !panel.isMinimized()) {
    panel.close();
    return;
  }
  showPanel();
}

function sessionLines() {
  const lines = [...sessions.values()].map((s) => `${s.project.padEnd(20)} ${String(s.state).padEnd(10)} ${s.lastSummary ?? ''}`);
  return lines.length ? lines.join('\n') : 'No Claude Code sessions seen yet.';
}

function jobLines() {
  const lines = jobs.list().map((j) => `${j.id}  ${j.status.padEnd(9)} ${j.title} (${j.cwd})`);
  return lines.length ? lines.join('\n') : 'No jobs yet.';
}

/** Panel input. Lines that start with "/" are local commands and do not reach Claude. */
function handlePanelInput(text) {
  const [command, ...rest] = text.split(/\s+/);
  switch (command) {
    case '/help':
      return panelLine('info', '/resume  switch to an earlier Fern chat\n/sessions  list sessions\n/jobs  list jobs\n/cancel <id>  stop a job\n/allow [id], /deny [id]  answer a confirmation\n/new  new chat with Fern\n/clear  clear the screen\nEsc or Cmd+Shift+K  hide');
    case '/sessions':
      return panelLine('info', sessionLines());
    case '/jobs':
      return panelLine('info', jobLines());
    case '/cancel':
      try {
        return panelLine('info', `Cancelled job ${jobs.cancel(rest[0]).id}.`);
      } catch (err) {
        return panelLine('info', err.message);
      }
    case '/new':
      assistant.reset();
      sendPanel('panel:history', { lines: [] });
      return panelLine('info', 'New chat started.');
    case '/resume':
      return showResumePicker();
    case '/allow':
    case '/deny': {
      const id = rest[0] ?? [...approvals.keys()].at(-1);
      if (!approvals.has(id)) return panelLine('info', 'No pending request.');
      return answerApproval(id, command === '/allow');
    }
    default:
      if (command.startsWith('/')) return panelLine('info', `Unknown command ${command}. Type /help.`);
      tell('you', text);
      return askFern(text, 'panel');
  }
}

/** Sends Fern's earlier chats to the panel, which shows a picker like Claude Code's /resume. */
async function showResumePicker() {
  const chats = await fernHistory.listChats(config.get().assistantCwd);
  if (!chats.length) return panelLine('info', 'There are no earlier chats with Fern yet.');
  sendPanel('panel:resume-list', { chats, current: assistant.currentSession() });
}

/** Switches Fern to an earlier chat and shows its messages in her tab. */
async function resumeChat(id) {
  const lines = await fernHistory.loadChat(config.get().assistantCwd, id);
  assistant.useSession(id);
  sendPanel('panel:history', { lines });
  panelLine('info', `Resumed chat ${id.slice(0, 8)}. Your next question continues it.`);
}

function registerShortcut(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return;
  try {
    if (!globalShortcut.register(accelerator, togglePanel)) {
      console.warn(`[shortcut] ${accelerator} is used by another app.`);
    }
  } catch (err) {
    console.warn(`[shortcut] Bad accelerator ${accelerator}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Confirmation of critical actions

// Pending questions to the owner, by id. Answered with a click or a key, never by voice.
const approvals = new Map();

function callerInfo(caller) {
  if (caller.startsWith('job:')) {
    const job = jobs.get(caller.slice(4));
    return { label: job ? `Job ${job.title} (${job.project})` : caller, cwd: job?.cwd, isJob: true, stateKey: caller };
  }
  return { label: 'Fern', cwd: config.get().assistantCwd, isJob: false, stateKey: FERN_SELF };
}

/** Asks the owner. Resolves true for Allow, false for Deny or no answer in time. */
function requestApproval({ caller, reason, detail }) {
  const id = crypto.randomBytes(2).toString('hex');
  const { label, stateKey } = callerInfo(caller);
  const tab = caller.startsWith('job:') ? caller.slice(4) : 'fern';
  return new Promise((resolve) => {
    const finish = (isAllowed, note) => {
      if (!approvals.has(id)) return;
      clearTimeout(approvals.get(id).timer);
      approvals.delete(id);
      console.log(`[approval] ${id} ${isAllowed ? 'allowed' : 'denied'}${note ? ` (${note})` : ' by the owner'}`);
      send('approval:done', { id });
      sendPanel('panel:approval-done', { id, isAllowed });
      panelLine('info', `${isAllowed ? 'Allowed' : 'Denied'} [${id}]${note ? ` (${note})` : ''}`, tab);
      state.handle(isAllowed ? 'PreToolUse' : 'PostToolUse', stateKey);
      resolve(isAllowed);
    };
    const timer = setTimeout(() => {
      finish(false, 'no answer');
      bubble('fern', 'You did not answer, so I did not do it.');
    }, config.get().approvalTimeoutSeconds * 1000);
    approvals.set(id, { finish, timer });
    console.log(`[approval] ${id} asked: ${label} wants to ${reason}`);

    const question = `${label} wants to ${reason}.`;
    send('approval', { id, text: question, detail });
    sendPanel('panel:approval', { id, text: question, detail, tab });
    if (panel && !panel.isDestroyed() && !panel.isVisible()) panel.showInactive();
    state.handle('Notification', stateKey);
    speech.say(`I need your OK first. ${question}`, { kind: 'attention', sessionId: `approval:${id}` });
  });
}

function answerApproval(id, isAllowed) {
  approvals.get(id)?.finish(Boolean(isAllowed));
}

/**
 * The tool that Claude calls (--permission-prompt-tool) before each action that
 * needs permission. Normal actions pass. Critical ones wait for the owner.
 */
function createApproveTool() {
  return {
    description: 'Internal permission check. Do not call it yourself.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name'],
    },
    handler: async ({ tool_name: toolName, input = {} }, caller) => {
      const { cwd, isJob } = callerInfo(caller);
      const { critical, reason } = guard.check(toolName, input, { cwd, isJob });
      if (!critical) return { behavior: 'allow', updatedInput: input };
      const isAllowed = await requestApproval({ caller, reason, detail: guard.describe(toolName, input) });
      return isAllowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The owner did not allow this action. Do not try it another way.' };
    },
  };
}

// ---------------------------------------------------------------------------
// IPC from the renderer

function registerIpc() {
  ipcMain.on('drag:start', () => {
    if (win) dragOrigin = win.getPosition();
  });
  ipcMain.on('drag:move', (_e, { dx, dy }) => {
    if (win && dragOrigin && Number.isFinite(dx) && Number.isFinite(dy)) {
      win.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy));
    }
  });
  ipcMain.on('drag:end', () => {
    dragOrigin = undefined;
    if (!win) return;
    const [x, y] = win.getPosition();
    // The saved position is Fern's part of the window, without the mini avatars.
    config.update({ position: { x: x + crowdWidth, y } });
  });
  ipcMain.on('mouse:interactive', (_e, isInteractive) => {
    // Empty parts of the window let clicks through to the desktop.
    win?.setIgnoreMouseEvents(!isInteractive, { forward: true });
  });
  ipcMain.on('crowd:click', (_e, key) => {
    if (typeof key === 'string') onMiniClick(key).catch((err) => tell('info', err.message));
  });
  ipcMain.on('avatar:click', () => {
    speech.stop();
    state.clearAttention();
    spawn('open', ['-a', config.get().terminalApp], { stdio: 'ignore' })
      .on('error', (err) => console.warn(`[click] ${err.message}`));
  });
  ipcMain.handle('voice:mic', async () => {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
  ipcMain.on('voice:heard', (_e, { wav, seconds }) => {
    if (!(wav instanceof Uint8Array) || wav.length === 0 || !Number.isFinite(seconds)) return;
    const buffer = Buffer.from(wav);
    heardQueue = heardQueue
      .then(() => handleHeard(buffer, seconds))
      .catch((err) => console.warn(`[voice] ${err.message}`));
  });
  ipcMain.on('panel:input', (_e, text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    Promise.resolve(handlePanelInput(text.trim().slice(0, 8000)))
      .catch((err) => panelLine('info', err.message));
  });
  ipcMain.on('panel:hide', () => panel?.close());
  ipcMain.on('panel:resume', (_e, id) => {
    if (typeof id === 'string') resumeChat(id).catch((err) => panelLine('info', `Cannot resume: ${err.message}`));
  });
  ipcMain.on('toggle', (_e, name) => {
    const cfg = config.get();
    if (name === 'mic') config.update({ listenForWakeWord: !cfg.listenForWakeWord });
    if (name === 'voice') {
      if (!cfg.quietMode) speech.stop();
      config.update({ quietMode: !cfg.quietMode });
    }
  });
  ipcMain.on('approval:answer', (_e, { id, isAllowed }) => {
    if (typeof id === 'string') answerApproval(id, isAllowed === true);
  });
}

// ---------------------------------------------------------------------------
// Tray

function buildTrayMenu() {
  if (!tray) return;
  const cfg = config.get();
  const toggle = (key) => () => config.update({ [key]: !config.get()[key] });
  const hasKokoro = fs.existsSync(path.join(cfg.kokoroDir, 'model.onnx'));
  const kokoroItems = kokoro.MENU_VOICES.map((name) => ({
    label: `${name.slice(3).replace(/^./, (c) => c.toUpperCase())} (${name.startsWith('j') ? 'Japanese accent' : name.startsWith('b') ? 'British' : 'American'})`,
    type: 'radio',
    enabled: hasKokoro,
    checked: cfg.ttsEngine === 'kokoro' && cfg.kokoroVoice === name,
    click: () => config.update({ ttsEngine: 'kokoro', kokoroVoice: name }),
  }));
  const sayItems = voices.map((v) => ({
    label: `${v.name} (${v.lang})`,
    type: 'radio',
    checked: cfg.ttsEngine !== 'kokoro' && v.name === cfg.voice,
    click: () => config.update({ ttsEngine: 'say', voice: v.name }),
  }));
  const voiceItems = [
    { label: hasKokoro ? 'Kokoro (neural, local)' : 'Kokoro (model not installed)', enabled: false },
    ...kokoroItems,
    { type: 'separator' },
    { label: 'macOS voices', enabled: false },
    ...sayItems,
  ];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Quiet mode', type: 'checkbox', checked: cfg.quietMode, click: toggle('quietMode') },
    { label: 'Speak when terminal is focused', type: 'checkbox', checked: cfg.speakWhenTerminalFocused, click: toggle('speakWhenTerminalFocused') },
    { label: 'Voice', submenu: voiceItems.length ? voiceItems : [{ label: 'No voices found', enabled: false }] },
    {
      label: 'Size',
      submenu: [2, 3, 4].map((scale) => ({
        label: `${scale}×`, type: 'radio', checked: cfg.scale === scale, click: () => config.update({ scale }),
      })),
    },
    { label: 'Talk to Fern (terminal)', accelerator: cfg.panelShortcut || undefined, click: togglePanel },
    { label: 'New chat with Fern', click: () => { assistant.reset(); tell('info', 'New chat started.'); } },
    { type: 'separator' },
    { label: 'Listen for "Fern"', type: 'checkbox', checked: cfg.listenForWakeWord, click: toggle('listenForWakeWord') },
    ...(voiceprint.hasVoiceprint()
      ? [
        { label: `Add this microphone to my voice… (${voiceprint.count()} saved)`, enabled: !enrollment, click: () => startEnrollment({ append: true }) },
        { label: 'Set up my voice again…', enabled: !enrollment, click: () => startEnrollment() },
      ]
      : [{ label: 'Set up my voice…', enabled: !enrollment, click: () => startEnrollment() }]),
    {
      label: 'Forget my voice',
      enabled: voiceprint.hasVoiceprint(),
      click: () => { voiceprint.forget(); buildTrayMenu(); bubble('info', 'Voiceprint deleted.'); },
    },
    { type: 'separator' },
    { label: 'Test speech', click: () => { bubble('fern', 'Hello. I am Fern. I will keep an eye on Claude for you.'); speech.say('Hello. I am Fern. I will keep an eye on Claude for you.', { force: true }); } },
    { label: 'Open config file', click: () => shell.openPath(config.CONFIG_FILE) },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Claude avatar');
  buildTrayMenu();
}

// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    app.dock?.hide();
    config.load();
    fs.mkdirSync(config.get().assistantCwd, { recursive: true });
    writeMcpConfig({ port: config.get().port, token: mcpToken, caller: 'fern' });
    const fernTools = createFernTools({ sessions, jobs, getConfig: config.get });
    const approveTool = { approve: createApproveTool() };
    // Jobs only get the permission check. Fern gets her tools too.
    mcpHandler = createMcpHandler((caller) => (caller === 'fern' ? { ...fernTools, ...approveTool } : approveTool), mcpToken);
    let shortcut = config.get().panelShortcut;
    config.watch((cfg) => {
      applyConfig(cfg);
      if (cfg.panelShortcut !== shortcut) {
        shortcut = cfg.panelShortcut;
        registerShortcut(shortcut);
      }
    });
    registerShortcut(shortcut);
    // The page may only use the microphone. Every other permission is denied.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'));
    registerIpc();
    createWindow();
    setInterval(pruneSessions, PRUNE_INTERVAL_MS);
    createPanel();
    createTray();
    startServer();
    state.start();
    voices = await listVoices();
    buildTrayMenu();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
