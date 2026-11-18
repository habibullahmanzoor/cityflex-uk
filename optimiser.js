/* CityFlex optimiser: dynamic programming dispatch for a home battery.
 * One day = 48 half-hour slots. All energies kWh, prices p/kWh, costs pence.
 * UMD: works in the browser (window.CityFlex) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CityFlex = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DT = 0.5; // hours per slot

  /** Half-hourly load shape (48 values summing to 1).
   *  kind: home | office (8-18h) | retail (7-21h) | flat (24/7, light daytime bump) */
  function loadShape(kind) {
    const sg = (x) => 1 / (1 + Math.exp(-x));
    const plateau = (h, a, b) => sg((h - a) * 2.2) * sg((b - h) * 2.2);
    const s = [];
    for (let i = 0; i < 48; i++) {
      const h = (i + 0.5) / 2;
      const g = (mu, sd, a) => a * Math.exp(-0.5 * ((h - mu) / sd) ** 2);
      let v;
      if (kind === "office") v = 0.18 + plateau(h, 8, 18);
      else if (kind === "retail") v = 0.22 + plateau(h, 7, 21);
      else if (kind === "flat") v = 0.85 + 0.25 * plateau(h, 6, 22);
      else v = 0.35 + g(7.5, 1.2, 0.9) + g(18.5, 1.8, 1.6);
      s.push(v);
    }
    const sum = s.reduce((a, b) => a + b, 0);
    return s.map((v) => v / sum);
  }

  /**
   * Cost of one day for a given battery policy.
   * net[t]  = household load - PV in the slot (kWh, may be negative)
   * imp[t]  = import price, expRate = flat export price
   * Returns {cost, soc[], flow[] (battery AC-side kWh, +charge), grid[]}
   */
  function gridCost(g, imp, t, exp) {
    const e = Array.isArray(exp) ? exp[t] : exp; // flat rate or half-hourly array
    return g >= 0 ? imp[t] * g : e * g; // g<0 -> revenue (negative cost)
  }

  function noBattery(net, imp, expRate) {
    let cost = 0;
    const grid = net.slice();
    for (let t = 0; t < 48; t++) cost += gridCost(net[t], imp, t, expRate);
    return { cost, soc: new Array(48).fill(0), flow: new Array(48).fill(0), grid };
  }

  /** Self-consumption: charge from surplus only, discharge to cover deficit. */
  function selfUse(net, imp, expRate, b) {
    const eff = Math.sqrt(b.rt);
    let e = b.capacity * 0.5, cost = 0;
    const soc = [], flow = [], grid = [];
    for (let t = 0; t < 48; t++) {
      let f = 0;
      if (net[t] < 0) f = Math.min(-net[t], b.power * DT, (b.capacity - e) / eff);
      else f = -Math.min(net[t], b.power * DT, e * eff);
      e += f > 0 ? f * eff : f / eff;
      const g = net[t] + f;
      cost += gridCost(g, imp, t, expRate) + (b.degr || 0) * Math.abs(f);
      soc.push(e); flow.push(f); grid.push(g);
    }
    // Value energy used from (or added to) the 50% starting charge at the day's
    // mean import price, so the policy is judged on the same terms as the DP,
    // which must end the day where it started.
    const mean = imp.reduce((a, c) => a + c, 0) / 48;
    cost += (b.capacity * 0.5 - e) * eff * mean;
    return { cost, soc, flow, grid };
  }

  /**
   * Optimal dispatch by DP (perfect foresight within the day).
   * b = {capacity kWh, power kW, rt 0..1, degr p/kWh throughput}
   * Starts and ends at 50% state of charge.
   */
  function optimise(net, imp, expRate, b, levels) {
    const N = levels || 40;
    const eff = Math.sqrt(b.rt);
    const step = b.capacity / N;
    const start = Math.round(N / 2);
    const INF = 1e18;
    const maxBat = b.power * DT; // AC-side kWh per slot
    const V = [];
    const next = new Array(N + 1).fill(INF);
    next[start] = 0; // terminal: must end at start level
    V[48] = next;
    const choice = [];
    for (let t = 47; t >= 0; t--) {
      const cur = new Array(N + 1).fill(INF);
      const ch = new Array(N + 1).fill(0);
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
          if (V[t + 1][j] >= INF) continue;
          const de = (j - i) * step; // change in stored energy
          const f = de >= 0 ? de / eff : de * eff; // AC-side flow
          if (Math.abs(f) > maxBat + 1e-9) continue;
          const c = gridCost(net[t] + f, imp, t, expRate) + (b.degr || 0) * Math.abs(f) + V[t + 1][j];
          if (c < cur[i]) { cur[i] = c; ch[i] = j; }
        }
      }
      V[t] = cur; choice[t] = ch;
    }
    let i = start, cost = V[0][start];
    const soc = [], flow = [], grid = [];
    for (let t = 0; t < 48; t++) {
      const j = choice[t][i];
      const de = (j - i) * step;
      const f = de >= 0 ? de / eff : de * eff;
      flow.push(f); grid.push(net[t] + f); soc.push(j * step);
      i = j;
    }
    return { cost, soc, flow, grid };
  }

  /** Run all three policies for one day. Costs include degradation cost. */
  function simulateDay(load, pv, imp, expRate, b) {
    const net = load.map((l, t) => l - pv[t]);
    const base = noBattery(net, imp, expRate);
    const su = selfUse(net, imp, expRate, b);
    const opt = optimise(net, imp, expRate, b);
    return { base, selfUse: su, opt, net };
  }

  return { DT, loadShape, noBattery, selfUse, optimise, simulateDay };
});
