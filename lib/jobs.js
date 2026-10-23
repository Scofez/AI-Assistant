const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { childEnv, eachLine } = require('./assistant');

const MAX_RUNNING = 3;
const MAX_RESULT_CHARS = 20000;
const MAX_LOG_CHARS = 600;
const MAX_LOG_LINES = 8;

/** A short view of a tool call, like Claude Code shows it: Bash(npm test), Read(src/app.js). */
function describeToolCall(name, input = {}) {
  const arg = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query
    ?? input.description ?? (Object.keys(input).length ? JSON.stringify(input) : '');
  return `${String(name).replace(/^mcp__fern__/, '')}(${String(arg).replace(/\s+/g, ' ').slice(0, 160)})`;
}

/** Keeps the first lines of a tool result, so a log stays readable and light. */
function clip(text) {
  const lines = String(text).split('\n');
  const head = lines.slice(0, MAX_LOG_LINES).join('\n').slice(0, MAX_LOG_CHARS);
  return lines.length > MAX_LOG_LINES || text.length > MAX_LOG_CHARS ? `${head}\n…` : head;
}

function toolResultText(block) {
  if (typeof block.content === 'string') return block.content;
  return (Array.isArray(block.content) ? block.content : [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Returns the real path of `cwd` when it is a folder inside the home folder.
 * Jobs never run outside it.
 */
function safeProjectDir(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  const real = fs.realpathSync(cwd);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${cwd} is not a folder`);
  const home = fs.realpathSync(os.homedir());
  if (real === home || !real.startsWith(`${home}${path.sep}`)) throw new Error('cwd must be a project folder inside your home folder');
  return real;
}

/**
 * Headless `claude -p` jobs that Fern starts. Results stay in memory only.
 * `onFinish(job)` runs when a job ends, with job.status set.
 * `onLog(job, { who, text })` gets each step while the job runs: who is
 * 'assistant', 'tool', 'result', or 'info'.
 * `mcpConfigFor(id)` writes the job's MCP config and returns { file, cleanup }.
 * Each job sends its permission checks to the app, like Fern does.
 */
function createJobs({ getConfig, onChange, onFinish, onLog, mcpConfigFor }) {
  const jobs = new Map();
  let lastNumber = 0;

  function running() {
    return [...jobs.values()].filter((j) => j.status === 'running');
  }

  function finish(job, status, result) {
    if (job.status !== 'running') return;
    clearTimeout(job.timer);
    job.mcp.cleanup();
    job.status = status;
    job.result = String(result ?? '').slice(0, MAX_RESULT_CHARS);
    job.endedAt = Date.now();
    onChange(job);
    onFinish(job);
  }

  return {
    start({ cwd, prompt, title }) {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is empty');
      if (running().length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} jobs are already running`);
      const dir = safeProjectDir(cwd);
      const cfg = getConfig();
      const id = crypto.randomBytes(3).toString('hex');
      const name = String(title || path.basename(dir)).slice(0, 60);
      const mcp = mcpConfigFor(id);
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose', '--name', `Fern job: ${name}`,
        '--permission-mode', cfg.jobPermissionMode || 'manual',
        '--mcp-config', mcp.file, '--permission-prompt-tool', 'mcp__fern__approve',
      ];
      const child = spawn(cfg.claudePath, args, { cwd: dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      const job = {
        id, number: ++lastNumber, title: name, cwd: dir, project: path.basename(dir), status: 'running', startedAt: Date.now(), child, mcp,
      };
      jobs.set(id, job);

      let final;
      let stderr = '';
      const log = (who, text) => text && onLog(job, { who, text });
      eachLine(child.stdout, (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          job.sessionId = msg.session_id;
          log('info', `session ${msg.session_id} · ${msg.model ?? ''} · ${dir}`);
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block?.type === 'text') log('assistant', block.text.trim());
            else if (block?.type === 'tool_use') log('tool', describeToolCall(block.name, block.input));
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message?.content ?? []) {
            if (block?.type === 'tool_result') log(block.is_error ? 'error' : 'result', clip(toolResultText(block)) || '(no output)');
          }
        } else if (msg.type === 'result') {
          final = msg;
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => finish(job, 'failed', err.message));
      child.on('close', (code) => {
        if (job.status === 'cancelled') return;
        if (final) finish(job, final.is_error || code !== 0 ? 'failed' : 'done', final.result);
        else finish(job, 'failed', stderr.trim().slice(0, 500) || `claude exited with code ${code}`);
      });
      job.timer = setTimeout(() => {
        child.kill();
        finish(job, 'failed', 'Timed out');
      }, cfg.jobTimeoutMinutes * 60 * 1000);
      child.stdin.end(prompt);
      onChange(job);
      return job;
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job || job.status !== 'running') throw new Error(`No running job ${id}`);
      clearTimeout(job.timer);
      job.mcp.cleanup();
      job.status = 'cancelled';
      job.endedAt = Date.now();
      job.child.kill();
      onChange(job);
      return job;
    },
    get: (id) => jobs.get(id),
    list: () => [...jobs.values()],
  };
}

module.exports = { createJobs, describeToolCall, safeProjectDir };
