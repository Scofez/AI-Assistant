#!/usr/bin/env node
// Generates the placeholder Fern sprite pack in sprites/default and the tray icon.
// Every frame is drawn in code as pixels. Replace with real art later.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SIZE = 64;
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'sprites', 'default');
const ASSET_DIR = path.join(ROOT, 'assets');

const PALETTE = {
  outline: '#1B1A2E',
  skin: '#F7D9C4',
  skinShadow: '#E0B39B',
  hair: '#9D7CC6',
  hairShadow: '#6C4F99',
  eye: '#9B63D1',
  eyeDark: '#4E2F7A',
  dress: '#2A2836',
  dressShadow: '#17161F',
  white: '#F4F6FA',
  whiteShadow: '#C9CEDB',
  staff: '#7A5536',
  blush: '#F29AA8',
  sparkle: '#FFE27A',
  alert: '#FF8A3D',
  magic: '#8FD8FF',
};

const RGB = Object.fromEntries(
  Object.entries(PALETTE).map(([name, hex]) => [
    name,
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
  ]),
);

/** A 64×64 layer that stores palette names, or undefined for transparent. */
class Layer {
  constructor() {
    this.px = new Array(SIZE * SIZE).fill(undefined);
  }
  set(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    this.px[y * SIZE + x] = color;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return undefined;
    return this.px[y * SIZE + x];
  }
  rect(x0, y0, x1, y1, color) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, color);
  }
  ellipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / (rx + 0.5);
        const dy = (y - cy) / (ry + 0.5);
        if (dx * dx + dy * dy <= 1) this.set(x, y, color);
      }
    }
  }
  /** Fills rows y0..y1 between two lines that go from x0a..x1a at y0 to x0b..x1b at y1. */
  trapezoid(y0, y1, x0a, x1a, x0b, x1b, color) {
    for (let y = y0; y <= y1; y++) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      const xl = Math.round(x0a + (x0b - x0a) * t);
      const xr = Math.round(x1a + (x1b - x1a) * t);
      for (let x = xl; x <= xr; x++) this.set(x, y, color);
    }
  }
  points(list, color, dx = 0, dy = 0) {
    for (const [x, y] of list) this.set(x + dx, y + dy, color);
  }
  /** Adds a 1 px outline around every opaque pixel (4-neighbour). */
  outlined() {
    const out = new Layer();
    out.px = this.px.slice();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) {
          out.set(x, y, 'outline');
        }
      }
    }
    return out;
  }
  drawOver(other) {
    for (let i = 0; i < other.px.length; i++) if (other.px[i]) this.px[i] = other.px[i];
    return this;
  }
}

// Pixel glyphs for effects. '#' is fill.
const GLYPHS = {
  question: ['.###.', '#...#', '...#.', '..#..', '.....', '..#..'],
  exclaim: ['##', '##', '##', '##', '##', '..', '##'],
  zSmall: ['###', '..#', '.#.', '#..', '###'],
  zBig: ['####', '...#', '..#.', '.#..', '#...', '####'],
  dots: ['#.#.#'],
  sparkle: ['..#..', '..#..', '#####', '..#..', '..#..'],
  sparkleSmall: ['.#.', '###', '.#.'],
};

function glyph(layer, name, x, y, color) {
  GLYPHS[name].forEach((row, j) => {
    [...row].forEach((ch, i) => {
      if (ch === '#') layer.set(x + i, y + j, color);
    });
  });
}

/** An effect layer gets its own outline so it reads on any desktop. */
function effect(drawFn) {
  const layer = new Layer();
  drawFn(layer);
  return layer.outlined();
}

// ---------------------------------------------------------------------------
// Character parts. All coordinates are for the standing pose at offset 0.

