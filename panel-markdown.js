// A small Markdown renderer for the panel, close to how Claude Code shows replies.
// It builds DOM nodes with textContent only (never innerHTML), so text from Claude
// can never run as code. Links show as text and are not clickable.
(() => {
  const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/;
  // Lines from Claude's /usage and /context that get a bar, like the interactive terminal shows.
  const LIMIT_LINE = /^(\S[^:]{0,60}):\s+(\d{1,3}(?:\.\d+)?)% used(?:\s+·\s+(.+))?$/;
  const SHARE_LINE = /^\s+(\d{1,3})%\s{2,}(.+)$/;
  const TOKENS_LINE = /^\s*(?:\*\*)?Tokens:?(?:\*\*)?:?\s+(.+?)\s+\((\d{1,3}(?:\.\d+)?)%\)\s*$/;
  const PERIOD_LINE = /^(Last \d+\s*[hdw]|Current \w+)\s+·\s+/;
  const PERCENT_CELL = /^\d{1,3}(?:\.\d+)?%$/;
  const BAR_WIDTH = 30;
  const SMALL_BAR_WIDTH = 10;
  const CELL_BAR_WIDTH = 16;

  function level(pct) {
    if (pct >= 80) return 'high';
    if (pct >= 50) return 'mid';
    return 'low';
  }

  /**
   * A text bar: █ for the used part, ░ for the rest. A limit bar turns amber and
   * orange as it fills. A neutral bar (a share in a table) keeps one color.
   */
  function bar(pct, width, { isNeutral = false } = {}) {
    const used = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    const el = document.createElement('span');
    el.className = `bar ${isNeutral ? 'low' : level(pct)}`;
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.textContent = '█'.repeat(used);
    const rest = document.createElement('span');
    rest.className = 'rest';
    rest.textContent = '░'.repeat(width - used);
    el.append(fill, rest);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${pct}%`);
    return el;
  }

  /** A limit line, for example "Current session: 60% used · resets 5:29pm". */
  function meter(label, pct, note) {
    const el = document.createElement('div');
    el.className = 'meter';
    const name = document.createElement('div');
    name.className = 'meter-label';
    name.textContent = label;
    const row = document.createElement('div');
    const value = document.createElement('span');
    value.className = 'meter-pct';
    value.textContent = ` ${pct}% used`;
    row.append(bar(pct, BAR_WIDTH), value);
    el.append(name, row);
    if (note) {
      const reset = document.createElement('div');
      reset.className = 'meter-note';
      reset.textContent = note.charAt(0).toUpperCase() + note.slice(1);
      el.append(reset);
    }
    return el;
  }

  function inline(parent, text) {
    for (const part of text.split(INLINE)) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        const el = document.createElement('strong');
        el.textContent = part.slice(2, -2);
        parent.append(el);
      } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        const el = document.createElement('code');
        el.textContent = part.slice(1, -1);
        parent.append(el);
      } else if (/^\[[^\]]+\]\([^)]+\)$/.test(part)) {
        const [, label, url] = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const el = document.createElement('span');
        el.className = 'link';
        el.textContent = label;
        el.title = url;
        parent.append(el);
      } else {
        parent.append(document.createTextNode(part));
      }
    }
  }

  function cells(row) {
    return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/\*\*|`/g, ''));
  }

  /** A Markdown table as aligned text, like a terminal shows it. */
  function table(rows) {
    const data = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map(cells);
    const widths = [];
    data.forEach((r) => r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); }));
    const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
    const pre = document.createElement('pre');
    pre.className = 'table';
    // A column where every value is a percentage gets a bar after each row.
    const body = data.slice(1);
    const pctColumn = body.length ? data[0].findIndex((_c, i) => body.every((r) => PERCENT_CELL.test(r[i] ?? ''))) : -1;
    pre.append(`${line(data[0]).trimEnd()}\n${widths.map((w) => '─'.repeat(w)).join('  ')}`);
    for (const r of body) {
      pre.append(`\n${pctColumn >= 0 ? line(r) : line(r).trimEnd()}`);
      if (pctColumn >= 0) pre.append(' ', bar(parseFloat(r[pctColumn]), CELL_BAR_WIDTH, { isNeutral: true }));
    }
    return pre;
  }

  /** Returns a DocumentFragment for the Markdown text. */
  function render(text) {
    const out = document.createDocumentFragment();
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        const code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        const pre = document.createElement('pre');
        pre.className = 'code';
        pre.textContent = code.join('\n');
        out.append(pre);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l)) {
        const rows = [];
        for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
        i--;
        out.append(table(rows));
        continue;
      }
      const limit = l.match(LIMIT_LINE);
      if (limit) {
        out.append(meter(limit[1], parseFloat(limit[2]), limit[3]));
        continue;
      }
      const tokens = l.match(TOKENS_LINE);
      if (tokens) {
        out.append(meter(`Context: ${tokens[1]}`, parseFloat(tokens[2])));
        continue;
      }
      const share = l.match(SHARE_LINE);
      if (share) {
        const row = document.createElement('div');
        row.className = 'share';
        const pct = Number(share[1]);
        row.append(bar(pct, SMALL_BAR_WIDTH), ` ${String(pct).padStart(3)}%  `);
        inline(row, share[2]);
        out.append(row);
        continue;
      }
      const div = document.createElement('div');
      if (PERIOD_LINE.test(l)) {
        div.className = 'md-h';
        inline(div, l);
        out.append(div);
        continue;
      }
      const heading = l.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      const item = l.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (heading) {
        div.className = 'md-h';
        inline(div, heading[1]);
      } else if (item) {
        div.className = 'md-li';
        div.style.paddingLeft = `${2 + Math.floor(item[1].length / 2) * 2}ch`;
        div.dataset.bullet = /\d/.test(item[2]) ? item[2] : '•';
        inline(div, item[3]);
      } else if (!l.trim()) {
        div.className = 'md-gap';
      } else {
        inline(div, l);
      }
      out.append(div);
    }
    return out;
  }

  window.renderMarkdown = render;
})();
