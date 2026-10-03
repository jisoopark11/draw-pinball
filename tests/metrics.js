// Rank-volatility metrics: node tests/metrics.js [balls] [maps]
// For each map: Spearman correlation between the order at 25/50/75% of the course and the final order
// (1.0 = order never changes, ~0 = fully reshuffled), plus total overtakes between checkpoints.
const E = require('../js/engine.js');
const N = +process.argv[2] || 20, MAPS = +process.argv[3] || 12;

function spearman(a, b) {           // a, b: rank arrays
  const n = a.length; let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (a[i] - b[i]) ** 2;
  return 1 - 6 * d2 / (n * (n * n - 1));
}
const cps = [0.25, 0.5, 0.75];
const acc = cps.map(() => []);
let overtakes = [], times = [];
for (let m = 1; m <= MAPS; m++) {
  const map = E.createMap(m * 104729);
  const g = new E.Game(Array.from({ length: N }, (_, i) => 'b' + i), map, m);
  const cross = cps.map(() => new Array(N).fill(Infinity));
  const ys = cps.map(f => map.SPAWN_H + f * (map.finishY - map.SPAWN_H));
  let steps = 0;
  while (!g.over && steps++ < 120 * 400) {
    g.step();
    for (const b of g.balls) cps.forEach((_, k) => { if (cross[k][b.id] === Infinity && b.y >= ys[k]) cross[k][b.id] = g.t; });
  }
  const rankOf = arr => { const idx = arr.map((t, i) => i).sort((p, q) => arr[p] - arr[q]); const r = []; idx.forEach((id, pos) => r[id] = pos); return r; };
  const fin = []; g.ranking.forEach((b, pos) => fin[b.id] = pos);
  const rs = cross.map(rankOf);
  cps.forEach((_, k) => acc[k].push(spearman(rs[k], fin)));
  let ot = 0;
  const seq = [...rs, fin];
  for (let k = 1; k < seq.length; k++) for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++)
    if ((seq[k - 1][i] - seq[k - 1][j]) * (seq[k][i] - seq[k][j]) < 0) ot++;
  overtakes.push(ot / (N * (N - 1) / 2) / (seq.length - 1));   // fraction of pairs that swapped per stretch
  times.push(g.ranking[N - 1].time);
}
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`N=${N} maps=${MAPS}`);
cps.forEach((f, k) => console.log(`  order@${f * 100}% vs final: spearman avg=${avg(acc[k]).toFixed(2)} max=${Math.max(...acc[k]).toFixed(2)}`));
console.log(`  pairs swapped per stretch: ${(avg(overtakes) * 100).toFixed(0)}% (50% = coin flip)`);
console.log(`  last-finisher time avg=${avg(times).toFixed(0)}s max=${Math.max(...times).toFixed(0)}s`);