function drawBackHair(l, o) {
  const { dx, dy, hx, hy } = o;
  if (o.sitting) {
    l.trapezoid(18 + hy, 56, 19 + hx, 45 + hx, 15 + dx, 49 + dx, 'hair');
    l.rect(17 + dx, 54, 47 + dx, 56, 'hairShadow');
    return;
  }
  l.rect(19 + dx, 18 + dy, 45 + dx, 50 + dy, 'hair');
  l.rect(19 + dx, 40 + dy, 20 + dx, 50 + dy, 'hairShadow');
  l.rect(44 + dx, 40 + dy, 45 + dx, 50 + dy, 'hairShadow');
  // Uneven hair ends.
  l.points([[19, 50], [22, 50], [42, 50], [45, 50]], undefined, dx, dy);
  l.points([[20, 51], [21, 51], [43, 51], [44, 51]], 'hairShadow', dx, dy);
}

function drawBody(l, o) {
  const { dx, dy } = o;
  const b = o.breath ? -1 : 0;
  if (o.sitting) {
    l.ellipse(32 + dx, 54, 17, 6, 'dress');
    l.rect(16 + dx, 58, 48 + dx, 59, 'dressShadow');
    l.trapezoid(36 + dy, 50, 26 + dx, 38 + dx, 24 + dx, 40 + dx, 'dress');
    l.trapezoid(36 + dy, 38 + dy, 25 + dx, 39 + dx, 24 + dx, 40 + dx, 'white');
    l.points([[25, 39], [28, 39], [31, 39], [34, 39], [37, 39], [40, 39]], 'whiteShadow', dx, dy);
    return;
  }
  // Torso and long skirt.
  l.trapezoid(32 + dy + b, 44 + dy, 25 + dx, 39 + dx, 24 + dx, 40 + dx, 'dress');
  const flare = o.skirtOut ? 3 : 0;
  l.trapezoid(44 + dy, 58, 24 + dx, 40 + dx, 20 + dx - flare, 44 + dx + flare, 'dress');
  l.trapezoid(46 + dy, 58, 38 + dx, 40 + dx, 41 + dx + flare, 44 + dx + flare, 'dressShadow');
  l.rect(21 + dx - flare, 58, 43 + dx + flare, 58, 'dressShadow');
  // Shoes.
  l.rect(26 + dx, 59, 30 + dx, 60, 'dressShadow');
  l.rect(34 + dx, 59, 38 + dx, 60, 'dressShadow');
  // White frilled collar and front line.
  l.trapezoid(32 + dy + b, 35 + dy + b, 26 + dx, 38 + dx, 24 + dx, 40 + dx, 'white');
  for (let x = 24; x <= 40; x += 3) l.set(x + dx, 35 + dy + b, 'whiteShadow');
  l.rect(32 + dx, 36 + dy + b, 32 + dx, 44 + dy, 'whiteShadow');
}

function drawHead(l, o) {
  const x = o.hx;
  const y = o.hy;
  // Hair volume behind the face.
  l.ellipse(32 + x, 20 + y, 13, 11, 'hair');
  // Face.
  l.ellipse(32 + x, 23 + y, 9, 8, 'skin');
  l.rect(30 + x, 30 + y, 34 + x, 31 + y, 'skin');
  l.rect(30 + x, 31 + y, 34 + x, 31 + y, 'skinShadow');
  // Side locks that frame the face.
  const sway = o.sway || 0;
  l.trapezoid(15 + y, 35 + y, 21 + x, 24 + x, 21 + x + sway, 22 + x + sway, 'hair');
  l.trapezoid(15 + y, 35 + y, 40 + x, 43 + x, 42 + x + sway, 43 + x + sway, 'hair');
  l.rect(21 + x + sway, 30 + y, 21 + x + sway, 35 + y, 'hairShadow');
  l.rect(43 + x + sway, 30 + y, 43 + x + sway, 35 + y, 'hairShadow');
  // Straight bangs with a few strands.
  l.rect(22 + x, 11 + y, 42 + x, 17 + y, 'hair');
  l.points([[23, 18], [24, 18], [27, 18], [28, 18], [29, 18], [32, 18], [33, 18], [36, 18], [37, 18], [40, 18], [41, 18]], 'hair', x, y);
  l.points([[25, 18], [30, 18], [34, 18], [38, 18]], 'skinShadow', x, y);
  l.rect(22 + x, 12 + y, 42 + x, 12 + y, 'hairShadow');
  l.points([[26, 11], [27, 11], [28, 11]], 'white', x, y);
  // Butterfly hair ornament.
  l.points([[17, 13], [18, 13], [17, 14], [18, 14], [19, 14], [20, 15], [17, 16], [18, 16], [19, 16], [18, 17]], 'white', x, y);
  l.points([[18, 15], [19, 15]], 'whiteShadow', x, y);
}

