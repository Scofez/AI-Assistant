const { spawn } = require('child_process');
const { clip, describeToolCall, toolResultText } = require('./stream-log');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const CLAUDE_TIMEOUT_MS = 120 * 1000;
const WHISPER_TIMEOUT_MS = 60 * 1000;
const FERN_PROMPT = [
  'You are Fern, the main assistant on this Mac. You are not one of the Claude Code sessions.',
  'You stand above all of them: you watch every Claude Code session the user runs, and you can start background jobs.',
  'Personality: calm, composed, polite, and a little serious. Quietly diligent. Dry, understated humor.',
  'You may gently scold the user when they are careless. Never bubbly, no emoji. Speak in the first person as Fern.',
  'Each user message starts with a channel tag.',
  '[Spoken]: your reply is read aloud. Talk like a person in your own voice: one to three short natural sentences.',
  'No Markdown, no lists, no code, and no ids or file paths unless the user asks for them.',
  '[Terminal]: the user typed in your terminal panel. Reply like Claude Code: technical, precise, and structured.',
  'Markdown is fine there: short lists, `code`, file paths, session and job ids, states, exact errors. No roleplay, no small talk.',
  'You have full access to this Mac: Bash, files, the web, apps (for example `open -a`), and the user\'s MCP servers.',
  'Critical actions (deleting files, pushing, posting comments or messages, changing settings) ask the owner for confirmation automatically.',
  'Just try the action. Do not ask for permission in your reply. If the owner denies it, accept that and say so.',
  'You cannot see the confirmation step. When a critical action ran, the owner allowed it. Never say that no confirmation was asked.',
  'Use the fern tools to watch and manage sessions: list_sessions, read_session_output, find_project, start_job, get_job, cancel_job.',
  'When the user asks about a project or session, call list_sessions first. Do not guess.',
  'Coding work (changing code, fixing bugs, running a project\'s tests) goes through a Claude session: call find_project, then start_job with a clear, complete prompt.',
  'Do small Mac tasks yourself: open apps, find or read files, check the system, search the web.',
].join(' ');

const AGENT_TOOLS = new Set(['Task', 'Agent']);

const CLASSIFY_TIMEOUT_MS = 20 * 1000;
const CLASSIFY_PROMPT = [
  'A microphone heard a phrase that contains the name "Fern". Fern is a voice assistant.',
  'Decide if the speaker talks TO Fern and wants something from her: a question, a task, a greeting, or a call for attention.',
  'addressed=false when the speaker only talks ABOUT Fern to someone else, quotes her, or the name is a mistake in the transcript.',
  'request = what the speaker wants from Fern, rewritten as one clear sentence without her name. Empty when they only call her name.',
].join(' ');
const CLASSIFY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { addressed: { type: 'boolean' }, request: { type: 'string' } },
  required: ['addressed', 'request'],
});

/**
 * Apps started from Finder or at login get a minimal PATH.
 * Add the usual install folders so `claude` and `whisper-cli` resolve.
 */
function childEnv(extra = {}) {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  const PATH = [process.env.PATH, ...dirs].filter(Boolean).join(':');
  // MCP_TOOL_TIMEOUT: a permission check waits for the owner, up to 5 minutes.
  return { ...process.env, PATH, CLAUDE_AVATAR_CHILD: '1', MCP_TOOL_TIMEOUT: '600000', ...extra };
}

/** Runs a command, writes `input` to stdin, and resolves with stdout. */
function run(cmd, args, { input, timeout, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(cmd)} timed out`));
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${cmd} not found`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin.end(input ?? '');
  });
}

/** Calls `onLine` for each complete line that a stream writes. */
function eachLine(stream, onLine) {
  let rest = '';
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    lines.forEach(onLine);
  });
  stream.on('end', () => rest && onLine(rest));
}

/**
 * Fern's own chat through `claude -p`. Keeps one thread with --resume until reset.
 * Questions run one at a time, because two runs cannot resume the same thread.
 * The prompt goes through stdin, so it is never parsed as a flag.
 * `getMcpConfigFile` gives the path of the config for the app's local MCP server.
 */
