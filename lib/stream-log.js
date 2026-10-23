// Helpers that turn Claude's stream-json messages into short log lines, like Claude Code shows them.

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

module.exports = { clip, describeToolCall, toolResultText };
