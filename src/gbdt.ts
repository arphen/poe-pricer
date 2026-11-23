// Gradient-boosted regression trees, squared loss, histogram splits over sparse features.
// Dependency-free and small: features absent from a row count as 0, and histograms are built
// from the nonzero entries only, so cost scales with the filled cells.
export type Node = { f: number; t: number; l: number; r: number; v: number }; // f < 0: leaf
export type Model = { bias: number; trees: Node[][]; features: string[] };
// weights: per-row sample weight (default 1); node sizes and minLeaf are then counted in weight
// expectile: 0.5 = squared loss (the mean); lower leans toward the cheap end: a row priced above the
// current guess pulls with weight tau, one below with 1 - tau (asymmetric least squares)
// monotone: per feature name, +1 = the prediction may only rise with it (more life is never worth
// less), -1 = only fall, 0/absent = free. Enforced per tree: a split on a constrained feature must
// order its children, and caps everything below them at their midpoint (sum of monotone trees stays
// monotone).
export type Opts = { trees?: number; depth?: number; lr?: number; minLeaf?: number; bins?: number; lambda?: number; weights?: number[]; expectile?: number; monotone?: (feature: string) => number };
export type Row = Record<string, number>;

export function train(rows: Row[], y: number[], features: string[], o: Opts = {}): Model {
  const { trees = 200, depth = 4, lr = 0.08, minLeaf = 5, bins = 32, lambda = 2, expectile: tau = 0.5 } = o;
  const n = rows.length;
  const w = Float64Array.from({ length: n }, (_, i) => o.weights?.[i] ?? 1);
  const W = w.reduce((a, b) => a + b, 0);
  const F = features.length;
  const fi = new Map(features.map((k, i) => [k, i]));
  const mono = features.map((k) => Math.sign(o.monotone?.(k) ?? 0));
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  // per feature: candidate thresholds (quantiles of all values incl. 0) and each row's bin
  const nzRows: number[][] = Array.from({ length: F }, () => []);
  const nzVals: number[][] = Array.from({ length: F }, () => []);
  rows.forEach((r, i) => {
    for (const k in r) {
      const j = fi.get(k);
      if (j !== undefined && r[k] !== 0) (nzRows[j].push(i), nzVals[j].push(r[k]));
    }
  });
  const thr: number[][] = [];
  const zbin: number[] = [];
  const bin: Uint8Array[] = [];
  const binOf = (t: number[], x: number) => {
    let lo = 0, hi = t.length; // first threshold >= x, or t.length
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (t[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  for (let j = 0; j < F; j++) {
    const vals = [...nzVals[j], 0].sort((a, b) => a - b);
    const t = [...new Set(Array.from({ length: bins }, (_, q) => vals[Math.floor((q * (vals.length - 1)) / (bins - 1))]))];
    thr.push(t);
    zbin.push(binOf(t, 0));
    const b = new Uint8Array(n).fill(zbin[j]);
    nzRows[j].forEach((i, k) => (b[i] = binOf(t, nzVals[j][k])));
    bin.push(b);
  }

  const bias = y.reduce((a, b, i) => a + w[i] * b, 0) / Math.max(1e-9, W);
  const pred = new Float64Array(n).fill(bias);
  const out: Node[][] = [];
  const nodeOf = new Int32Array(n);

  const g = new Float64Array(n); // weighted residuals
  const h = new Float64Array(n); // their curvature: the weight, scaled by the expectile side
  for (let it = 0; it < trees; it++) {
    let S = 0, H = 0;
    for (let i = 0; i < n; i++) {
      const r = y[i] - pred[i];
      const a = tau === 0.5 ? 1 : 2 * (r > 0 ? tau : 1 - tau); // 2x: tau 0.5 is plain squared loss
      g[i] = w[i] * a * r, h[i] = w[i] * a;
      S += g[i], H += h[i];
    }
    const tree: Node[] = [];
    tree.push({ f: -1, t: 0, l: -1, r: -1, v: (lr * S) / (H + lambda) });
    nodeOf.fill(0);
    // S: residual sum, c: curvature sum (leaf values, gains), m: weight sum (leaf size),
    // lo/hi: what monotone splits above allow this subtree's values to be
    let level = [{ node: 0, S, c: H, m: W, lo: -Infinity, hi: Infinity }];
    const bounds = new Map<number, [number, number]>();

    for (let d = 0; d < depth && level.length; d++) {
      const slot = new Map(level.map((x, s) => [x.node, s]));
      const best = level.map(() => ({ gain: 1e-9, f: -1, b: -1, vl: 0, vr: 0 }));
      const nb = bins + 1;
      const hs = new Float64Array(level.length * nb);
      const hc = new Float64Array(level.length * nb);
      const hm = new Float64Array(level.length * nb);
      for (let j = 0; j < F; j++) {
        if (nzRows[j].length < minLeaf) continue;
        hs.fill(0), hc.fill(0), hm.fill(0);
        const z = zbin[j], bj = bin[j];
        // nonzero entries go to their bin; everything else in the node lands in the zero bin
        for (const i of nzRows[j]) {
          const s = slot.get(nodeOf[i]);
          if (s === undefined) continue;
          hs[s * nb + bj[i]] += g[i], hc[s * nb + bj[i]] += h[i], hm[s * nb + bj[i]] += w[i];
        }
        level.forEach((x, s) => {
          let ns = 0, nc = 0, nm = 0;
          for (let b = 0; b < nb; b++) (ns += hs[s * nb + b]), (nc += hc[s * nb + b]), (nm += hm[s * nb + b]);
          hs[s * nb + z] += x.S - ns, hc[s * nb + z] += x.c - nc, hm[s * nb + z] += x.m - nm;
          const parent = (x.S * x.S) / (x.c + lambda);
          let ls = 0, lc = 0, lm = 0;
          for (let b = 0; b < thr[j].length; b++) {
            ls += hs[s * nb + b], lc += hc[s * nb + b], lm += hm[s * nb + b];
            const rc = x.c - lc;
            if (lm < minLeaf || x.m - lm < minLeaf) continue;
            const rs = x.S - ls;
            const gain = (ls * ls) / (lc + lambda) + (rs * rs) / (rc + lambda) - parent;
            if (gain <= best[s].gain) continue;
            const vl = clamp((lr * ls) / (lc + lambda), x.lo, x.hi), vr = clamp((lr * rs) / (rc + lambda), x.lo, x.hi);
            if ((mono[j] > 0 && vl > vr) || (mono[j] < 0 && vl < vr)) continue; // would invert the order
            best[s] = { gain, f: j, b, vl, vr };
          }
        });
      }
      // split: children get stats, rows move down
      const next: typeof level = [];
      const kids = new Map<number, [number, number, number, number]>(); // left, right, feature, bin
      level.forEach((x, s) => {
        const bs = best[s];
        if (bs.f < 0) return;
        const node = tree[x.node];
        node.f = bs.f, node.t = thr[bs.f][bs.b];
        node.l = tree.push({ f: -1, t: 0, l: -1, r: -1, v: 0 }) - 1;
        node.r = tree.push({ f: -1, t: 0, l: -1, r: -1, v: 0 }) - 1;
        kids.set(x.node, [node.l, node.r, bs.f, bs.b]);
        const mid = (bs.vl + bs.vr) / 2;
        const m = mono[bs.f];
        bounds.set(node.l, m > 0 ? [x.lo, Math.min(x.hi, mid)] : m < 0 ? [Math.max(x.lo, mid), x.hi] : [x.lo, x.hi]);
        bounds.set(node.r, m > 0 ? [Math.max(x.lo, mid), x.hi] : m < 0 ? [x.lo, Math.min(x.hi, mid)] : [x.lo, x.hi]);
      });
      const acc = new Map<number, { S: number; c: number; m: number }>();
      for (let i = 0; i < n; i++) {
        const k = kids.get(nodeOf[i]);
        if (!k) {
          nodeOf[i] = -1; // finished leaf
          continue;
        }
        nodeOf[i] = bin[k[2]][i] <= k[3] ? k[0] : k[1];
        const a = acc.get(nodeOf[i]) ?? { S: 0, c: 0, m: 0 };
        a.S += g[i], a.c += h[i], a.m += w[i];
        acc.set(nodeOf[i], a);
      }
      for (const [node, a] of acc) {
        const [lo, hi] = bounds.get(node)!;
        tree[node].v = clamp((lr * a.S) / (a.c + lambda), lo, hi);
        next.push({ node, S: a.S, c: a.c, m: a.m, lo, hi });
      }
      level = next;
    }
    for (let i = 0; i < n; i++) pred[i] += tree[leafOf(tree, rows[i], features)].v;
    out.push(tree);
  }
  return { bias, trees: out, features };
}

function leafOf(tree: Node[], row: Row, features: string[]) {
  let k = 0;
  while (tree[k].f >= 0) k = (row[features[tree[k].f]] ?? 0) <= tree[k].t ? tree[k].l : tree[k].r;
  return k;
}

export function predict(m: Model, row: Row): number {
  let p = m.bias;
  for (const t of m.trees) p += t[leafOf(t, row, m.features)].v;
  return p;
}

// Per-feature contributions (Saabas): each split's change in node value is credited to its feature.
// They sum exactly to prediction - base, so "why is this item worth X" reads straight off them.
export function contributions(m: Model, row: Row): { base: number; byFeature: Record<string, number> } {
  let base = m.bias;
  const byFeature: Record<string, number> = {};
  for (const t of m.trees) {
    base += t[0].v;
    let k = 0;
    while (t[k].f >= 0) {
      const next = (row[m.features[t[k].f]] ?? 0) <= t[k].t ? t[k].l : t[k].r;
      const name = m.features[t[k].f];
      byFeature[name] = (byFeature[name] ?? 0) + t[next].v - t[k].v;
      k = next;
    }
  }
  return { base, byFeature };
}
