const fs = require('fs');
const os = require('os');
const path = require('path');
const { lastAssistantText, sentences } = require('./transcript');

const STALE_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_OUTPUT_CHARS = 2000;

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Fern's MCP tools. `sessions` is the live map of Claude Code sessions,
 * `jobs` is the job runner. Nothing here writes to disk.
 */
function createFernTools({ sessions, jobs, getConfig }) {
  function liveSessions() {
    const now = Date.now();
    return [...sessions.values()].filter((s) => now - s.updatedAt < STALE_SESSION_MS);
  }

  function findSession(ref) {
    const key = String(ref ?? '').toLowerCase();
    const all = liveSessions().sort((a, b) => b.updatedAt - a.updatedAt);
    return all.find((s) => s.id.toLowerCase().startsWith(key))
      ?? all.find((s) => s.project.toLowerCase() === key)
      ?? all.find((s) => s.project.toLowerCase().includes(key));
  }

  return {
    list_sessions: {
      description: 'List the Claude Code sessions the user runs now, and the jobs Fern started. Shows project, state (thinking, working, attention = needs the user, done, idle), and the last short summary.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({
        sessions: liveSessions().map((s) => ({
          id: s.id.slice(0, 8),
          project: s.project,
          cwd: s.cwd,
          state: s.state,
          lastSummary: s.lastSummary,
          tool: s.state === 'working' ? s.tool : undefined,
          waitingFor: s.state === 'attention' ? s.message : undefined,
          title: s.title || undefined,
          hasTerminal: Boolean(s.tty),
          agents: s.agents?.length || undefined,
          updated: ago(s.updatedAt),
        })),
        jobs: jobs.list().map((j) => ({
          id: j.id, title: j.title, project: j.project, status: j.status, started: ago(j.startedAt),
        })),
      }),
    },
    read_session_output: {
      description: 'Read the last answer that Claude wrote in one session. `session` is a project name or a session id.',
      inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
      handler: async ({ session }) => {
        const s = findSession(session);
        if (!s) throw new Error(`No session matches "${session}". Call list_sessions.`);
        if (!s.transcriptPath) throw new Error(`Session ${s.project} has no answer yet.`);
        const text = await lastAssistantText(s.transcriptPath);
        return text ? sentences(text, 20, MAX_OUTPUT_CHARS) : 'No answer yet.';
      },
    },
    find_project: {
      description: 'Find project folders by name. Searches the folders of known sessions and the project roots from the config.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handler: ({ name }) => {
        const key = String(name).toLowerCase();
        const found = new Set(liveSessions().map((s) => s.cwd).filter((c) => path.basename(c).toLowerCase().includes(key)));
        for (const root of getConfig().projectRoots.map(expandHome)) {
          let entries = [];
          try {
            entries = fs.readdirSync(root, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().includes(key)) found.add(path.join(root, e.name));
          }
        }
        return found.size ? [...found] : `No folder matches "${name}".`;
      },
    },
    start_job: {
      description: 'Start a background Claude Code job (claude -p) in a project folder. The job cannot ask for permissions, so tools that need approval are denied unless the user set jobPermissionMode. Fern is told when it ends.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Absolute project folder, from find_project or list_sessions' },
          prompt: { type: 'string', description: 'Complete task for the job' },
          title: { type: 'string', description: 'Short name for the job' },
        },
        required: ['cwd', 'prompt'],
      },
      handler: (args) => {
        const job = jobs.start(args);
        return `Started job ${job.id} (${job.title}) in ${job.cwd}.`;
      },
    },
    get_job: {
      description: 'Get the status and result of a job.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: ({ id }) => {
        const j = jobs.get(id);
        if (!j) throw new Error(`No job ${id}`);
        return { id: j.id, title: j.title, cwd: j.cwd, status: j.status, started: ago(j.startedAt), result: j.result };
      },
    },
    cancel_job: {
      description: 'Stop a running job.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: ({ id }) => `Cancelled job ${jobs.cancel(id).id}.`,
    },
  };
}

module.exports = { createFernTools };
