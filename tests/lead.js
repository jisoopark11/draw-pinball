// Leader changes per race: node tests/lead.js [engine path] [balls] [maps]
const E = require(require('path').resolve(process.argv[2] || './js/engine.js'));
const N = +process.argv[3] || 20, MAPS = +process.argv[4] || 16;
let lc = [], t3 = [];
for (let m = 1; m <= MAPS; m++) {
  const g = new E.Game(Array.from({ length: N }, (_, i) => 'b' + i), E.createMap(m * 104729), m);
  let lead = -1, changes = 0, top3 = '', top3c = 0, steps = 0;
  while (!g.over && steps++ < 120 * 400) {
    g.step();
    if (steps % 60) continue;                     // sample every 0.5 s
    const act = g.active.slice().sort((a, b) => b.y - a.y);
    if (!act.length) continue;
    if (act[0].id !== lead) { if (lead >= 0) changes++; lead = act[0].id; }
    const k = act.slice(0, 3).map(b => b.id).sort().join();
    if (k !== top3) { if (top3) top3c++; top3 = k; }
  }
  lc.push(changes); t3.push(top3c);
}
const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log(`${process.argv[2] || 'current'} N=${N}: leader changes/race=${avg(lc)}  top-3 set changes/race=${avg(t3)}`);
