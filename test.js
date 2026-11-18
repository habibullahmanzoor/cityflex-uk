// Run: node test.js
const assert = require("assert");
const C = require("./optimiser.js");

const shape = C.loadShape();
assert(Math.abs(shape.reduce((a, b) => a + b, 0) - 1) < 1e-9, "shape sums to 1");

const load = shape.map((s) => s * 9); // 9 kWh/day
const noPv = new Array(48).fill(0);
const b = { capacity: 10, power: 5, rt: 0.9, degr: 0 };

// 1. Flat price: arbitrage has no value, optimiser must not lose vs no battery
let flat = new Array(48).fill(25);
let r = C.simulateDay(load, noPv, flat, 15, b);
assert(r.opt.cost <= r.base.cost + 1e-6, "flat price: not worse than baseline");

// 2. Cheap night, dear evening: optimiser must save money
const price = Array.from({ length: 48 }, (_, t) => (t < 10 ? 5 : t >= 34 && t < 40 ? 45 : 22));
r = C.simulateDay(load, noPv, price, 15, b);
assert(r.opt.cost < r.base.cost - 50, "arbitrage saves > 50p");
assert(r.opt.cost <= r.selfUse.cost + 1e-6, "optimal <= self-use");

// 3. Physical limits
const eff = Math.sqrt(b.rt);
r.opt.flow.forEach((f) => assert(Math.abs(f) <= b.power * C.DT + 1e-6, "power limit"));
r.opt.soc.forEach((e) => assert(e >= -1e-9 && e <= b.capacity + 1e-9, "SoC bounds"));
assert(Math.abs(r.opt.soc[47] - b.capacity / 2) < 1e-6, "ends at start SoC");

// 4. Energy balance: grid = net + flow
r.opt.grid.forEach((g, t) => assert(Math.abs(g - (r.net[t] + r.opt.flow[t])) < 1e-9));

// 5. Degradation cost can switch the battery off
const dear = C.simulateDay(load, noPv, price, 15, { ...b, degr: 100 });
assert(Math.abs(dear.opt.cost - dear.base.cost) < 1e-6, "huge degradation -> idle");

// 6. Bigger battery never worse
const big = C.simulateDay(load, noPv, price, 15, { ...b, capacity: 20 });
assert(big.opt.cost <= r.opt.cost + 1e-6, "monotone in capacity");

// 7. Half-hourly export prices: arrays work and beat a low flat rate
const expHH = Array.from({ length: 48 }, (_, t) => (t >= 34 && t < 40 ? 40 : 5));
const rHH = C.simulateDay(load, noPv, price, expHH, b);
const rFlat = C.simulateDay(load, noPv, price, 5, b);
assert(rHH.opt.cost <= rFlat.opt.cost + 1e-6, "dearer export never hurts");

// 8. All load shapes are valid distributions; office is daytime-heavy
["home", "office", "retail", "flat"].forEach((k) => {
  const s = C.loadShape(k);
  assert(s.length === 48 && Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9, k);
});
const off = C.loadShape("office");
assert(off[24] > 3 * off[4], "office: noon load >> 2am load");

console.log("all tests passed");
