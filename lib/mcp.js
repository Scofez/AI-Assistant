const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

const MCP_CONFIG_FILE = path.join(CONFIG_DIR, 'mcp.json');
const SERVER_INFO = { name: 'fern', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

/** A new random token for this launch. */
function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Writes an MCP client config for one caller ("fern" or "job:<id>").
 * The caller header tells the server who asks. Only the owner can read the file.
 */
function writeMcpConfig({ port, token, caller, file = MCP_CONFIG_FILE }) {
  const configJson = {
    mcpServers: {
      fern: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}`, 'X-Fern-Caller': caller },
      },
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(configJson, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function isTokenValid(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(String(header ?? ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Minimal MCP server over Streamable HTTP with plain JSON replies (no SSE).
 * `toolsFor(caller)` maps a name to { description, inputSchema, handler(args, caller) }.
 */
function createMcpHandler(toolsFor, token) {
  async function call(msg, caller) {
    const { id, method, params } = msg ?? {};
    const tools = toolsFor(caller);
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
        });
      case 'tools/call': {
        const tool = tools[params?.name];
        if (!tool) return fail(-32602, `Unknown tool ${params?.name}`);
        try {
          const out = await tool.handler(params.arguments ?? {}, caller);
          return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: err.message }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  /** Handles one HTTP request on /mcp. `body` is the parsed JSON. */
  return async function handle(req, res, body) {
    if (!isTokenValid(req.headers.authorization, token)) {
      res.writeHead(401);
      return res.end();
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    const caller = String(req.headers['x-fern-caller'] ?? 'fern');
    const messages = Array.isArray(body) ? body : [body];
    const replies = await Promise.all(messages.filter((m) => m?.id !== undefined).map((m) => call(m, caller)));
    if (replies.length === 0) {
      // Only notifications, for example notifications/initialized.
      res.writeHead(202);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
  };
}

module.exports = { MCP_CONFIG_FILE, newToken, writeMcpConfig, createMcpHandler };