function drawEyes(l, o) {
  const x = o.hx;
  const y = o.hy;
  for (const ex of [26, 35]) {
    const X = ex + x;
    const outer = ex === 26 ? X - 1 : X + 4;
    switch (o.eyes) {
      case 'open':
      case 'up':
        l.rect(X, 21 + y, X + 3, 21 + y, 'outline');
        l.set(outer, 22 + y, 'outline');
        l.rect(X, 22 + y, X + 3, 24 + y, 'eye');
        if (o.eyes === 'up') {
          l.rect(X + 1, 22 + y, X + 2, 22 + y, 'eyeDark');
          l.set(X + 2, 22 + y, 'white');
        } else {
          l.rect(X + 1, 23 + y, X + 2, 24 + y, 'eyeDark');
          l.set(X + 1, 22 + y, 'white');
        }
        break;
      case 'wide':
        l.rect(X, 20 + y, X + 3, 20 + y, 'outline');
        l.rect(X, 21 + y, X + 3, 24 + y, 'eye');
        l.rect(X + 1, 22 + y, X + 2, 23 + y, 'eyeDark');
        l.set(X, 21 + y, 'white');
        break;
      case 'focus':
        l.rect(X - 1, 22 + y, X + 4, 22 + y, 'outline');
        l.rect(X, 23 + y, X + 3, 24 + y, 'eye');
        l.rect(X + 1, 23 + y, X + 2, 24 + y, 'eyeDark');
        break;
      case 'happy':
        l.points([[0, 24], [1, 23], [2, 23], [3, 24]], 'outline', X, y);
        break;
      case 'closed':
        l.points([[0, 23], [1, 24], [2, 24], [3, 23]], 'outline', X, y);
        break;
      default: // blink
        l.rect(X, 23 + y, X + 3, 23 + y, 'outline');
    }
  }
  if (o.blush) {
    l.rect(24 + x, 26 + y, 25 + x, 26 + y, 'blush');
    l.rect(39 + x, 26 + y, 40 + x, 26 + y, 'blush');
  }
  if (o.mouth === 'smile') l.points([[30, 27], [31, 28], [32, 28], [33, 27]], 'outline', x, y);
  else if (o.mouth === 'open') drawMouthOpen(l, x, y);
  else l.points([[31, 28], [32, 28]], 'outline', x, y);
}

function drawMouthOpen(l, x, y) {
  l.points([[31, 27], [32, 27], [33, 27], [31, 28], [33, 28], [31, 29], [32, 29], [33, 29]], 'outline', x, y);
  l.set(32 + x, 28 + y, 'blush');
}

function drawStaff(l, o) {
  const { dx, dy } = o;
  l.rect(15 + dx, 18 + dy, 16 + dx, 60, 'staff');
  // Ring head with a gem.
  l.points([[14, 13], [15, 12], [16, 12], [17, 13], [13, 14], [18, 14], [13, 15], [18, 15], [14, 16], [17, 16], [15, 17], [16, 17]], 'sparkle', dx, dy);
  l.points([[15, 14], [16, 14], [15, 15], [16, 15]], o.staffGlow ? 'white' : 'magic', dx, dy);
}

