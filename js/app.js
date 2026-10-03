(function () {
  'use strict';
  const E = window.PinEngine;
  const $ = id => document.getElementById(id);

  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  const SCALE = canvas.width / E.W;          // follow-camera scale
  const VIEW_H = canvas.height / SCALE;      // world units visible in follow mode

  const els = {
    names: $('names'), count: $('count'), warn: $('warn'), shuffle: $('shuffle'),
    ranges: $('ranges'), rangeWrap: $('rangeWrap'), modeHint: $('modeHint'),
    record: $('record'), recNote: $('recNote'), recLink: $('recLink'),
    speed: $('speed'), camera: $('camera'), start: $('start'), newmap: $('newmap'),
    winners: $('winners'), order: $('order'), empty: $('empty')
  };
  const modeInputs = Array.from(document.querySelectorAll('input[name=mode]'));
  const getMode = () => modeInputs.find(i => i.checked).value;

  const MODE_HINT = {
    first: '가장 먼저 도착한 공의 주인이 우승',
    last: '가장 마지막에 도착한 공의 주인이 우승',
    multiple: '지정한 순번(들)에 도착한 공의 주인이 우승'
  };

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
    els.modeHint.textContent = MODE_HINT[mode];
    els.rangeWrap.hidden = mode !== 'multiple';
    const msgs = warnings.slice();
    if (balls.length < 2) msgs.push('공이 2개 이상 필요합니다');
    else if (mode === 'multiple' && !ranks.length) msgs.push(`순번을 1~${balls.length} 범위로 입력하세요`);
    els.warn.textContent = msgs.join(' · ');
    els.start.disabled = state === 'running' ? false : msgs.some(m => !/최대/.test(m));
    return { balls, mode, ranks };
  }

  function lockInputs(locked) {
    [els.names, els.shuffle, els.ranges, els.record, els.newmap, ...modeInputs].forEach(e => { e.disabled = locked; });
  }

  els.names.addEventListener('input', () => { refreshInput(); saveSettings(); });
  els.ranges.addEventListener('input', () => { refreshInput(); saveSettings(); });
  modeInputs.forEach(i => i.addEventListener('change', () => { refreshInput(); saveSettings(); }));

  els.shuffle.addEventListener('click', () => {
    const text = els.names.value;
    const toks = text.split(/[,\n;，]+/).map(s => s.trim()).filter(Boolean);
    if (toks.length < 2) return;
    const out = E.shuffle(toks, E.mulberry32(E.randomSeed()));
    els.names.value = out.join(/\n/.test(text.trim()) ? '\n' : ', ');
    refreshInput(); saveSettings();
  });

  els.newmap.addEventListener('click', () => { map = E.createMap(); resetStage(); });

  // ---------- results panel ----------
  function resetStage() {
    game = null; state = 'idle'; camTop = 0;
    els.order.innerHTML = '';
    els.winners.innerHTML = '';
    els.empty.hidden = false;
  }

  function addOrderRow(b) {
    els.empty.hidden = true;
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
  if (!canRecord) {
    els.record.disabled = true;
    els.recNote.textContent = '이 브라우저는 녹화를 지원하지 않습니다 (Chrome/Edge/Firefox 권장).';
  }

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
      a.textContent = '⬇ 녹화 영상 다시 저장';
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
    game = new E.Game(balls, map);
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
    bar: ['#5fe0c0', '#1f9c80'], spinner: ['#ffd24a', '#c98f12'], slider: ['#ff9f43', '#c4620a']
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

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0c12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const v = viewTransform();
    ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
    drawBackdrop(v);
    for (const c of map.colliders) drawCollider(c, v);
    if (game) drawBalls(v, v.s);
    else drawIdleBalls();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (state === 'done') drawBanner();
  }

  // preview of balls waiting in the hopper before Start
  function drawIdleBalls() {
    const balls = E.parseEntries(els.names.value).balls;
    if (balls.length < 1) return;
    if (!idlePreview || idlePreview.key !== balls.join('\u0001')) {
      idlePreview = { key: balls.join('\u0001'), game: new E.Game(balls, map, 1) };
    }
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