function createAssistant(getConfig, getMcpConfigFile) {
  let sessionId;
  let queue = Promise.resolve();

  function runOnce(text, { onLog, onInit, onAgentStart, onAgentEnd, isCommand }) {
    const cfg = getConfig();
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--name', 'Fern',
      '--append-system-prompt', FERN_PROMPT,
      '--mcp-config', getMcpConfigFile(), '--allowedTools', 'mcp__fern',
      // "manual" sends every action that needs permission to the app's check tool.
      // Without it, the user's global "auto" mode would approve actions with no check.
      '--permission-mode', 'manual', '--permission-prompt-tool', 'mcp__fern__approve',
    ];
    // Model and effort apply to Fern only, never to the user's global settings.
    if (cfg.fernModel) args.push('--model', cfg.fernModel);
    if (cfg.fernEffort) args.push('--effort', cfg.fernEffort);
    const startedWith = sessionId;
    if (sessionId) args.push('--resume', sessionId);
    // A slash command (for example /usage) before any chat must not start an empty Fern chat.
    const isThrowaway = isCommand && !sessionId;
    if (isThrowaway) args.push('--no-session-persistence');
    return new Promise((resolve, reject) => {
      const child = spawn(cfg.claudePath, args, { cwd: cfg.assistantCwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      let result;
      let stderr = '';
      let hasStreamedText = false;
      // Live subagents of this run: tool_use id -> true when it runs in the background.
      const agents = new Map();
      /** Ends an agent only once, because a foreground agent sends a task_notification and a tool_result. */
      const endAgent = (id) => {
        if (agents.delete(id)) onAgentEnd(id);
      };
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('claude timed out'));
      }, CLAUDE_TIMEOUT_MS);
      eachLine(child.stdout, (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          onInit({ slashCommands: msg.slash_commands ?? [], skills: msg.skills ?? [], model: msg.model, version: msg.claude_code_version });
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block?.type === 'text' && block.text.trim()) {
              hasStreamedText = true;
              onLog('assistant', block.text.trim());
            }
            // ToolSearch only loads tool schemas. It is not real activity.
            if (block?.type === 'tool_use' && block.name !== 'ToolSearch') onLog('tool', describeToolCall(block.name, block.input));
            if (block?.type === 'tool_use' && AGENT_TOOLS.has(block.name) && !agents.has(block.id)) {
              agents.set(block.id, block.input?.run_in_background === true);
              onAgentStart(block.id, String(block.input?.description ?? '').trim());
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message?.content ?? []) {
            if (block?.type !== 'tool_result') continue;
            onLog(block.is_error ? 'error' : 'result', clip(toolResultText(block)) || '(no output)');
            // The tool_result of a background agent only says that it started.
            const isLaunchOnly = agents.get(block.tool_use_id) || msg.tool_use_result?.status === 'async_launched';
            if (!isLaunchOnly) endAgent(block.tool_use_id);
          }
        } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
          // A background agent ends here, after its tool_result.
          endAgent(msg.tool_use_id);
        } else if (msg.type === 'result') {
          result = msg;
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err.code === 'ENOENT' ? new Error(`${cfg.claudePath} not found`) : err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // No end message comes after the process stops, so no clone stays forever.
        [...agents.keys()].forEach(endAgent);
        if (!result) return reject(new Error(stderr.trim().slice(0, 200) || `claude exited with code ${code}`));
        // A switch with /resume during this run wins over this run's session.
        if (sessionId === startedWith && !isThrowaway) sessionId = result.session_id ?? sessionId;
        if (result.is_error) return reject(new Error(String(result.result ?? 'claude returned an error')));
        resolve({ text: String(result.result ?? '').trim(), hasStreamedText, cost: result.total_cost_usd });
      });
      child.stdin.end(text);
    });
  }

  return {
    /**
     * Resolves with { text, hasStreamedText, cost }.
     * `onLog(who, text)` gets each step: who is 'assistant', 'tool', 'result', or 'error'.
     * `onInit({ slashCommands, skills, model, version })` runs once at the start.
     * `onAgentStart(id, description)` and `onAgentEnd(id)` run for each Agent or Task subagent.
     * `isCommand` marks a slash command, which is sent as it is.
     */
    ask(text, {
      onLog = () => {}, onInit = () => {}, onAgentStart = () => {}, onAgentEnd = () => {}, isCommand = false,
    } = {}) {
      const next = queue.then(() => runOnce(text, { onLog, onInit, onAgentStart, onAgentEnd, isCommand }));
      queue = next.catch(() => {});
      return next;
    },
    reset() {
      sessionId = undefined;
    },
    /** Continues an earlier chat. The next question resumes it. */
    useSession(id) {
      sessionId = id;
    },
    currentSession: () => sessionId,
  };
}

/**
 * Asks a small, fast model if a phrase that contains "Fern" is a request to her.
 * No tools and no saved session. Resolves with { addressed, request }.
 */
async function classifyPhrase(getConfig, text) {
  const cfg = getConfig();
  const args = [
    '-p', '--model', cfg.classifierModel, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--output-format', 'json', '--json-schema', CLASSIFY_SCHEMA, '--system-prompt', CLASSIFY_PROMPT,
  ];
  const out = JSON.parse(await run(cfg.claudePath, args, { input: `Phrase: "${text}"`, timeout: CLASSIFY_TIMEOUT_MS, cwd: os.tmpdir() }));
  const answer = out.structured_output;
  if (out.is_error || typeof answer?.addressed !== 'boolean') throw new Error('No valid answer from the classifier');
  return { addressed: answer.addressed, request: String(answer.request ?? '').trim() };
}

/** One-line summary through `claude -p`. Used only when summarizeWithClaude is on. */
async function summarizeWithClaude(getConfig, text) {
  const cfg = getConfig();
  const prompt = `Summarize this in one short plain sentence, under 25 words:\n\n${text.slice(0, 4000)}`;
  const out = await run(cfg.claudePath, ['-p'], { input: prompt, timeout: 30 * 1000, cwd: os.tmpdir() });
  return out.trim();
}

/**
 * Transcribes a 16 kHz mono WAV with whisper.cpp. The audio file lives
 * in a private temp folder only while whisper runs.
 */
async function transcribe(getConfig, wavBuffer, { hint } = {}) {
  const cfg = getConfig();
  try {
    await fs.access(cfg.whisperModel);
  } catch {
    throw new Error(`Whisper model not found at ${cfg.whisperModel}`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-avatar-'));
  const file = path.join(dir, `${crypto.randomUUID()}.wav`);
  try {
    await fs.writeFile(file, wavBuffer, { mode: 0o600 });
    const args = ['-m', cfg.whisperModel, '-f', file, '-l', cfg.whisperLanguage, '-nt', '-np'];
    // Whisper reads the prompt as text already said. A bare "Fern," hint would cut "Fern" from the phrase.
    if (hint) args.push('--prompt', hint);
    const out = await run(cfg.whisperPath, args, { timeout: WHISPER_TIMEOUT_MS });
    return out.replace(/\[[A-Z_ ]+\]/g, ' ').replace(/\s+/g, ' ').trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { childEnv, classifyPhrase, createAssistant, eachLine, summarizeWithClaude, transcribe };