function drawArms(l, o) {
  const { dx, dy } = o;
  const b = o.breath ? -1 : 0;
  const leftArm = () => {
    // Viewer's left arm reaches out to hold the staff.
    l.trapezoid(33 + dy + b, 38 + dy, 22 + dx, 26 + dx, 18 + dx, 23 + dx, 'dress');
    l.rect(18 + dx, 37 + dy, 19 + dx, 39 + dy, 'white');
    l.rect(15 + dx, 37 + dy, 17 + dx, 40 + dy, 'skin');
  };
  const rightArmDown = () => {
    l.rect(39 + dx, 33 + dy + b, 42 + dx, 43 + dy, 'dress');
    l.rect(42 + dx, 36 + dy, 42 + dx, 43 + dy, 'dressShadow');
    l.rect(39 + dx, 44 + dy, 42 + dx, 44 + dy, 'white');
    l.rect(40 + dx, 45 + dy, 42 + dx, 47 + dy, 'skin');
  };
  const rightArmUp = (handX) => {
    l.trapezoid(26 + dy, 35 + dy, 41 + dx + (handX - 44), 44 + dx + (handX - 44), 39 + dx, 42 + dx, 'dress');
    l.rect(41 + dx + (handX - 44), 25 + dy, 44 + dx + (handX - 44), 25 + dy, 'white');
    l.rect(41 + dx + (handX - 44), 21 + dy, 44 + dx + (handX - 44), 24 + dy, 'skin');
  };
  switch (o.arms) {
    case 'folded':
      l.rect(23 + dx, 33 + dy + b, 26 + dx, 39 + dy, 'dress');
      l.rect(38 + dx, 33 + dy + b, 41 + dx, 39 + dy, 'dress');
      l.rect(25 + dx, 39 + dy, 29 + dx, 42 + dy, 'dress');
      l.rect(35 + dx, 39 + dy, 39 + dx, 42 + dy, 'dress');
      l.rect(23 + dx, 35 + dy, 23 + dx, 39 + dy, 'dressShadow');
      l.rect(41 + dx, 35 + dy, 41 + dx, 39 + dy, 'dressShadow');
      l.rect(28 + dx, 40 + dy, 29 + dx, 42 + dy, 'white');
      l.rect(35 + dx, 40 + dy, 36 + dx, 42 + dy, 'white');
      l.rect(30 + dx, 40 + dy, 34 + dx, 43 + dy, 'skin');
      l.rect(30 + dx, 42 + dy, 34 + dx, 42 + dy, 'skinShadow');
      break;
    case 'chin':
      leftArm();
      // Viewer's right hand rests under the chin.
      l.trapezoid(33 + dy, 38 + dy, 38 + dx, 41 + dx, 36 + dx, 40 + dx, 'dress');
      l.rect(35 + dx, 33 + dy, 38 + dx, 34 + dy, 'white');
      l.rect(34 + dx, 30 + o.hy, 37 + dx, 32 + o.hy, 'skin');
      l.set(34 + dx, 29 + o.hy, 'skin');
      break;
    case 'staff':
      leftArm();
      rightArmDown();
      break;
    case 'raise':
      leftArm();
      rightArmUp(44);
      break;
    case 'wave1':
      rightArmUp(44);
      l.rect(23 + dx, 33 + dy, 26 + dx, 43 + dy, 'dress');
      l.rect(23 + dx, 44 + dy, 26 + dx, 44 + dy, 'white');
      l.rect(23 + dx, 45 + dy, 25 + dx, 47 + dy, 'skin');
      break;
    case 'wave2':
      rightArmUp(46);
      l.rect(23 + dx, 33 + dy, 26 + dx, 43 + dy, 'dress');
      l.rect(23 + dx, 44 + dy, 26 + dx, 44 + dy, 'white');
      l.rect(23 + dx, 45 + dy, 25 + dx, 47 + dy, 'skin');
      break;
    case 'skirt':
      // Curtsy: both hands hold the skirt out.
      l.trapezoid(33 + dy, 43 + dy, 23 + dx, 26 + dx, 19 + dx, 22 + dx, 'dress');
      l.trapezoid(33 + dy, 43 + dy, 38 + dx, 41 + dx, 42 + dx, 45 + dx, 'dress');
      l.rect(18 + dx, 44 + dy, 20 + dx, 46 + dy, 'skin');
      l.rect(44 + dx, 44 + dy, 46 + dx, 46 + dy, 'skin');
      break;
    case 'lap':
      l.rect(24 + dx, 38 + dy, 27 + dx, 46, 'dress');
      l.rect(37 + dx, 38 + dy, 40 + dx, 46, 'dress');
      l.rect(28 + dx, 46, 36 + dx, 48, 'skin');
      break;
    default:
      break;
  }
}

