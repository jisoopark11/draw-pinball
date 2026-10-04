// Headless checks: node tests/sim.js
const assert = require('assert');
const E = require('../js/engine.js');

// parsing
assert.deepStrictEqual(E.parseEntries('No1, No2*3\nKim').balls, ['No1', 'No2', 'No2', 'No2', 'Kim']);
assert.deepStrictEqual(E.parseEntries('A * 2, B*0').balls, ['A', 'A']);
assert.deepStrictEqual(E.parseRanges('1-3, 5, 8~10, 99', 10), [1, 2, 3, 5, 8, 9, 10]);
assert.deepStrictEqual(E.winnerRanks('last', '', 7), [7]);

// grouping: 13 balls, 3 groups, dealt out round-robin by rank
const grp = E.buildGroups(Array.from({ length: 13 }, (_, i) => i), 3).map(g => g.map(m => m.rank));
assert.deepStrictEqual(grp, [[1, 4, 7, 10, 13], [2, 5, 8, 11], [3, 6, 9, 12]]);
assert.strictEqual(E.groupOf(7, 3), 1);

// simulation
let worst = 0;
for (const n of [2, 6, 30, 100, 200]) {
  for (let s = 1; s <= 6; s++) {
    const map = E.createMap(s * 7919);
    const g = new E.Game(Array.from({ length: n }, (_, i) => 'b' + i), map, s);
    let steps = 0;
    while (!g.over && steps < 120 * 400) { g.step(); steps++; }
    assert(g.over, `n=${n} seed=${s} did not finish`);
    assert.strictEqual(g.ranking.length, n);
    const first = g.ranking[0].time, last = g.ranking[n - 1].time;
    worst = Math.max(worst, last);
    console.log(`n=${String(n).padStart(3)} seed=${s} H=${Math.round(map.H)} first=${first.toFixed(1)}s last=${last.toFixed(1)}s`);
  }
}
console.log('OK, slowest last-finisher:', worst.toFixed(1) + 's');
