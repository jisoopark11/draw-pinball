(function () {
  'use strict';
  const E = window.PinEngine;
  const $ = id => document.getElementById(id);

  const canvas = $('stage');
  const mainCtx = canvas.getContext('2d');
  let ctx = mainCtx;                         // swapped temporarily when drawing the minimap
  const miniCanvas = $('mini');
  const miniCtx = miniCanvas.getContext('2d');
  const SCALE = canvas.width / E.W;          // follow-camera scale
  const VIEW_H = canvas.height / SCALE;      // world units visible in follow mode

  const els = {
    names: $('names'), count: $('count'), warn: $('warn'), shuffle: $('shuffle'),
    ranges: $('ranges'), rangeWrap: $('rangeWrap'),
    record: $('record'), recLink: $('recLink'),
    speed: $('speed'), camera: $('camera'), start: $('start'), newmap: $('newmap'),
    winners: $('winners'), order: $('order')
  };
  const modeInputs = Array.from(document.querySelectorAll('input[name=mode]'));
  const getMode = () => modeInputs.find(i => i.checked).value;

  // ---------- persisted settings ----------
  const STORE = 'draw-pinball:v1';
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (typeof s.names === 'string') els.names.value = s.names;
      if (typeof s.ranges === 'string') els.ranges.value = s.ranges;
      const m = modeInputs.find(i => i.value === s.mode);
      if (m) m.checked = true;
    } catch (e) { /* storage unavailable */ }
    if (!els.names.value.trim()) els.names.value = 'No1, No2, No3, No4, No5, No6';
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ names: els.names.value, ranges: els.ranges.value, mode: getMode() }));
    } catch (e) { /* ignore */ }
  }

  // ---------- state ----------
  let map = E.createMap();
  let game = null;
  let state = 'idle';            // idle | running | done
  let winnerSet = new Set();
  let doneAt = 0;                // performance.now() of completion
  let camTop = 0;

  // ---------- input handling ----------
  function currentInput() {
    const { balls, warnings } = E.parseEntries(els.names.value);
    const mode = getMode();
    const ranks = E.winnerRanks(mode, els.ranges.value, balls.length);
    return { balls, warnings, mode, ranks };
  }

  function refreshInput() {
    const { balls, warnings, mode, ranks } = currentInput();
    els.count.textContent = balls.length + (balls.length === 1 ? ' ball' : ' balls');
    els.rangeWrap.hidden = mode !== 'multiple';
    const msgs = warnings.slice();
    if (balls.length < 2) msgs.push('2+ balls needed');
    else if (mode === 'multiple' && !ranks.length) msgs.push(`Ranks: 1-${balls.length}`);
    els.warn.textContent = msgs.join(' · ');
    els.start.disabled = state === 'running' ? false : balls.length < 2 || (mode === 'multiple' && !ranks.length);
    return { balls, mode, ranks };
  }

  function lockInputs(locked) {
    [els.names, els.shuffle, els.ranges, els.record, els.newmap, ...modeInputs].forEach(e => { e.disabled = locked; });
  }

  els.names.addEventListener('input', () => { refreshInput(); saveSettings(); });
  els.ranges.addEventListener('input', () => { refreshInput(); saveSettings(); });
  modeInputs.forEach(i => i.addEventListener('change', () => { refreshInput(); saveSettings(); }));

  // Shuffle only re-rolls how the balls are arranged in the hopper; the typed list is left untouched.
  let arrangeSeed = E.randomSeed();
  els.shuffle.addEventListener('click', () => {
    if (state === 'done') { map = E.createMap(); resetStage(); }
    arrangeSeed = E.randomSeed();
  });

  els.newmap.addEventListener('click', () => { map = E.createMap(); resetStage(); });

  // ---------- results panel ----------
  function resetStage() {
    game = null; state = 'idle'; camTop = 0;
    els.order.innerHTML = '';
    els.winners.innerHTML = '';
  }

  function addOrderRow(b) {
    const li = document.createElement('li');
    if (winnerSet.has(b.rank)) li.className = 'win';
    li.innerHTML = '<span class="rk"></span><span class="dot"></span><span class="nm"></span><span class="tm"></span>';
    li.children[0].textContent = '#' + b.rank;
    li.children[1].style.background = `hsl(${b.hue} 80% 58%)`;
    li.children[2].textContent = b.name;
    li.children[3].textContent = b.time.toFixed(1) + 's';
    els.order.appendChild(li);
    li.scrollIntoView({ block: 'nearest' });
  }

  function showWinners() {
    els.winners.innerHTML = '';
    for (const rank of Array.from(winnerSet).sort((a, b) => a - b)) {
      const b = game.ranking[rank - 1];
      if (!b) continue;
      const card = document.createElement('div');
      card.className = 'card';
      const small = document.createElement('small');
      small.textContent = '🏆 #' + rank;
      card.appendChild(small);
      card.appendChild(document.createTextNode(b.name));
      els.winners.appendChild(card);
    }
  }

  // ---------- recording ----------
  let recorder = null, chunks = [], recMime = '', recUrl = null;
  const canRecord = !!(canvas.captureStream && window.MediaRecorder);
  if (!canRecord) { els.record.disabled = true; els.record.title = 'Recording is not supported in this browser'; }

  function startRecording() {
    if (!canRecord || !els.record.checked) return;
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    recMime = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
    try {
      recorder = new MediaRecorder(canvas.captureStream(60), recMime ? { mimeType: recMime, videoBitsPerSecond: 6e6 } : undefined);
    } catch (e) { recorder = null; return; }
    chunks = [];
    recorder.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => {
      const type = recMime || 'video/webm';
      const blob = new Blob(chunks, { type });
      if (recUrl) URL.revokeObjectURL(recUrl);
      recUrl = URL.createObjectURL(blob);
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const a = document.createElement('a');
      a.href = recUrl; a.download = `draw-pinball-${Date.now()}.${ext}`;
      a.textContent = 'Download recording';
      els.recLink.innerHTML = ''; els.recLink.appendChild(a);
      a.click();
      recorder = null;
    };
    recorder.start(250);
  }
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  // ---------- start / stop ----------
  let finishTimer = 0;
  els.start.addEventListener('click', () => {
    if (state === 'running') {            // abort
      clearTimeout(finishTimer);
      stopRecording();
      resetStage();
      lockInputs(false); els.start.textContent = 'Start'; refreshInput();
      return;
    }
    const { balls, ranks } = refreshInput();
    if (els.start.disabled) return;
    if (state === 'done') map = E.createMap();   // fresh obstacles each round
    resetStage();
    winnerSet = new Set(ranks);
    game = new E.Game(balls, map, arrangeSeed);
    arrangeSeed = E.randomSeed();
    state = 'running';
    els.recLink.innerHTML = '';
    lockInputs(true);
    els.start.textContent = 'Stop';
    startRecording();
  });

  function finish() {
    state = 'done'; doneAt = performance.now();
    showWinners();
    lockInputs(false);
    els.start.textContent = 'Start again';
    refreshInput();
    // keep recording while the banner is on screen, then save
    finishTimer = setTimeout(stopRecording, 4500);
  }

  // ---------- camera ----------
  function viewTransform() {
    if (els.camera.value === 'full') {
      const s = Math.min(canvas.width / map.W, canvas.height / map.H);
      return { s, ox: (canvas.width - map.W * s) / 2, oy: (canvas.height - map.H * s) / 2, top: 0, bottom: map.H };
    }
    return { s: SCALE, ox: 0, oy: -camTop * SCALE, top: camTop, bottom: camTop + VIEW_H };
  }

  function updateCamera(dt) {
    if (state === 'idle' || !game) { camTop += (0 - camTop) * Math.min(1, dt * 4); return; }
    const act = game.active;
    let target = camTop;
    if (act.length) {
      let y;
      if (getMode() === 'last') { y = Infinity; for (const b of act) if (b.y < y) y = b.y; }
      else { y = -Infinity; for (const b of act) if (b.y > y) y = b.y; }
      target = y - VIEW_H * 0.4;
    } else {
      target = map.finishY - VIEW_H * 0.55;
    }
    target = Math.max(0, Math.min(map.H - VIEW_H, target));
    camTop += (target - camTop) * Math.min(1, dt * 3);
  }

  // ---------- drawing ----------
  const COLORS = {
    peg: ['#aab4f0', '#5a65b8'], bumper: ['#ff8fb4', '#d63c76'], slope: ['#5fe0c0', '#1f9c80'],
    bar: ['#5fe0c0', '#1f9c80'], gate: ['#ff6b6b', '#a32b2b'], spinner: ['#ffd24a', '#c98f12'], slider: ['#ff9f43', '#c4620a']
  };

  function drawCollider(c, v) {
    const col = COLORS[c.type] || COLORS.peg;
    if (c.kind === 0) {
      if (c.y + c.r < v.top || c.y - c.r > v.bottom) return;
      const g = ctx.createRadialGradient(c.x - c.r * 0.3, c.y - c.r * 0.3, c.r * 0.1, c.x, c.y, c.r);
      g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, 6.2832); ctx.fill();
      if (c.type === 'bumper') {
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, c.r + 3, 0, 6.2832); ctx.stroke();
      }
    } else {
      const ymin = Math.min(c.y1, c.y2) - c.r, ymax = Math.max(c.y1, c.y2) + c.r;
      if (ymax < v.top || ymin > v.bottom) return;
      if (c.off) {            // open gate: faint dashed outline
        ctx.strokeStyle = 'rgba(255,107,107,.35)'; ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
        ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke(); ctx.setLineDash([]);
        return;
      }
      ctx.strokeStyle = col[1]; ctx.lineWidth = c.r * 2 + 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke();
      ctx.strokeStyle = col[0]; ctx.lineWidth = c.r * 2 - 1;
      ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke();
      if (c.type === 'spinner') {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(c.cx, c.cy, 3, 0, 6.2832); ctx.fill();
      }
    }
  }

  function drawBackdrop(v) {
    // walls
    ctx.fillStyle = '#1a1c28';
    ctx.fillRect(-20, v.top - 10, 20, v.bottom - v.top + 20);
    ctx.fillRect(map.W, v.top - 10, 20, v.bottom - v.top + 20);
    // hopper
    if (v.top < map.SPAWN_H + 60) {
      ctx.fillStyle = 'rgba(255,255,255,.035)';
      ctx.fillRect(0, 0, map.W, map.SPAWN_H);
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.setLineDash([8, 8]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, map.SPAWN_H); ctx.lineTo(map.W, map.SPAWN_H); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.font = '700 13px system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('START', 10, 18);
    }
    // finish line (checkered)
    const fy = map.finishY;
    if (fy > v.top - 40 && fy < v.bottom + 40) {
      const sq = 15;
      for (let i = 0; i * sq < map.W; i++) for (let j = 0; j < 2; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#fff' : '#111';
        ctx.fillRect(i * sq, fy + j * sq - sq, sq, sq);
      }
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = '700 14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('FINISH', map.W / 2, fy + 34);
    }
  }

  function drawZones(v, now) {
    for (const z of map.zones) {
      if (z.y1 < v.top || z.y0 > v.bottom) continue;
      ctx.fillStyle = z.on ? 'rgba(120,200,255,.13)' : 'rgba(120,200,255,.04)';
      ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
      if (!z.on) continue;
      // moving chevrons show the push direction
      const dx = Math.sign(z.ax), dy = Math.sign(z.ay), len = Math.hypot(z.ax, z.ay) || 1;
      const ux = z.ax / len, uy = z.ay / len, gap = 46;
      const shift = (now / 1000 * 70) % gap;
      ctx.save();
      ctx.beginPath(); ctx.rect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0); ctx.clip();
      ctx.strokeStyle = 'rgba(160,220,255,.45)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let gx = z.x0 + 18; gx < z.x1; gx += gap) {
        for (let gy = z.y0 + 18; gy < z.y1 + gap; gy += gap) {
          const cx = gx + (dx ? ux * shift : 0), cy = gy + (dy ? uy * shift : 0);
          ctx.beginPath();
          ctx.moveTo(cx - 6 * uy - 6 * ux, cy + 6 * ux - 6 * uy);
          ctx.lineTo(cx + 6 * ux, cy + 6 * uy);
          ctx.lineTo(cx + 6 * uy - 6 * ux, cy - 6 * ux - 6 * uy);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  const PORTAL = { fwd: ['#4cff9a', 'SKIP'], back: ['#ff5d5d', 'BACK'], stay: ['#6ab7ff', 'PASS'] };
  function drawPortals(v, now) {
    for (const p of map.portals) {
      if (p.y1 < v.top - 40 || p.y0 > v.bottom + 40) continue;
      const [col, label] = PORTAL[p.kind];
      const hw = (p.x1 - p.x0) / 2 + 6, ang = now / 1000 * (p.kind === 'back' ? -3 : 3);
      ctx.save();
      ctx.translate(p.cx, p.y0 + 8);
      ctx.fillStyle = '#05060a';
      ctx.beginPath(); ctx.ellipse(0, 0, hw, 12, 0, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.shadowColor = col; ctx.shadowBlur = 10;
      for (let k = 0; k < 3; k++) {
        const a0 = ang + k * 2.094;
        ctx.beginPath(); ctx.ellipse(0, 0, hw - k * 4, 12 - k * 2.5, 0, a0, a0 + 1.5); ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(label, p.cx, p.y0 + 34); ctx.globalAlpha = 1;
    }
  }

  function drawSlams(v, now) {
    for (const sl of map.slams) {
      if (sl.y1 < v.top - 20 || sl.y0 > v.bottom + 20) continue;
      const pulse = 0.5 + 0.5 * Math.sin(now / 250);
      ctx.fillStyle = `rgba(255,70,70,${0.10 + 0.07 * pulse})`;
      ctx.fillRect(0, sl.y0, map.W, sl.y1 - sl.y0);
      ctx.strokeStyle = 'rgba(255,90,90,.75)'; ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.moveTo(0, sl.y0); ctx.lineTo(map.W, sl.y0); ctx.moveTo(0, sl.y1); ctx.lineTo(map.W, sl.y1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,120,120,.9)'; ctx.font = '800 13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('▲ LEADERS BACK ▲', map.W / 2, (sl.y0 + sl.y1) / 2 + 5);
    }
  }

  function drawTeleRing(x, y, age, col) {
    const k = age / 0.5;
    ctx.strokeStyle = col; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 10 + k * 34, 0, 6.2832); ctx.stroke(); ctx.globalAlpha = 1;
  }

  function drawBalls(v, scale) {
    const labels = scale > 0.55;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const fs = Math.max(10, Math.min(14, game.radius * 1.15));
    ctx.font = `700 ${fs}px system-ui, "Noto Sans KR", sans-serif`;
    ctx.lineJoin = 'round';
    for (const b of game.balls) {
      let alpha = 1, y = b.y;
      if (b.done) {
        const age = game.t - b.doneAt;
        if (age > 1) continue;
        alpha = 1 - age; y = b.y + age * 60;
      }
      if (y + b.r < v.top - 20 || y - b.r > v.bottom + 20) continue;
      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(b.x - b.r * 0.35, y - b.r * 0.35, b.r * 0.1, b.x, y, b.r);
      g.addColorStop(0, `hsl(${b.hue} 90% 78%)`); g.addColorStop(1, `hsl(${b.hue} 75% 45%)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(b.x, y, b.r, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.stroke();
      if (labels) {
        const text = b.done ? `#${b.rank} ${b.name}` : b.name;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,9,14,.85)';
        ctx.strokeText(text, b.x, y - b.r - 3);
        ctx.fillStyle = winnerSet.has(b.rank) && b.done ? '#ffd24a' : '#fff';
        ctx.fillText(text, b.x, y - b.r - 3);
      }
      ctx.globalAlpha = 1;
      if (b.tele && game.t - b.tele.t < 0.5) {
        const age = game.t - b.tele.t;
        const col = b.tele.kind === 'slam' ? '#ff5a5a' : '#fff';
        drawTeleRing(b.tele.x, b.tele.y, age, col);
        drawTeleRing(b.x, b.y, age, col);
      }
    }
  }

  function wrapText(text, maxW) {
    return text.length * 16 > maxW ? text.slice(0, Math.floor(maxW / 16) - 1) + '…' : text;
  }

  function drawBanner() {
    const age = Math.min(1, (performance.now() - doneAt) / 500);
    const ranks = Array.from(winnerSet).sort((a, b) => a - b);
    const shown = ranks.slice(0, 8);
    const rowH = 52, w = canvas.width * 0.82;
    const h = 130 + shown.length * rowH + (ranks.length > shown.length ? 40 : 0);
    const x = (canvas.width - w) / 2, y = (canvas.height - h) / 2 - (1 - age) * 40;
    ctx.save();
    ctx.globalAlpha = age;
    ctx.fillStyle = 'rgba(10,11,18,.88)';
    ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 24); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd24a'; ctx.font = '800 34px system-ui, sans-serif';
    ctx.fillText('🏆 WINNER', canvas.width / 2, y + 62);
    ctx.font = '700 30px system-ui, "Noto Sans KR", sans-serif';
    shown.forEach((r, i) => {
      const b = game.ranking[r - 1];
      if (!b) return;
      const cy = y + 118 + i * rowH;
      ctx.fillStyle = `hsl(${b.hue} 80% 58%)`;
      ctx.beginPath(); ctx.arc(x + 44, cy - 10, 13, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#9aa0b8'; ctx.textAlign = 'left'; ctx.font = '600 22px system-ui, sans-serif';
      ctx.fillText('#' + r, x + 68, cy - 2);
      ctx.fillStyle = '#fff'; ctx.font = '700 30px system-ui, "Noto Sans KR", sans-serif';
      ctx.fillText(wrapText(b.name, w - 190), x + 128, cy);
    });
    if (ranks.length > shown.length) {
      ctx.textAlign = 'center'; ctx.fillStyle = '#9aa0b8'; ctx.font = '600 22px system-ui, sans-serif';
      ctx.fillText(`+${ranks.length - shown.length} more`, canvas.width / 2, y + h - 22);
    }
    ctx.restore();
  }

  // current order: finished balls first, then the rest by how far down they are
  function standings() {
    const fin = game.ranking.slice();
    const act = game.active.slice().sort((p, q) => q.y - p.y);
    return fin.concat(act);
  }

  function drawLive() {
    const list = standings().slice(0, 5);
    ctx.save();
    ctx.fillStyle = 'rgba(10,11,18,.65)';
    ctx.beginPath(); ctx.roundRect(12, 12, 210, 30 + list.length * 28, 12); ctx.fill();
    ctx.textAlign = 'left'; ctx.fillStyle = '#ffd24a'; ctx.font = '800 13px system-ui, sans-serif';
    ctx.fillText('LIVE', 24, 32);
    ctx.font = '700 17px system-ui, "Noto Sans KR", sans-serif';
    list.forEach((b, i) => {
      const y = 58 + i * 28;
      ctx.fillStyle = `hsl(${b.hue} 80% 58%)`;
      ctx.beginPath(); ctx.arc(32, y - 6, 7, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#9aa0b8'; ctx.fillText(String(i + 1), 46, y);
      ctx.fillStyle = '#fff'; ctx.fillText(wrapText(b.name, 140), 66, y);
    });
    ctx.restore();
  }

  // ---------- minimap: the whole map folded into columns, camera view highlighted ----------
  const MINI_COLS = 3, MINI_W = 640, MINI_GAP = 10;
  const miniColW = (MINI_W - (MINI_COLS - 1) * MINI_GAP) / MINI_COLS;
  const miniScale = miniColW / E.W;
  let miniStatic = null, miniFor = null, miniColH = 0;

  function buildMini() {
    miniFor = map;
    miniColH = Math.ceil(map.H / MINI_COLS);
    miniCanvas.width = MINI_W;
    miniCanvas.height = Math.ceil(miniColH * miniScale);
    miniStatic = document.createElement('canvas');
    miniStatic.width = miniCanvas.width; miniStatic.height = miniCanvas.height;
    const c = miniStatic.getContext('2d');
    const saved = ctx; ctx = c;
    for (let k = 0; k < MINI_COLS; k++) {
      const x0 = k * (miniColW + MINI_GAP);
      c.save();
      c.beginPath(); c.rect(x0, 0, miniColW, miniStatic.height); c.clip();
      c.fillStyle = '#0b0c12'; c.fillRect(x0, 0, miniColW, miniStatic.height);
      c.setTransform(miniScale, 0, 0, miniScale, x0, -k * miniColH * miniScale);
      const v = { top: k * miniColH - 40, bottom: (k + 1) * miniColH + 40 };
      drawBackdrop(v);
      drawZones(v, 0);
      drawSlams(v, 0);
      for (const col of map.colliders) drawCollider(col, v);
      drawPortals(v, 0);
      c.restore();
    }
    ctx = saved;
  }

  function miniPos(wx, wy) {
    const k = Math.max(0, Math.min(MINI_COLS - 1, Math.floor(wy / miniColH)));
    return { x: k * (miniColW + MINI_GAP) + wx * miniScale, y: (wy - k * miniColH) * miniScale };
  }

  function renderMini() {
    if (miniFor !== map) buildMini();
    const c = miniCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(miniStatic, 0, 0);
    // balls
    const balls = game ? game.balls : (idlePreview ? idlePreview.game.balls : []);
    for (const b of balls) {
      if (b.done) continue;
      const p = miniPos(b.x, b.y);
      c.fillStyle = `hsl(${b.hue} 85% 60%)`;
      c.beginPath(); c.arc(p.x, p.y, 3, 0, 6.2832); c.fill();
    }
    // camera highlight (one rect per column the view touches)
    if (els.camera.value === 'full') return;
    const top = camTop, bot = camTop + VIEW_H;
    c.lineWidth = 2; c.strokeStyle = '#ffd24a'; c.fillStyle = 'rgba(255,210,74,.18)';
    for (let k = 0; k < MINI_COLS; k++) {
      const y0 = Math.max(top, k * miniColH), y1 = Math.min(bot, (k + 1) * miniColH);
      if (y1 <= y0) continue;
      const x = k * (miniColW + MINI_GAP);
      const ry = (y0 - k * miniColH) * miniScale, rh = (y1 - y0) * miniScale;
      c.fillRect(x, ry, miniColW, rh);
      c.strokeRect(x + 1, ry + 1, miniColW - 2, Math.max(2, rh - 2));
    }
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0c12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const v = viewTransform();
    const now = performance.now();
    ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
    drawBackdrop(v);
    drawZones(v, now);
    drawSlams(v, now);
    for (const c of map.colliders) drawCollider(c, v);
    drawPortals(v, now);
    if (game) drawBalls(v, v.s);
    else drawIdleBalls();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (state === 'running' && game) drawLive();
    if (state === 'done') drawBanner();
    renderMini();
  }

  // preview of balls waiting in the hopper before Start
  function drawIdleBalls() {
    const balls = E.parseEntries(els.names.value).balls;
    if (balls.length < 1) return;
    const key = arrangeSeed + ':' + balls.join('\u0001');
    if (!idlePreview || idlePreview.key !== key) idlePreview = { key, game: new E.Game(balls, map, arrangeSeed) };
    const saved = game; game = idlePreview.game;
    drawBalls({ top: -50, bottom: 1e9 }, 1);
    game = saved;
  }
  let idlePreview = null;
  els.newmap.addEventListener('click', () => { idlePreview = null; });

  // ---------- main loop ----------
  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state === 'running' && game) {
      acc += dt * parseFloat(els.speed.value);
      let guard = 0;
      while (acc >= E.DT && guard++ < 2000 && !game.over) { game.step(E.DT); acc -= E.DT; }
      for (const b of game.drain()) addOrderRow(b);
      if (game.over) { acc = 0; finish(); }
    }
    updateCamera(dt);
    render();
    requestAnimationFrame(frame);
  }

  loadSettings();
  refreshInput();
  requestAnimationFrame(frame);

  // test hook
  window.__pinball = { get state() { return state; }, get game() { return game; } };
})();