/**
 * Draws one Fern frame.
 * dx/dy move the whole body. hx/hy move the head relative to the frame.
 */
function fern(opts) {
  const o = {
    dx: 0, dy: 0, hx: 0, hy: 0, eyes: 'open', mouth: 'neutral', arms: 'folded',
    staff: false, breath: false, sitting: false, blush: false, ...opts,
  };
  o.hx += o.dx;
  o.hy += o.dy;
  const l = new Layer();
  drawBackHair(l, o);
  if (o.staff) drawStaff(l, o);
  drawBody(l, o);
  drawHead(l, o);
  drawEyes(l, o);
  drawArms(l, o);
  return l.outlined();
}

// ---------------------------------------------------------------------------
// States. `mouth` lists the head offset per frame, so the talking overlay sits on the mouth.

function idle() {
  return [
    fern({}),
    fern({}),
    fern({ breath: true }),
    fern({ breath: true, eyes: 'blink' }),
  ];
}

function thinking() {
  return [0, 1, 2, 3].map((i) => {
    const frame = fern({ arms: 'chin', staff: true, eyes: 'up', sway: i % 2 === 0 ? 0 : 1 });
    const bob = i === 1 || i === 2 ? -1 : 0;
    return frame.drawOver(effect((e) => {
      if (i < 2) glyph(e, 'question', 46, 3 + bob, 'white');
      else glyph(e, 'dots', 45, 8, 'white');
    }));
  });
}

function working() {
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const frame = fern({ arms: 'staff', staff: true, eyes: 'focus', staffGlow: i % 2 === 1 });
    return frame.drawOver(effect((e) => {
      // A magic bolt leaves the staff and flies left. Sparks circle the ring.
      const tip = 12 - i * 2;
      if (i >= 1) e.rect(Math.max(0, tip - 6), 14, tip, 15, 'magic');
      if (i >= 2) e.rect(Math.max(0, tip - 9), 14, Math.max(0, tip - 7), 15, 'white');
      const sparks = [[20, 10], [11, 9], [20, 18], [10, 19]];
      const [sx, sy] = sparks[i % sparks.length];
      glyph(e, 'sparkleSmall', sx, sy, i % 2 ? 'magic' : 'white');
    }));
  });
}

function attention() {
  const hops = [0, -2, -2, 0];
  return hops.map((dy, i) => fern({ arms: 'raise', staff: true, staffGlow: true, eyes: 'wide', dy })
    .drawOver(effect((e) => {
      if (i !== 3) glyph(e, 'exclaim', 51, 2 + dy, 'alert');
    })));
}

function done() {
  const sparkle = (e, i) => {
    const spots = [[[6, 8], [52, 20]], [[10, 22], [50, 6]], [[4, 14], [54, 14], [46, 2]]];
    for (const [x, y] of spots[i % 3]) glyph(e, i % 2 ? 'sparkleSmall' : 'sparkle', x, y, 'sparkle');
  };
  return [
    fern({ arms: 'skirt', skirtOut: true }),
    fern({ arms: 'skirt', skirtOut: true, dy: 1, eyes: 'closed' }),
    fern({ arms: 'skirt', skirtOut: true, dy: 2, eyes: 'closed' }),
    fern({ eyes: 'happy', mouth: 'smile', blush: true }).drawOver(effect((e) => sparkle(e, 0))),
    fern({ eyes: 'happy', mouth: 'smile', blush: true }).drawOver(effect((e) => sparkle(e, 1))),
    fern({ eyes: 'happy', mouth: 'smile', blush: true }).drawOver(effect((e) => sparkle(e, 2))),
  ];
}

