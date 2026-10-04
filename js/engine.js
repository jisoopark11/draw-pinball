/*
 * Draw Pinball – physics + map engine (no dependencies).
 * Works in the browser (window.PinEngine) and in Node (module.exports) so it can be tested headlessly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PinEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- constants ----------
  const W = 540;               // world width
  const SPAWN_H = 300;         // hopper height at the top where balls are placed
  const MAX_BALLS = 200;
  const GRAVITY = 520;
  const DRAG = 0.5;            // 1/s linear drag
  const MAX_SPEED = 900;
  const BALL_E = 0.45;         // ball-ball restitution
  const FRICTION = 0.003;      // tangential damping per contact step (120 Hz)
  const DT = 1 / 120;
  const BUCKET = 64;
  const TIME_LIMIT = 300;      // safety: force-finish after this many simulated seconds

  // ---------- random ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomSeed() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      return crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return Math.floor(Math.random() * 4294967296);
  }
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- input parsing ----------
  // "No1, No2*3, Kim" -> one ball per count. Separators: comma / newline / semicolon.
  function parseEntries(text) {
    const tokens = String(text || '').split(/[,\n;，]+/).map(s => s.trim()).filter(Boolean);
    const balls = [];
    const warnings = [];
    for (const tok of tokens) {
      const m = tok.match(/^(.*?)\s*[*×]\s*(\d+)$/);
      let name = tok, count = 1;
      if (m && m[1].trim()) {
        name = m[1].trim();
        count = parseInt(m[2], 10);
        if (count < 1) { warnings.push(`"${tok}": 개수는 1 이상이어야 합니다`); continue; }
      }
      for (let i = 0; i < count; i++) {
        if (balls.length >= MAX_BALLS) break;
        balls.push(name);
      }
    }
    if (balls.length >= MAX_BALLS) warnings.push(`최대 ${MAX_BALLS}개까지만 사용됩니다`);
    return { balls, warnings };
  }

  // "1-3, 5, 8~10" -> sorted unique ranks within 1..n
  function parseRanges(text, n) {
    const out = new Set();
    for (const tok of String(text || '').split(/[,\s;]+/).filter(Boolean)) {
      const m = tok.match(/^(\d+)(?:[-~–](\d+))?$/);
      if (!m) continue;
      let a = parseInt(m[1], 10);
      let b = m[2] ? parseInt(m[2], 10) : a;
      if (a > b) [a, b] = [b, a];
      for (let r = Math.max(1, a); r <= Math.min(n, b); r++) out.add(r);
    }
    return Array.from(out).sort((x, y) => x - y);
  }

  // Round-robin grouping by finishing rank: rank r goes to group ((r - 1) % groups) + 1
  function groupOf(rank, groups) { return ((rank - 1) % groups) + 1; }
  function buildGroups(ranking, groups) {
    const out = Array.from({ length: groups }, () => []);
    ranking.forEach((b, i) => out[groupOf(i + 1, groups)- 1].push({ rank: i + 1, ball: b }));
    return out;
  }

  function winnerRanks(mode, rangesText, n) {
    if (mode === 'group') return [];            // groups have no single winners
    if (mode === 'first') return [1];
    if (mode === 'last') return [n];
    return parseRanges(rangesText, n);
  }

  // ---------- map ----------
  function circle(x, y, r, e, extra) {
    return Object.assign({ kind: 0, x, y, r, e, vx: 0, vy: 0, type: 'peg' }, extra || {});
  }
  function seg(x1, y1, x2, y2, r, e, extra) {
    return Object.assign({ kind: 1, x1, y1, x2, y2, r, e, w: 0, cx: 0, cy: 0, type: 'bar' }, extra || {});
  }

  function generateMap(seed) {
    const rng = mulberry32(seed);
    const R = (a, b) => a + rng() * (b - a);
    const colliders = [];
    const dynamic = [];
    const add = c => { colliders.push(c); return c; };
    const zones = [];
    const portals = [];
    const slams = [];
    const E_shuffle = a => shuffle(a, rng);

    function spinner(cx, cy, hl, w, ang0, r) {
      const s = add(seg(cx - hl, cy, cx + hl, cy, r, 0.6, { type: 'spinner', w, cx, cy, hl, ang0 }));
      s.update = function (t) {
        const a = this.ang0 + this.w * t, c = Math.cos(a) * this.hl, sn = Math.sin(a) * this.hl;
        this.x1 = this.cx - c; this.y1 = this.cy - sn; this.x2 = this.cx + c; this.y2 = this.cy + sn;
      };
      s.update(0);
      dynamic.push(s);
      return s;
    }
    function spinnerRow(cy, cnt) {
      const spacing = W / cnt;
      for (let k = 0; k < cnt; k++) {
        spinner(spacing * (k + 0.5) + R(-10, 10), cy + R(-8, 8), spacing * 0.375, (rng() < 0.5 ? -1 : 1) * R(1.4, 3.2), R(0, Math.PI), 5);
      }
    }
    // door that blocks balls while closed and lets them through while open
    function gate(x0, x1, y, period, open) {
      const g = add(seg(x0, y, x1, y, 4, 0.3, { type: 'gate', off: false, period, open, phase: R(0, period) }));
      g.update = function (t) { this.off = ((t + this.phase) % this.period) < this.period * this.open; };
      g.update(0);
      dynamic.push(g);
      return g;
    }
    // region that pushes balls while "on"
    function zone(x0, y0, x1, y1, ax, ay, period, duty) {
      const z = { x0, y0, x1, y1, ax, ay, period, duty, phase: R(0, period), on: true };
      z.update = function (t) { this.on = ((t + this.phase) % this.period) < this.period * this.duty; };
      z.update(0);
      zones.push(z);
      return z;
    }

    const builders = {
      pegs(y) {
        const big = rng() < 0.3;              // sparse big pegs vs dense small pegs
        const rows = big ? 3 : 3 + Math.floor(rng() * 2);
        const gap = big ? 70 : 56, sp = big ? 92 : 62;
        for (let row = 0; row < rows; row++) {
          const off = row % 2 ? sp / 2 : 0;
          for (let x = off + sp / 2; x < W - 16; x += sp) {
            if (rng() < 0.08) continue;
            const r = big ? R(8, 12) : R(4, 6.5);
            add(circle(x + R(-6, 6), y + 22 + row * gap + R(-5, 5), r, big ? 0.7 : 0.55, { type: 'peg' }));
          }
        }
        return rows * gap + 30;
      },
      windmill(y) {
        const cx = W / 2 + R(-60, 60), cy = y + 115, w = (rng() < 0.5 ? -1 : 1) * R(1.0, 2.0);
        const a0 = R(0, 3);
        spinner(cx, cy, 115, w, a0, 6);
        spinner(cx, cy, 115, w, a0 + Math.PI / 2, 6);
        for (const sx of [50, W - 50]) add(circle(sx + R(-10, 10), y + R(60, 170), R(6, 9), 0.7));
        return 235;
      },
      lanes(y) {
        const K = 3 + Math.floor(rng() * 2), lw = W / K, top = y + 24, LH = 300;
        for (let i = 1; i < K; i++) {
          add(seg(lw * i, top + 14, lw * i, top + LH, 4, 0.4, { type: 'bar' }));
          add(circle(lw * i, top + 6, 7, 0.7, { type: 'bumper' }));
        }
        const all = ['free', 'zigzag', 'wind', 'gate'];
        let types = E_shuffle(K === 3 ? ['free', 'zigzag', 'gate'] : all);
        if (rng() < 0.4) types[1 + Math.floor(rng() * (K - 1))] = all[Math.floor(rng() * 4)];
        types.forEach((tp, i) => {
          const x0 = lw * i + 4, x1 = lw * (i + 1) - 4;
          if (tp === 'zigzag') {
            let left = rng() < 0.5; const L = (x1 - x0) * 0.66;
            for (let k = 0; k < 3; k++) {
              const yy = top + 50 + k * 80;
              if (left) add(seg(x0, yy, x0 + L, yy + L * 0.26, 4, 0.4, { type: 'slope' }));
              else add(seg(x1, yy, x1 - L, yy + L * 0.26, 4, 0.4, { type: 'slope' }));
              left = !left;
            }
          } else if (tp === 'wind') {
            zone(x0, top + 40, x1, top + LH - 20, 0, -GRAVITY * R(1.3, 2.0), R(2.5, 4.5), 0.5);
          } else if (tp === 'gate') {
            gate(x0, x1, top + LH - 30, R(3, 5), 0.4);
          }
        });
        return LH + 90;
      },
      // three holes in a ridged floor; each hole is a portal: shortcut forward, sent back, or plain pass-through
      portals(y) {
        const K = 3, hw = 30, lip = y + 130, peak = y + 85;
        const kinds = E_shuffle(['fwd', 'back', 'stay']);
        const hc = [];
        for (let i = 0; i < K; i++) hc.push(W * (i + 0.5) / K + R(-25, 25));
        const sl = (x1, y1, x2, y2) => add(seg(x1, y1, x2, y2, 4, 0.4, { type: 'slope' }));
        sl(0, peak, hc[0] - hw, lip);
        for (let i = 0; i < K - 1; i++) {
          const xm = (hc[i] + hw + hc[i + 1] - hw) / 2;
          sl(hc[i] + hw, lip, xm, peak); sl(xm, peak, hc[i + 1] - hw, lip);
        }
        sl(hc[K - 1] + hw, lip, W, peak);
        hc.forEach((c, i) => portals.push({ x0: c - hw + 6, x1: c + hw - 6, y0: lip, y1: lip + 50, cx: c, cy: lip + 14, kind: kinds[i], destY: 0 }));
        return 200;
      },
      // pad that only reacts to the front-runners: they get knocked back up, everyone else passes through
      slam(y) {
        slams.push({ id: slams.length, y0: y + 36, y1: y + 70, frac: R(0.35, 0.5), destY: 0 });
        if (rng() < 0.5) spinnerRow(y + 140, 3);
        else for (let row = 0; row < 2; row++) {
          for (let x = (row ? 35 : 0) + 45; x < W - 20; x += 70) add(circle(x + R(-7, 7), y + 115 + row * 52 + R(-5, 5), R(4, 6.5), 0.55));
        }
        return 215;
      },
      gates(y) {
        for (let i = 0; i < 3; i++) gate(W / 3 * i, W / 3 * (i + 1), y + 30, R(3, 5.5), R(0.35, 0.5));
        for (let row = 0; row < 2; row++) {
          for (let x = 40 + row * 30; x < W - 20; x += 60) add(circle(x + R(-6, 6), y + 80 + row * 50, R(4, 6), 0.55));
        }
        return 190;
      },
      wind(y) {
        const up = rng() < 0.5, h = 230;
        const period = R(2.5, 4), duty = R(0.45, 0.6);
        if (up) zone(0, y, W, y + h, 0, -GRAVITY * R(1.4, 2.2), period, duty);
        else zone(0, y, W, y + h, (rng() < 0.5 ? -1 : 1) * R(500, 900), 0, period, duty);
        if (rng() < 0.5) spinnerRow(y + 115, 3);
        else for (let row = 0; row < 3; row++) {
          for (let x = (row % 2 ? 30 : 0) + 45; x < W - 20; x += 80) add(circle(x + R(-8, 8), y + 40 + row * 70 + R(-6, 6), R(4, 6), 0.55));
        }
        return h + 30;
      },
      spinners(y) {
        const rows = rng() < 0.45 ? 2 : 1;                 // sometimes two staggered rows
        for (let r = 0; r < rows; r++) {
          const cnt = 2 + Math.floor(rng() * 2);
          const spacing = W / cnt;
          for (let k = 0; k < cnt; k++) {
            const cx = spacing * (k + 0.5) + R(-12, 12);
            const cy = y + 60 + r * 135 + R(-8, 8);
            const hl = spacing * 0.375;
            const w = (rng() < 0.5 ? -1 : 1) * R(1.4, 3.2);
            spinner(cx, cy, hl, w, R(0, Math.PI), 5);
          }
        }
        return 125 + (rows - 1) * 135;
      },
      slopes(y) {
        const L = W * 0.66, drop = L * 0.3, step = 115;
        const n = 3;
        let left = rng() < 0.5;
        for (let i = 0; i < n; i++) {
          const yy = y + 10 + i * step;
          if (left) add(seg(0, yy, L, yy + drop, 4, 0.4, { type: 'slope' }));
          else add(seg(W, yy, W - L, yy + drop, 4, 0.4, { type: 'slope' }));
          left = !left;
        }
        return n * step + 60;
      },
      bumpers(y) {
        const placed = [];
        const target = 6 + Math.floor(rng() * 3);
        for (let tries = 0; tries < 80 && placed.length < target; tries++) {
          const r = R(15, 26);
          const x = R(r + 24, W - r - 24), yy = y + R(r + 6, 170 - r);
          if (placed.every(p => Math.hypot(p.x - x, p.y - yy) >= p.r + r + 42)) placed.push({ x, y: yy, r });
        }
        for (const p of placed) add(circle(p.x, p.y, p.r, 1.1, { type: 'bumper' }));
        return 185;
      },
      sliders(y) {
        const A = W * 0.28;
        for (let i = 0; i < 2; i++) {
          const c = add(circle(W / 2, y + 30 + i * 60, 13, 0.8, {
            type: 'slider', cx: W / 2, A, om: R(1.1, 2.2) * (rng() < 0.5 ? -1 : 1), ph: R(0, 6.28)
          }));
          c.update = function (t) {
            const a = this.om * t + this.ph;
            this.x = this.cx + this.A * Math.sin(a);
            this.vx = this.A * this.om * Math.cos(a);
          };
          c.update(0);
          dynamic.push(c);
        }
        for (let x = 70; x < W - 40; x += 100) add(circle(x + R(-10, 10), y + 60 + R(-4, 4), 5, 0.6));
        return 130;
      },
      funnel(y) {
        const gap = 84, h = 100;
        add(seg(0, y, W / 2 - gap / 2, y + h, 4, 0.4, { type: 'slope' }));
        add(seg(W, y, W / 2 + gap / 2, y + h, 4, 0.4, { type: 'slope' }));
        add(circle(W / 2 + R(-10, 10), y + h + 28, 9, 0.7, { type: 'bumper' }));
        return h + 70;
      }
    };

    // "lottery" bands make travel time vary wildly between balls, so ranks keep reshuffling
    const lottery = ['lanes', 'gates', 'wind'];
    const pool = ['pegs', 'pegs', 'spinners', 'spinners', 'spinners', 'windmill', 'windmill', 'slopes', 'bumpers', 'sliders', 'funnel'].concat(lottery, lottery);
    const bandCount = 11 + Math.floor(rng() * 3);
    const at = f => Math.floor(bandCount * f);
    const slotType = new Map([
      [at(0.3), ['slam']], [at(0.45), ['portals']], [at(0.62), ['slam']], [at(0.78), lottery],
      [bandCount - 2, ['slam']], [bandCount - 1, ['portals']]
    ]);
    let y = SPAWN_H + 90;
    let last = '';
    const layout = [];
    for (let i = 0; i < bandCount; i++) {
      const src = i === 0 ? ['pegs'] : slotType.get(i) || pool;
      let cand = src.filter(t => t !== last || t === 'pegs');
      if (!cand.length) cand = ['pegs'];
      const type = cand[Math.floor(rng() * cand.length)];
      layout.push({ type, y });
      const before = portals.length, sBefore = slams.length;
      y += builders[type](y);
      for (let k = before; k < portals.length; k++) portals[k].band = i;
      for (let k = sBefore; k < slams.length; k++) slams[k].band = i;
      last = type;
    }
    const finishY = y + 110;
    for (const sl of slams) sl.destY = layout[Math.max(0, sl.band - 2 - Math.floor(rng() * 2))].y - 14;
    for (const p of portals) {
      const j = p.band, lastIdx = layout.length - 1;
      if (p.kind === 'fwd') {
        p.destY = j >= lastIdx ? finishY - 70 : layout[Math.min(lastIdx, j + 2 + Math.floor(rng() * 2))].y - 14;
      } else if (p.kind === 'back') {
        p.destY = layout[Math.max(0, j - 3 - Math.floor(rng() * 2))].y - 14;
      }
    }
    return { W, H: finishY + 190, SPAWN_H, finishY, colliders, dynamic, zones, portals, slams, layout, seed };
  }

  // ---------- game ----------
  function pickRadius(n) {
    for (let r = 12; r >= 4; r -= 0.5) {
      const cols = Math.floor((W - 2 * r) / (2 * r + 2));
      const rows = Math.ceil(n / cols);
      if (rows * (2 * r + 2) <= SPAWN_H - 40) return r;
    }
    return 4;
  }

  class Game {
    constructor(names, map, seed) {
      this.map = map;
      this.rng = mulberry32(seed === undefined ? randomSeed() : seed);
      this.t = 0;
      this.finishedCount = 0;
      this.ranking = [];
      this.over = false;
      this.events = [];     // finished balls since last drain
      const n = names.length;
      const r = pickRadius(n);
      this.radius = r;

      // hues: same name -> same colour, distinct names spread out
      const hueOf = new Map();
      names.forEach(nm => { if (!hueOf.has(nm)) hueOf.set(nm, (hueOf.size * 137.508) % 360); });

      // spawn grid inside hopper, slots shuffled so start order is random
      const cell = 2 * r + 2;
      const cols = Math.floor((W - 2 * r) / cell);
      const rows = Math.ceil(n / cols);
      const slots = [];
      for (let i = 0; i < rows * cols; i++) slots.push(i);
      const picked = shuffle(slots, this.rng).slice(0, n);
      const gridW = cols * cell;
      const x0 = (W - gridW) / 2 + cell / 2;
      const y0 = 30;
      this.balls = names.map((name, i) => {
        const s = picked[i];
        return {
          id: i, name, hue: hueOf.get(name), r,
          x: x0 + (s % cols) * cell + (this.rng() - 0.5) * 2,
          y: y0 + Math.floor(s / cols) * cell + (this.rng() - 0.5) * 2,
          vx: (this.rng() - 0.5) * 120, vy: this.rng() * 40,
          done: false, rank: 0, time: 0, stuck: 0, doneAt: 0, cd: 0, backs: 0, tele: null, hit: {}, maxY: 0
        };
      });
      this.active = this.balls.slice();
    }

    drain() { const e = this.events; this.events = []; return e; }

    _finish(b) {
      b.done = true; b.rank = ++this.finishedCount; b.time = this.t; b.doneAt = this.t;
      this.ranking.push(b);
      this.events.push(b);
    }

    step(dt) {
      dt = dt || DT;
      const map = this.map;
      this.t += dt;
      for (const c of map.dynamic) c.update(this.t);
      for (const z of map.zones) z.update(this.t);

      const A = this.active;
      const k = 1 - DRAG * dt;
      for (const b of A) {
        b.vy += GRAVITY * dt;
        for (const z of map.zones) {
          if (z.on && b.y > z.y0 && b.y < z.y1 && b.x > z.x0 && b.x < z.x1) { b.vx += z.ax * dt; b.vy += z.ay * dt; }
        }
        b.vx *= k; b.vy *= k;
        const sp2 = b.vx * b.vx + b.vy * b.vy;
        if (sp2 > MAX_SPEED * MAX_SPEED) {
          const f = MAX_SPEED / Math.sqrt(sp2); b.vx *= f; b.vy *= f;
        }
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.y > b.maxY) b.maxY = b.y;
      }

      // spatial hash for ball-ball
      const cs = this.radius * 2 + 2;
      const grid = new Map();
      for (const b of A) {
        const key = Math.floor(b.x / cs) + Math.floor(b.y / cs) * 4096;
        const l = grid.get(key);
        if (l) l.push(b); else grid.set(key, [b]);
      }

      for (let iter = 0; iter < 2; iter++) {
        for (const a of A) {
          const cx = Math.floor(a.x / cs), cy = Math.floor(a.y / cs);
          for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
            const l = grid.get(cx + ox + (cy + oy) * 4096);
            if (!l) continue;
            for (const b of l) if (b.id > a.id) collideBalls(a, b);
          }
        }
        for (const b of A) this._collideWorld(b);
      }

      // slam pads: a ball entering while among the front-runners is knocked back to where the pack is
      for (const sl of map.slams) {
        const lead = Math.max(1, Math.ceil(A.length * sl.frac));
        let ys = null;
        for (const b of A) {
          if (b.vy <= 0 || b.y < sl.y0 || b.y > sl.y1 || b.hit[sl.id]) continue;
          let ahead = 0;                                            // rank by deepest point reached, so knocked-back balls keep their rank
          for (const o of A) if (o.maxY > b.maxY) ahead++;
          if (ahead >= lead) { b.hit[sl.id] = 2; continue; }     // not a leader: passes for good
          b.hit[sl.id] = 1;
          if (!ys) ys = A.map(o => o.y).sort((p, q) => q - p);
          const median = ys[Math.floor(ys.length / 2)];
          const target = Math.max(Math.min(median - this.rng() * 100, b.y - 150), b.y - 600);   // at most ~2-3 bands back
          let dest = map.layout[0].y - 14;                         // snap to the top of a band: always open space
          for (const l of map.layout) if (l.y - 14 <= target) dest = l.y - 14;
          b.tele = { t: this.t, x: b.x, y: b.y, kind: 'slam' };
          b.x = 40 + this.rng() * (W - 80); b.y = dest;
          b.vx = (this.rng() - 0.5) * 120; b.vy = 40; b.stuck = 0;
        }
      }

      // portals
      if (map.portals.length) {
        for (const b of A) {
          if (b.cd > 0) { b.cd -= dt; continue; }
          for (const p of map.portals) {
            if (b.x < p.x0 || b.x > p.x1 || b.y < p.y0 || b.y > p.y1) continue;
            if (p.kind === 'stay' || (p.kind === 'back' && b.backs >= 1)) break;
            b.tele = { t: this.t, x: b.x, y: b.y };
            if (p.kind === 'back') b.backs++;
            b.x = 40 + this.rng() * (W - 80); b.y = p.destY;
            b.vx = (this.rng() - 0.5) * 120; b.vy = 40; b.cd = 0.6; b.stuck = 0;
            break;
          }
        }
      }

      // finish + stuck handling
      const fin = [];
      for (const b of A) {
        if (b.y >= map.finishY) { fin.push(b); continue; }
        const sp2 = b.vx * b.vx + b.vy * b.vy;
        if (sp2 < 400) b.stuck += dt; else b.stuck = Math.max(0, b.stuck - dt);
        if (b.stuck > 1.0) {   // nudge balls that came to rest on something
          b.vx += (this.rng() - 0.5) * 360; b.vy -= 80 + this.rng() * 120; b.stuck = 0.3;
        }
      }
      if (fin.length) {
        fin.sort((p, q) => q.y - p.y);
        for (const b of fin) this._finish(b);
        this.active = A.filter(b => !b.done);
      }
      if (this.t > TIME_LIMIT && this.active.length) {
        const rest = this.active.slice().sort((p, q) => q.y - p.y);
        for (const b of rest) this._finish(b);
        this.active = [];
      }
      if (!this.active.length) this.over = true;
    }

    _collideWorld(b) {
      const r = b.r;
      if (b.x < r) { b.x = r; if (b.vx < 0) b.vx = -b.vx * 0.5; }
      else if (b.x > W - r) { b.x = W - r; if (b.vx > 0) b.vx = -b.vx * 0.5; }
      const cols = this.map.buckets[Math.max(0, Math.floor(b.y / BUCKET))];
      if (!cols) return;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i].off) continue;
        if (collideCollider(b, cols[i])) {
          b.vx += (this.rng() - 0.5) * 40; b.vy += (this.rng() - 0.5) * 20; // chaos on every bounce
        }
      }
    }
  }

  function collideBalls(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const min = a.r + b.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return;
    let d = Math.sqrt(d2), nx, ny;
    if (d < 1e-6) { nx = 0; ny = 1; d = 0; } else { nx = dx / d; ny = dy / d; }
    const pen = (min - d) / 2;
    a.x -= nx * pen; a.y -= ny * pen; b.x += nx * pen; b.y += ny * pen;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) {
      const j = -(1 + BALL_E) * vn / 2;
      a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny;
    }
  }

  function collideCollider(b, c) {
    let px, py;
    if (c.kind === 0) { px = c.x; py = c.y; }
    else {
      const dx = c.x2 - c.x1, dy = c.y2 - c.y1;
      let t = ((b.x - c.x1) * dx + (b.y - c.y1) * dy) / (dx * dx + dy * dy);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      px = c.x1 + dx * t; py = c.y1 + dy * t;
    }
    let nx = b.x - px, ny = b.y - py;
    const min = b.r + c.r, d2 = nx * nx + ny * ny;
    if (d2 >= min * min) return false;
    let d = Math.sqrt(d2);
    if (d < 1e-6) { nx = 0; ny = -1; d = 0; } else { nx /= d; ny /= d; }
    b.x += nx * (min - d); b.y += ny * (min - d);
    let svx = 0, svy = 0;
    if (c.kind === 0) { svx = c.vx; svy = c.vy; }
    else if (c.w) { svx = -c.w * (py - c.cy); svy = c.w * (px - c.cx); }
    const rvx = b.vx - svx, rvy = b.vy - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      const j = -(1 + c.e) * vn;
      let vx = rvx + j * nx, vy = rvy + j * ny;
      const tx = -ny, ty = nx, vt = vx * tx + vy * ty;
      vx -= vt * tx * FRICTION; vy -= vt * ty * FRICTION;
      b.vx = vx + svx; b.vy = vy + svy;
    }
    return true;
  }

  // bucket colliders by y so each ball only tests nearby obstacles
  function bucketize(map) {
    const buckets = [];
    const pad = 16;
    for (const c of map.colliders) {
      let y0, y1;
      if (c.kind === 0) { y0 = c.y - c.r; y1 = c.y + c.r; }
      else if (c.w) { y0 = c.cy - c.hl - c.r; y1 = c.cy + c.hl + c.r; }
      else { y0 = Math.min(c.y1, c.y2) - c.r; y1 = Math.max(c.y1, c.y2) + c.r; }
      for (let i = Math.max(0, Math.floor((y0 - pad) / BUCKET)); i <= Math.floor((y1 + pad) / BUCKET); i++) {
        (buckets[i] || (buckets[i] = [])).push(c);
      }
    }
    map.buckets = buckets;
    return map;
  }

  function createMap(seed) {
    return bucketize(generateMap(seed === undefined ? randomSeed() : seed));
  }

  return {
    W, DT, MAX_BALLS, SPAWN_H,
    mulberry32, randomSeed, shuffle,
    parseEntries, parseRanges, winnerRanks, groupOf, buildGroups,
    createMap, Game
  };
});
