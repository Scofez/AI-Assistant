const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { describeToolCall } = require('./jobs');

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const MAX_CHATS = 30;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_HISTORY_LINES = 200;
const CHANNEL_TAG = /^\[(Terminal|Spoken)\]\s*/;

/** Claude Code keeps the sessions of a folder in ~/.claude/projects/<folder with "-" for each symbol>. */
function projectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

async function readEntries(file) {
  const { size } = await fs.stat(file);
  if (size > MAX_FILE_BYTES) return [];
  const entries = [];
  for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip a cut or empty line.
    }
  }
  return entries;
}

/** A typed or spoken question from the user, without Fern's channel tag. */
function userPrompt(entry) {
  if (entry.type !== 'user' || entry.isSidechain || typeof entry.message?.content !== 'string') return undefined;
  return entry.message.content.replace(CHANNEL_TAG, '').trim() || undefined;
}

/**
 * Lists Fern's earlier chats in her working folder, newest first.
 * Each item: { id, label (first question), turns, updatedAt }.
 */
async function listChats(cwd) {
  const dir = projectDir(cwd);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const files = await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    return { file, id: name.slice(0, -6), mtime: (await fs.stat(file)).mtimeMs };
  }));
  const newest = files.filter((f) => SESSION_ID.test(f.id)).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CHATS);
  const chats = await Promise.all(newest.map(async ({ file, id, mtime }) => {
    const prompts = (await readEntries(file)).map(userPrompt).filter(Boolean);
    return prompts.length ? { id, label: prompts[0].slice(0, 120), turns: prompts.length, updatedAt: mtime } : undefined;
  }));
  return chats.filter(Boolean);
}

/** The messages of one chat as panel lines: { who: 'you' | 'fern' | 'tool', text }. */
async function loadChat(cwd, id) {
  if (!SESSION_ID.test(id)) throw new Error('Bad session id');
  const lines = [];
  let lastMessageId;
  for (const entry of await readEntries(path.join(projectDir(cwd), `${id}.jsonl`))) {
    const prompt = userPrompt(entry);
    if (prompt) {
      lines.push({ who: 'you', text: prompt });
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    for (const block of entry.message?.content ?? []) {
      if (block?.type === 'tool_use') {
        lines.push({ who: 'tool', text: describeToolCall(block.name, block.input) });
      } else if (block?.type === 'text' && block.text.trim()) {
        // Claude Code writes one line per block, so text of the same message is joined.
        const previous = lines.at(-1);
        if (previous?.who === 'fern' && lastMessageId === entry.message.id) previous.text += `\n${block.text.trim()}`;
        else lines.push({ who: 'fern', text: block.text.trim() });
      }
    }
    lastMessageId = entry.message?.id;
  }
  return lines.slice(-MAX_HISTORY_LINES);
}

module.exports = { listChats, loadChat };