function sleeping() {
  const zs = [[44, 22, 'zSmall'], [46, 16, 'zSmall'], [48, 9, 'zBig'], [50, 3, 'zBig']];
  return zs.map(([x, y, g], i) => fern({
    sitting: true, arms: 'lap', eyes: 'closed', dy: 4, hx: 2, hy: 8 + (i % 2),
  }).drawOver(effect((e) => glyph(e, g, x, y, 'white'))));
}

function greet() {
  return [
    fern({ hy: 1, eyes: 'closed' }),
    fern({ hy: 2, eyes: 'closed' }),
    fern({ arms: 'wave1', eyes: 'happy', mouth: 'smile', blush: true }),
    fern({ arms: 'wave2', eyes: 'happy', mouth: 'smile', blush: true }),
  ];
}

/** Talking overlay: skin patch over the mouth area, then a closed or open mouth. */
function talking() {
  return [false, true].map((open) => {
    const l = new Layer();
    l.rect(29, 26, 35, 29, 'skin');
    if (open) drawMouthOpen(l, 0, 0);
    else l.points([[31, 28], [32, 28]], 'outline');
    return l;
  });
}

// ---------------------------------------------------------------------------

function writeSheet(file, frames) {
  const png = new PNG({ width: SIZE * frames.length, height: SIZE });
  frames.forEach((frame, f) => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const name = frame.get(x, y);
        const i = (y * png.width + f * SIZE + x) * 4;
        if (!name) continue;
        const [r, g, b] = RGB[name];
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
    }
  });
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Tray template image: black silhouette of a staff ring, alpha only. */
function writeTrayIcon(file, size) {
  const png = new PNG({ width: size, height: size });
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ringY = size * 0.36;
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - ringY);
      const ring = d <= size * 0.3 && d >= size * 0.17;
      const gem = d <= size * 0.08;
      const pole = Math.abs(x + 0.5 - c) <= size * 0.07 && y >= ringY + size * 0.28;
      if (ring || gem || pole) png.data[(y * size + x) * 4 + 3] = 255;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

const STATES = {
  idle: { draw: idle, fps: 4, loop: true },
  thinking: { draw: thinking, fps: 4, loop: true },
  working: { draw: working, fps: 10, loop: true },
  attention: { draw: attention, fps: 8, loop: true, mouth: [[0, 0], [0, -2], [0, -2], [0, 0]] },
  done: { draw: done, fps: 8, loop: false, mouth: [[0, 0], [0, 1], [0, 2], [0, 0], [0, 0], [0, 0]] },
  sleeping: { draw: sleeping, fps: 2, loop: true, mouth: [[2, 12], [2, 13], [2, 12], [2, 13]] },
  greet: { draw: greet, fps: 6, loop: false, mouth: [[0, 1], [0, 2], [0, 0], [0, 0]] },
  talking: { draw: talking, fps: 8, loop: true, overlay: true },
};

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const manifest = { frameWidth: SIZE, frameHeight: SIZE, states: {} };
  for (const [name, spec] of Object.entries(STATES)) {
    const frames = spec.draw();
    writeSheet(path.join(OUT_DIR, `${name}.png`), frames);
    manifest.states[name] = {
      file: `${name}.png`,
      frames: frames.length,
      fps: spec.fps,
      loop: spec.loop,
      ...(spec.overlay ? { overlay: true } : {}),
      ...(spec.mouth ? { mouthOffsets: spec.mouth } : {}),
    };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeTrayIcon(path.join(ASSET_DIR, 'trayTemplate.png'), 18);
  writeTrayIcon(path.join(ASSET_DIR, 'trayTemplate@2x.png'), 36);
  console.log(`Wrote ${Object.keys(STATES).length} sheets to ${path.relative(ROOT, OUT_DIR)}`);
}

main();
