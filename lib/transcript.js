const fs = require('fs/promises');

const TAIL_BYTES = 512 * 1024;

/** Reads only the end of a large JSONL file. The first line may be cut, so it is dropped. */
async function readTailLines(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

/**
 * Returns the text of the last main-thread assistant message that has text.
 * Claude Code writes one JSONL line per content block, so lines that share
 * a message id are joined. Tool calls are ignored.
 */
async function lastAssistantText(file) {
  const lines = await readTailLines(file);
  let messageId;
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const message = entry.message ?? {};
    if (messageId !== undefined && message.id !== messageId) break;
    const texts = (Array.isArray(message.content) ? message.content : [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text);
    if (messageId === undefined && texts.length === 0) continue;
    messageId = message.id;
    parts.unshift(...texts);
  }
  return parts.join('\n').trim();
}

/** Returns the session title: a name the user gave (/rename) first, else the automatic title. */
async function sessionTitle(file) {
  const lines = await readTailLines(file);
  let aiTitle;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('-title"')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type === 'custom-title' && entry.customTitle) return String(entry.customTitle);
    if (entry.type === 'ai-title' && entry.aiTitle && !aiTitle) aiTitle = String(entry.aiTitle);
  }
  return aiTitle;
}

/** Removes Markdown so the text sounds natural when spoken. */
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?)\1/g, '$2')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts at a word boundary and adds an ellipsis. */
function cap(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '')}…`;
}

/** First `count` sentences of plain text, capped at `max` characters. */
function sentences(text, count, max) {
  const plain = stripMarkdown(text);
  const found = plain.split(/(?<=[.!?])\s+/);
  return cap(found.slice(0, count).join(' ').trim(), max);
}

module.exports = { lastAssistantText, sessionTitle, stripMarkdown, sentences };
