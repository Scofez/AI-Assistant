// Mini avatars left of Fern: one per Claude session, its subagent clones, and Fern's job clones.
// Each sprite frame is drawn once into a small canvas and cached. The row animates at 4 fps,
// and only while a mini avatar is busy.
(() => {
  const W = 16;
  const H = 20;
  const SCALE = 2;
  const FRAME_MS = 250;
  const ANIMATED = new Set(['working', 'thinking', 'attention']);
  const COLORS = {
    outline: '#1B1A2E', skin: '#F7D9C4', white: '#F4F6FA', shoe: '#17161F',
    alert: '#FF8A3D', sparkle: '#FFE27A', magic: '#8FD8FF', staff: '#7A5536',
  };
  const FERN = { hair: '#9D7CC6', dress: '#2A2836', eye: '#9B63D1' };

  const crowdEl = document.getElementById('crowd');
  const cache = new Map();
  const items = new Map();   // key -> { el, canvas, ctx, data }
  let frame = 0;
  let timer;

  function hash(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h);
  }

  /** Session colors come from the session id, so a session keeps its colors. */
  function paletteFor(seed) {
    if (seed === 'fern') return FERN;
    const hue = hash(seed) % 360;
    return { hair: `hsl(${hue} 45% 68%)`, dress: `hsl(${hue} 35% 32%)`, eye: `hsl(${hue} 60% 38%)` };
  }

  /** Returns a cached canvas with one frame of a mini avatar, outline included. */
  function sprite(palette, state, f, isFernClone) {
    const key = `${palette.hair}|${state}|${f}|${isFernClone}`;
    if (cache.has(key)) return cache.get(key);
    const grid = Array.from({ length: H + 2 }, () => new Array(W + 2).fill(null));
    const bob = state === 'working' && f === 1 ? -1 : 0;
    const rect = (x, y, w, h, color, isEffect = false) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const gy = y + j + 1 + (isEffect ? 0 : bob);
        const gx = x + i + 1;
        if (gy >= 0 && gy < H + 2 && gx >= 0 && gx < W + 2) grid[gy][gx] = color;
      }
    };
    rect(3, 2, 10, 11, palette.hair);
    rect(4, 11, 8, 6, palette.dress);
    rect(3, 14, 10, 3, palette.dress);
    rect(6, 11, 4, 1, COLORS.white);
    rect(5, 17, 2, 1, COLORS.shoe);
    rect(9, 17, 2, 1, COLORS.shoe);
    rect(4, 5, 8, 5, COLORS.skin);
    rect(4, 4, 8, 2, palette.hair);
    rect(3, 6, 1, 7, palette.hair);
    rect(12, 6, 1, 7, palette.hair);
    if (state === 'done') {
      rect(5, 8, 1, 1, COLORS.outline); rect(6, 7, 1, 1, COLORS.outline);
      rect(9, 7, 1, 1, COLORS.outline); rect(10, 8, 1, 1, COLORS.outline);
    } else if (state === 'idle' || state === 'sleeping') {
      rect(5, 8, 2, 1, COLORS.outline); rect(9, 8, 2, 1, COLORS.outline);
    } else {
      rect(6, 7, 1, 2, palette.eye); rect(9, 7, 1, 2, palette.eye);
    }
    if (isFernClone) {
      rect(1, 6, 1, 11, COLORS.staff);
      rect(1, 5, 1, 1, f === 1 ? COLORS.white : COLORS.magic);
    }

    // Outline around the body, before the effects.
    const filled = grid.map((row) => row.map(Boolean));
    for (let y = 0; y < H + 2; y++) for (let x = 0; x < W + 2; x++) {
      if (filled[y][x]) continue;
      if (filled[y - 1]?.[x] || filled[y + 1]?.[x] || filled[y][x - 1] || filled[y][x + 1]) grid[y][x] = COLORS.outline;
    }
    if (state === 'attention' && f === 0) { rect(14, 0, 1, 3, COLORS.alert, true); rect(14, 4, 1, 1, COLORS.alert, true); }
    if (state === 'thinking') rect(13 + f, 1, 1, 1, COLORS.white, true);
    if (state === 'done') { rect(14, 1, 1, 3, COLORS.sparkle, true); rect(13, 2, 3, 1, COLORS.sparkle, true); }

    const canvas = document.createElement('canvas');
    canvas.width = W + 2;
    canvas.height = H + 2;
    const c = canvas.getContext('2d');
    grid.forEach((row, y) => row.forEach((color, x) => {
      if (!color) return;
      c.fillStyle = color;
      c.fillRect(x, y, 1, 1);
    }));
    cache.set(key, canvas);
    return canvas;
  }

  function paint(item) {
    const { data, ctx } = item;
    const f = ANIMATED.has(data.state) ? frame : 0;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, item.canvas.width, item.canvas.height);
    if (data.kind === 'more') return;
    const isFernClone = data.kind === 'job' || data.kind === 'fernAgent';
    ctx.drawImage(sprite(paletteFor(data.seed), data.state, f, isFernClone), 0, 0, (W + 2) * SCALE, (H + 2) * SCALE);
  }

  function create(data) {
    const el = document.createElement('div');
    el.className = 'mini';
    const tag = document.createElement('div');
    tag.className = 'tag';
    const title = document.createElement('div');
    title.className = 'title';
    const place = document.createElement('div');
    place.className = 'place';
    tag.append(title, place);
    const canvas = document.createElement('canvas');
    canvas.width = (W + 2) * SCALE;
    canvas.height = (H + 2) * SCALE;
    el.append(tag, canvas);
    el.addEventListener('click', () => window.avatar.clickMini(data.key));
    return { el, canvas, ctx: canvas.getContext('2d'), title, place, data: {} };
  }

  /** Reuses existing elements by key, so only changed avatars are touched. */
  function update(list) {
    const keys = new Set(list.map((d) => d.key));
    for (const [key, item] of items) {
      if (!keys.has(key)) {
        item.el.remove();
        items.delete(key);
      }
    }
    list.forEach((data, index) => {
      const item = items.get(data.key) ?? create(data);
      items.set(data.key, item);
      if (crowdEl.children[index] !== item.el) crowdEl.insertBefore(item.el, crowdEl.children[index] ?? null);
      const prev = item.data;
      if (prev.title !== data.title) item.title.textContent = data.title;
      if (prev.place !== data.place) item.place.textContent = data.place;
      if (prev.state !== data.state || prev.seed !== data.seed) {
        item.el.className = `mini ${data.state}`;
        item.data = data;
        paint(item);
      }
      item.data = data;
      item.el.setAttribute('aria-label', `${data.title}, ${data.place}, ${data.state}`);
      const hint = { job: 'Click to see the job', fernAgent: "Click to see Fern's chat" }[data.kind] ?? 'Click to open its terminal';
      item.el.title = `${data.title}\n${data.place}\n${hint}`;
    });
    const isBusy = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      && list.some((d) => ANIMATED.has(d.state));
    if (isBusy && !timer) {
      timer = setInterval(() => {
        frame = 1 - frame;
        for (const item of items.values()) if (ANIMATED.has(item.data.state)) paint(item);
      }, FRAME_MS);
    } else if (!isBusy && timer) {
      clearInterval(timer);
      timer = undefined;
      frame = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Delivered prompts

  const ENVELOPE = [
    '#########',
    '##.....##',
    '#.#...#.#',
    '#..#.#..#',
    '#...#...#',
    '#.......#',
    '#########',
  ];
  let envelopeCanvas;

  /** A pixel envelope with an outline, drawn once. */
  function envelope() {
    if (envelopeCanvas) return envelopeCanvas;
    envelopeCanvas = document.createElement('canvas');
    envelopeCanvas.width = ENVELOPE[0].length + 2;
    envelopeCanvas.height = ENVELOPE.length + 2;
    const c = envelopeCanvas.getContext('2d');
    c.fillStyle = COLORS.outline;
    c.fillRect(0, 0, envelopeCanvas.width, envelopeCanvas.height);
    ENVELOPE.forEach((row, y) => [...row].forEach((ch, x) => {
      c.fillStyle = ch === '#' ? '#C9CEDB' : COLORS.white;
      c.fillRect(x + 1, y + 1, 1, 1);
    }));
    return envelopeCanvas;
  }

  /** Drops an envelope into the avatar with this key. Tries again once if the avatar is not there yet. */
  function deliver(key, isRetry = false) {
    const item = items.get(key);
    if (!item) {
      if (!isRetry) setTimeout(() => deliver(key, true), 400);
      return;
    }
    const icon = document.createElement('canvas');
    icon.className = 'envelope';
    icon.width = (ENVELOPE[0].length + 2) * SCALE;
    icon.height = (ENVELOPE.length + 2) * SCALE;
    const c = icon.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(envelope(), 0, 0, icon.width, icon.height);
    // The drop ends in the middle of the sprite, under the label box.
    icon.style.setProperty('--drop', `${item.el.offsetHeight - (H + 2) * SCALE * 0.6}px`);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) icon.style.animation = 'none';
    const done = () => {
      icon.remove();
      item.el.classList.add('got-mail');
      setTimeout(() => item.el.classList.remove('got-mail'), 300);
    };
    icon.addEventListener('animationend', done);
    if (icon.style.animation === 'none') setTimeout(done, 800);
    item.el.append(icon);
  }

  window.avatar.onCrowd(update);
  window.avatar.onDeliver(({ key }) => deliver(key));
})();
