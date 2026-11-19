"use strict";
/* Heat Sync (Rakerscreen extra, Settings → Heat Sync)
   Reads the heater stats Klipper writes to klippy.log about once a second
   ("extruder: target=200 temp=187.3 pwm=1.000"), finds every heat-up (a target raised by 10 °C or
   more), and splits each into phases using the first and second derivative of temperature:
     lag       T' still under 10 % of its peak (the heater warms, the sensor hasn't seen it yet)
     speed-up  T'' > 0, rising faster and faster, up to the inflection point (peak T')
     approach  T'' < 0, full power but slowing as losses grow: T' decays like e^(-t/τ)
     hold      target reached, the PID regulates
   From the approach phase it takes the time constant τ (median of -T'/T'', and a straight-line fit
   of ln T' against time) and the full-power ceiling T∞ = T + τ·T'. Runs are recorded so they build up
   over time, and the model predicts heat-up times: L + τ·ln((T∞ − T0) / (T∞ − Ttarget)). */

const HeatSync = {
  STORE: "heat_sync_runs",
  MAX_PER_HEATER: 30,
  LOG_BYTES: 2 * 1024 * 1024, // about an hour of klippy.log

  // ------------------------------------------------------------ parsing
  /** klippy.log text -> [{name, samples:[{t, wall, target, temp, pwm}]}], split where Klipper restarted. */
  parse(text) {
    const series = {};
    let wall0 = null, mono0 = null, lastT = -Infinity, session = 0;
    const heat = /(\S+): target=(-?[\d.]+) temp=(-?[\d.]+) pwm=([\d.]+)/g;
    for (const line of text.split("\n")) {
      const sp = line.match(/Start printer at .*\(([\d.]+) ([\d.]+)\)/);
      if (sp) { wall0 = parseFloat(sp[1]); mono0 = parseFloat(sp[2]); session++; lastT = -Infinity; continue; }
      const m = line.match(/^Stats ([\d.]+):/);
      if (!m) continue;
      const t = parseFloat(m[1]);
      if (t < lastT) { session++; wall0 = mono0 = null; } // restarted without a start line in view
      lastT = t;
      const wall = wall0 !== null ? wall0 + (t - mono0) : null;
      heat.lastIndex = 0;
      let h;
      while ((h = heat.exec(line))) {
        const key = `${session}|${h[1]}`;
        (series[key] = series[key] || { name: h[1], samples: [] }).samples.push({ t, wall, target: +h[2], temp: +h[3], pwm: +h[4] });
      }
    }
    return Object.values(series);
  },

  /** Heat-ups in one heater's samples: from a target raised by ≥ 10 °C to the next target change (max 30 min). */
  findRuns(s) {
    const out = [], x = s.samples;
    for (let k = 1; k < x.length; k++) {
      if (!(x[k].target >= x[k - 1].target + 10 && x[k].target >= x[k].temp + 10)) continue;
      let e = k + 1;
      while (e < x.length && Math.abs(x[e].target - x[k].target) < 0.5 && x[e].t - x[k].t <= 1800) e++;
      if (x[e - 1].t - x[k].t < 30) continue; // too short to say anything
      out.push({ name: s.name, samples: x.slice(k - 1, e) });
    }
    return out;
  },

  // ------------------------------------------------------------ maths
  /** Even 1 s grid by linear interpolation. */
  resample(samples, key) {
    const t0 = samples[0].t, n = Math.floor(samples[samples.length - 1].t - t0) + 1, out = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i;
      while (j < samples.length - 2 && samples[j + 1].t < t) j++;
      const a = samples[j], b = samples[Math.min(j + 1, samples.length - 1)];
      const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      out[i] = a[key] + (b[key] - a[key]) * f;
    }
    return out;
  },
  /** Savitzky–Golay quadratic fit over ±m samples: smoothed value, first and second derivative (per sample). */
  savgol(y, m) {
    const n = y.length, s = [], d1 = [], d2 = [];
    for (let i = 0; i < n; i++) {
      const w = Math.min(m, i, n - 1 - i);
      if (w < 1) { s.push(y[i]); d1.push(NaN); d2.push(NaN); continue; }
      let S0 = 0, S2 = 0, S4 = 0, Sy = 0, S1y = 0, S2y = 0;
      for (let k = -w; k <= w; k++) { const v = y[i + k], k2 = k * k; S0++; S2 += k2; S4 += k2 * k2; Sy += v; S1y += k * v; S2y += k2 * v; }
      const det = S0 * S4 - S2 * S2;
      const a0 = (S4 * Sy - S2 * S2y) / det, a2 = (S0 * S2y - S2 * Sy) / det;
      s.push(a0); d1.push(S1y / S2); d2.push(2 * a2);
    }
    // fill the ends from their neighbours
    const fill = (a) => { const first = a.findIndex((v) => !isNaN(v)); for (let i = 0; i < first; i++) a[i] = a[first]; for (let i = n - 1; i >= 0 && isNaN(a[i]); i--) a[i] = a[i - 1]; };
    fill(d1); fill(d2);
    return { s, d1, d2 };
  },
  median(a) { if (!a.length) return null; const b = [...a].sort((p, q) => p - q), h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; },
  /** Derivatives for a temperature series (1 s grid): T' from ±4 s, T'' from ±8 s (it's the noisier one). */
  derive(T) {
    const a = this.savgol(T, 4), b = this.savgol(T, 8);
    return { Ts: a.s, d1: a.d1, d2: b.d2 };
  },

  /** One heat-up -> phases and constants (times in seconds from the target change). */
  analyze(run) {
    const x = run.samples, start = x[1]; // x[0] is the sample before the change
    const T = this.resample(x.slice(1), "temp"), P = this.resample(x.slice(1), "pwm");
    const target = start.target, n = T.length;
    const { Ts, d1, d2 } = this.derive(T);
    const T0 = x[0].temp;
    const reach = T.findIndex((v) => v >= target - 1);
    const end = reach >= 0 ? reach : n - 1;
    let iMax = 0;
    for (let i = 1; i <= end; i++) if (d1[i] > d1[iMax]) iMax = i;
    const rmax = d1[iMax];
    const r = { heater: run.name, wall: start.wall, mono: start.t, T0, target, duration: n - 1,
      tReach: reach >= 0 ? reach : null, rmax: rmax > 0 ? rmax : null, tInfl: iMax };
    if (!(rmax > 0.01)) { r.note = "No clear rise"; r.phases = []; return this.pack(r, T); }
    const i10 = Math.max(0, d1.findIndex((v, i) => i <= iMax && v >= 0.1 * rmax));
    // tangent at the inflection point meets the starting temperature: dead time L
    r.lag = Math.min(iMax, Math.max(0, iMax - (Ts[iMax] - T0) / rmax));
    // approach: after the inflection, still at (near) full power, still rising clearly, curving down
    const saturated = P.some((v) => v > 0) ? (i) => P[i] >= 0.95 : () => true;
    // start where T'' is most negative: before that the sensor's own lag still bends the curve, after it
    // the heater's main time constant is what's left
    // only the unbroken full-power stretch, less the smoothing window where power starts to drop
    let endSat = iMax;
    while (endSat + 1 <= end && saturated(endSat + 1)) endSat++;
    const last = Math.max(iMax, endSat - 8);
    let iBend = iMax;
    for (let i = iMax + 1; i <= last; i++) if (d2[i] < d2[iBend]) iBend = i;
    const idx = [];
    for (let i = iBend; i <= last; i++) if (d1[i] > 0.05 * rmax && d2[i] < -1e-4) idx.push(i);
    if (idx.length >= 6) {
      r.tauRatio = this.median(idx.map((i) => -d1[i] / d2[i]));
      // ln T' = c − t/τ
      let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
      for (const i of idx) { const y = Math.log(d1[i]); sx += i; sy += y; sxx += i * i; sxy += i * y; syy += y * y; }
      const k = idx.length, cov = sxy - (sx * sy) / k, vx = sxx - (sx * sx) / k, vy = syy - (sy * sy) / k;
      const slope = cov / vx;
      r.r2 = vx > 0 && vy > 0 ? (cov * cov) / (vx * vy) : 0;
      if (slope < 0) r.tauFit = -1 / slope;
      // the fit wins only when it's clean; on short or noisy stretches the median ratio holds up better
      r.tau = r.tauFit && r.r2 >= 0.95 ? r.tauFit : r.tauRatio;
      if (r.tau > 0) r.tinf = this.median(idx.map((i) => Ts[i] + r.tau * d1[i]));
    } else r.note = reach >= 0 && reach - iMax < 8 ? "Reached target before the curve bent: no time constant" : "Not enough full-power data after the inflection";
    if (reach >= 0) r.overshoot = Math.max(...T.slice(reach)) - target;
    r.phases = [["lag", 0, i10], ["speedup", i10, iMax], ["approach", iMax, end]];
    if (reach >= 0 && reach < n - 1) r.phases.push(["hold", reach, n - 1]);
    return this.pack(r, T);
  },
  /** Keep the curve with the result (≤ 600 points) so it can be drawn again later. */
  pack(r, T) {
    const step = Math.max(1, Math.ceil(T.length / 600));
    r.step = step;
    r.T = T.filter((_, i) => i % step === 0).map((v) => Math.round(v * 10) / 10);
    r.id = `${r.heater}|${r.wall ? Math.round(r.wall) : "m" + Math.round(r.mono)}|${r.target}`;
    return r;
  },

  // ------------------------------------------------------------ records and model
  load() { const v = Settings.get(this.STORE); return Array.isArray(v) ? v : []; },
  save(runs) { Settings.set(this.STORE, runs); },
  /** Analyse a log and add its heat-ups to the record. Returns {found, added}. */
  record(text) {
    const runs = [];
    for (const s of this.parse(text)) for (const run of this.findRuns(s)) runs.push(this.analyze(run));
    const have = this.load(), ids = new Set(have.map((r) => r.id));
    const fresh = runs.filter((r) => !ids.has(r.id));
    let all = [...have, ...fresh];
    // newest MAX_PER_HEATER per heater (by wall time when known, else as found)
    const by = {};
    for (const r of all) (by[r.heater] = by[r.heater] || []).push(r);
    all = Object.values(by).flatMap((list) => list.slice(-this.MAX_PER_HEATER));
    this.save(all);
    return { found: runs.length, added: fresh.length };
  },
  /** The heater's model: a saved one (Model page) if there is one, else medians over its recorded runs. */
  model(heater) {
    const custom = (Settings.get(this.CUSTOM) || {})[heater];
    if (custom) return { ...custom, n: 0, custom: true, rmax: this.toVA(custom, custom.tinf - 23).v };
    const runs = this.load().filter((r) => r.heater === heater && r.tau > 0 && r.tinf);
    if (!runs.length) return null;
    const med = (k) => this.median(runs.map((r) => r[k]).filter((v) => typeof v === "number"));
    return { n: runs.length, tau: med("tau"), lag: med("lag") || 0, tinf: med("tinf"), rmax: med("rmax") };
  },
  /** Seconds to heat from T0 to Tt at full power, or null if the model says it can't get there. */
  predict(m, T0, Tt) {
    if (!m || Tt <= T0) return 0;
    if (Tt >= m.tinf - 0.5) return null;
    if (m.taus) { // two-lag model: walk the curve
      const c = this.curve(m, T0, Infinity, 7200);
      const i = c.T.findIndex((v) => v >= Tt);
      return i >= 0 ? i : null;
    }
    return m.lag + m.tau * Math.log((m.tinf - T0) / (m.tinf - Tt));
  },

  // ------------------------------------------------------------ the two-lag model (Model page)
  /* After the lag L, full power drives the heater towards T∞ with time constant τ, and the sensor follows
     the heater with its own, shorter, τs. With A = T∞ − T0 and u = t − L:
       T  = T0 + A·[1 − (τ·e^(−u/τ) − τs·e^(−u/τs)) / (τ − τs)]
       T′ = A·(e^(−u/τ) − e^(−u/τs)) / (τ − τs)               peak (velocity) v = (A/τ)·r^(r/(1−r)), r = τs/τ
       T″ = A·(e^(−u/τs)/τs − e^(−u/τ)/τ) / (τ − τs)           peak (acceleration, at u = 0) a = A/(τ·τs)  */
  CUSTOM: "heat_sync_models",
  /** Model curve on a 1 s grid; once it reaches the target it holds there (an ideal PID). */
  curve(p, T0, target, n) {
    const T = new Array(n), d1 = new Array(n), d2 = new Array(n);
    const A = p.tinf - T0, tau = Math.max(1, p.tau);
    const ts = Math.min(Math.max(0.2, p.taus || 0), tau * 0.995);
    let held = false;
    for (let i = 0; i < n; i++) {
      const u = i - p.lag;
      if (held) { T[i] = target; d1[i] = 0; d2[i] = 0; continue; }
      if (u <= 0) { T[i] = T0; d1[i] = 0; d2[i] = 0; continue; }
      const e1 = Math.exp(-u / tau), e2 = Math.exp(-u / ts), k = tau - ts;
      T[i] = T0 + A * (1 - (tau * e1 - ts * e2) / k);
      d1[i] = (A * (e1 - e2)) / k;
      d2[i] = (A * (e2 / ts - e1 / tau)) / k;
      if (T[i] >= target) { T[i] = target; held = true; }
    }
    return { T, d1, d2 };
  },
  /** τ, τs -> peak velocity and acceleration for a rise of A. */
  toVA(p, A) {
    const r = Math.min(0.995, Math.max(1e-4, p.taus / p.tau));
    return { v: (A / p.tau) * Math.pow(r, r / (1 - r)), a: A / (p.tau * p.taus) };
  },
  /** Peak velocity and acceleration -> τ, τs (A fixed). v²/(A·a) = r·r^(2r/(1−r)) climbs from 0 to e⁻² as r goes 0 → 1,
      so a has a floor for a given v: below it there's no such heater, and a is raised to it (adjusted: true). */
  fromVA(A, v, a) {
    const h = (r) => r * Math.pow(r, (2 * r) / (1 - r));
    const rMax = 0.995, hMax = h(rMax);
    let want = (v * v) / (A * a), adjusted = false;
    if (!(want < hMax)) { want = hMax * 0.999; a = (v * v) / (A * want); adjusted = true; }
    let lo = 1e-6, hi = rMax;
    for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (h(mid) < want) lo = mid; else hi = mid; }
    const r = (lo + hi) / 2, tau = Math.sqrt(A / (a * r));
    return { tau, taus: r * tau, a, adjusted };
  },
  /** Real run on a 1 s grid (stored curves are thinned to ≤ 600 points). */
  realCurve(r) {
    const T = r.T, s = r.step, out = [];
    for (let i = 0; i < T.length; i++) {
      if (i === T.length - 1 || s === 1) { out.push(T[i]); continue; }
      for (let k = 0; k < s; k++) out.push(T[i] + ((T[i + 1] - T[i]) * k) / s);
    }
    return out;
  },
  /** Least squares over the heat-up (up to the target) with Nelder–Mead on L, T∞, ln τ, ln τs. */
  fit(r) {
    const T = this.realCurve(r), n = Math.min(T.length, (r.tReach !== null ? r.tReach : T.length - 1) + 1);
    if (n < 15) return null;
    const T0 = r.T0, target = r.target;
    const unpack = (x) => ({ lag: Math.max(0, x[0]), tinf: x[1], tau: Math.exp(x[2]), taus: Math.exp(x[3]) });
    const cost = (x) => {
      const p = unpack(x);
      if (p.taus >= p.tau * 0.99 || p.tinf <= target + 0.5) return 1e12;
      const c = this.curve(p, T0, Infinity, n);
      let s = 0;
      for (let i = 0; i < n; i++) { const d = c.T[i] - T[i]; s += d * d; }
      return s;
    };
    const tau0 = r.tau || Math.max(20, (r.tReach || n) / 1.5);
    let simplex = [[r.lag || 2, r.tinf || target + 60, Math.log(tau0), Math.log(Math.max(1, tau0 * 0.08))]];
    const steps = [2, 15, 0.3, 0.5];
    for (let k = 0; k < 4; k++) { const x = simplex[0].slice(); x[k] += steps[k]; simplex.push(x); }
    let f = simplex.map(cost);
    for (let it = 0; it < 600; it++) {
      const ord = f.map((v, i) => i).sort((a, b) => f[a] - f[b]);
      simplex = ord.map((i) => simplex[i]); f = ord.map((i) => f[i]);
      if (f[4] - f[0] < 1e-6 * (1 + f[0])) break;
      const c = [0, 1, 2, 3].map((k) => (simplex[0][k] + simplex[1][k] + simplex[2][k] + simplex[3][k]) / 4);
      const pt = (t) => c.map((v, k) => v + t * (simplex[4][k] - v));
      const xr = pt(-1), fr = cost(xr);
      if (fr < f[0]) { const xe = pt(-2), fe = cost(xe); [simplex[4], f[4]] = fe < fr ? [xe, fe] : [xr, fr]; }
      else if (fr < f[3]) { simplex[4] = xr; f[4] = fr; }
      else {
        const xc = pt(fr < f[4] ? -0.5 : 0.5), fc = cost(xc);
        if (fc < Math.min(fr, f[4])) { simplex[4] = xc; f[4] = fc; }
        else for (let i = 1; i < 5; i++) { simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k])); f[i] = cost(simplex[i]); }
      }
    }
    const p = unpack(simplex[0]);
    return { ...p, rms: Math.sqrt(f[0] / n) };
  },
  /** RMS error (°C) of a model against the real heat-up. */
  rms(p, r) {
    const T = this.realCurve(r), n = Math.min(T.length, (r.tReach !== null ? r.tReach : T.length - 1) + 1);
    const c = this.curve(p, r.T0, Infinity, n);
    let s = 0;
    for (let i = 0; i < n; i++) s += (c.T[i] - T[i]) ** 2;
    return Math.sqrt(s / n);
  },
  saveCustom(heater, p) {
    const all = { ...(Settings.get(this.CUSTOM) || {}) };
    if (p) all[heater] = { lag: p.lag, tinf: p.tinf, tau: p.tau, taus: p.taus }; else delete all[heater];
    Settings.set(this.CUSTOM, all);
  },
};

const fmtSecs = (s) => {
  if (s === null || s === undefined || !isFinite(s)) return "–";
  s = Math.round(s);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const HS_PHASES = { lag: ["Lag", "rgba(150,150,150,.22)"], speedup: ["Speed-up", "rgba(240,160,40,.22)"], approach: ["Approach", "rgba(60,140,230,.22)"], hold: ["Hold", "rgba(60,180,100,.2)"] };

Panels.heat_sync = class extends Panel {
  constructor(app, title) {
    super(app, title || "Heat Sync");
    this.heater = null;
    this.sel = null;
    this.status = el("span", { class: "hs-status" });
    this.heaterBar = el("div", { class: "hs-heaters" });
    const read = Button("refresh", "Read log", "color1", { side: true, lines: 1, onclick: (e, b) => this.readLog(b) });
    const clear = Button("delete", "Clear", "color2", { side: true, lines: 1, onclick: () => this.app.dialog("Clear Heat Sync", [
      { name: "Clear", style: "dialog-error", cb: () => { HeatSync.save([]); this.sel = null; this.render(); } },
      { name: "Cancel", style: "dialog-default" }], "Forget every recorded heat-up?") });
    this.left = el("div", { class: "hs-left scroll" });
    this.canvas = el("canvas", { class: "hs-chart" });
    this.info = el("div", { class: "hs-info" });
    this.legend = el("div", { class: "hs-legend" }, ...Object.values(HS_PHASES).map(([n, c]) => el("span", {}, el("i", { style: { background: c.replace(/[\d.]+\)$/, ".8)") } }), n)),
      el("span", {}, el("i", { style: { background: "#f0a028" } }), "T′"), el("span", {}, el("i", { style: { background: "#b77cf0" } }), "T″"));
    this.right = el("div", { class: "hs-right" }, this.legend, this.canvas, this.info);
    this.body = el("div", { class: "hs-body fill" }, this.left, this.right);
    const model = Button("fine-tune", "Model", "color3", { side: true, lines: 1, onclick: () => this.openModel() });
    this.main = el("div", { class: "fill", style: { display: "flex", flexDirection: "column", minHeight: 0 } },
      el("div", { class: "hs-top" }, this.heaterBar, model, read, clear), this.body, el("div", { class: "hs-foot" }, this.status));
    this.el.append(this.main);
  }

  // ------------------------------------------------------------ Model page: edit the model, see it over the real run
  openModel() {
    const r = this.sel;
    if (!r) { this.app.popup("Pick a heat-up first", 1); return; }
    const saved = (Settings.get(HeatSync.CUSTOM) || {})[r.heater];
    // start from the saved model, else a fit to this run, else the run's own numbers
    this.mp = saved ? { ...saved } : HeatSync.fit(r) || { lag: r.lag || 2, tinf: r.tinf || r.target + 60, tau: r.tau || 60, taus: Math.max(1, (r.tau || 60) * 0.08) };
    this.mNote = saved ? "Saved model" : "Fitted to this run";
    this.main.style.display = "none";
    this.mView = el("div", { class: "fill hs-model" });
    this.el.append(this.mView);
    this.renderModel();
    this.app.updateActionBar();
  }
  closeModel() {
    if (this.mView) { this.mView.remove(); this.mView = null; }
    this.main.style.display = "flex";
    this.render();
    this.app.updateActionBar();
  }
  canGoBack() { return !!this.mView; }
  back() { if (this.mView) { this.closeModel(); return true; } return false; }
  deactivate() { if (this.mView) this.closeModel(); }
  /** Set one variable; velocity/acceleration go through fromVA (they set τ and τs). */
  setVar(key, val) {
    const r = this.sel, p = this.mp, A = () => p.tinf - r.T0;
    if (!isFinite(val)) return;
    if (key === "lag") p.lag = Math.max(0, val);
    else if (key === "tinf") {
      // keep velocity and acceleration as they were, the new ceiling changes τ and τs
      const va = HeatSync.toVA(p, A());
      p.tinf = Math.max(r.target + 1, val);
      const s = HeatSync.fromVA(A(), va.v, va.a);
      p.tau = s.tau; p.taus = s.taus;
    } else if (key === "v" || key === "a") {
      const va = HeatSync.toVA(p, A());
      va[key] = Math.max(1e-4, val);
      const s = HeatSync.fromVA(A(), va.v, va.a);
      p.tau = s.tau; p.taus = s.taus;
      this.mNote = s.adjusted ? "Acceleration raised to the lowest a heater with this velocity can have" : "Edited";
      this.renderModel();
      return;
    } else if (key === "tau") p.tau = Math.max(p.taus * 1.05, val);
    else if (key === "taus") p.taus = Math.min(p.tau * 0.95, Math.max(0.2, val));
    this.mNote = "Edited";
    this.renderModel();
  }
  renderModel() {
    const r = this.sel, p = this.mp, V = this.mView;
    const A = p.tinf - r.T0, va = HeatSync.toVA(p, A);
    const real = HeatSync.realCurve(r);
    const ov = HeatSync.curve(p, r.T0, r.target, real.length);
    const reach = ov.T.findIndex((v) => v >= r.target);
    const rms = HeatSync.rms(p, r);
    const name = r.heater === "heater_bed" ? "Bed" : prettify(r.heater);
    // one editable variable: value (tap to type) and − / + steps
    const row = (label, key, value, unit, digits, step, mult) => {
      const val = Button(null, `${value.toFixed(digits)} ${unit}`, "hs-val", { lines: 1, onclick: () => Input.number({
        title: label, value: Number(value.toFixed(digits)), unit, min: 0, ok: "Set", keepOpen: true,
        desc: key === "v" || key === "a" ? `For this run's start, ${r.T0.toFixed(0)}°` : null,
        onSubmit: (x) => this.setVar(key, x) }) });
      const nudge = (dir) => this.setVar(key, mult ? value * (dir > 0 ? 1 + step : 1 / (1 + step)) : value + dir * step);
      return el("div", { class: "hs-var" }, el("div", { class: "name" }, label),
        Button(null, "−", "hs-step", { onclick: () => nudge(-1) }), val, Button(null, "+", "hs-step", { onclick: () => nudge(1) }));
    };
    const canvas = el("canvas", { class: "hs-chart" });
    V.innerHTML = "";
    V.append(
      el("div", { class: "hs-top" },
        el("div", { class: "hs-mtitle" }, `Model · ${name} ${r.T0.toFixed(0)}° → ${r.target}°`),
        Button("refresh", "Fit to run", "color1", { side: true, lines: 1, onclick: () => { const f = HeatSync.fit(r); if (f) { this.mp = f; this.mNote = "Fitted to this run"; this.renderModel(); } } }),
        Button("complete", "Save as model", "color3", { side: true, lines: 1, onclick: () => { HeatSync.saveCustom(r.heater, p); this.mNote = `Saved: ${name} predictions now use this model`; this.renderModel(); } }),
        (Settings.get(HeatSync.CUSTOM) || {})[r.heater]
          ? Button("delete", "Use measured", "color2", { side: true, lines: 1, onclick: () => { HeatSync.saveCustom(r.heater, null); this.mNote = "Back to the measured model"; this.renderModel(); } }) : null),
      el("div", { class: "hs-body fill" },
        el("div", { class: "hs-left scroll" },
          row("Heat velocity · peak T′", "v", va.v, "°C/s", 2, 0.05, true),
          row("Heat acceleration · peak T″", "a", va.a, "°C/s²", 3, 0.1, true),
          row("Lag", "lag", p.lag, "s", 1, 0.5, false),
          row("Full-power ceiling T∞", "tinf", p.tinf, "°C", 0, 2, false),
          row("Time constant τ", "tau", p.tau, "s", 0, 0.05, true),
          row("Sensor lag τs", "taus", p.taus, "s", 1, 0.1, true),
          el("div", { class: "hs-card" }, el("div", { class: "hs-kv" },
            el("span", {}, "Fit error"), el("b", {}, `${rms.toFixed(2)} °C RMS`),
            el("span", {}, "Model to target"), el("b", {}, reach >= 0 ? fmtSecs(reach) : "never"),
            el("span", {}, "Real to target"), el("b", {}, r.tReach !== null ? fmtSecs(r.tReach) : "not reached")),
            el("div", { class: "desc", style: { marginTop: ".3em" } }, this.mNote || ""))),
        el("div", { class: "hs-right" },
          el("div", { class: "hs-legend" }, el("span", {}, el("i", { style: { background: "currentColor" } }), "Real"),
            el("span", {}, el("i", { style: { background: "#35d0e0" } }), "Model"),
            el("span", {}, el("i", { style: { background: "#f0a028" } }), "T′"), el("span", {}, el("i", { style: { background: "#b77cf0" } }), "T″  (model dashed)")),
          canvas)));
    requestAnimationFrame(() => this.draw(r, ov, canvas));
  }
  activate() {
    const runs = HeatSync.load();
    this.status.textContent = runs.length ? `${runs.length} heat-up${runs.length === 1 ? "" : "s"} recorded · Read log adds new ones from klippy.log` : "";
    this.render();
    if (!HeatSync.load().length) this.readLog();
  }
  relayout() { if (this.mView) this.renderModel(); else this.render(); }
  async readLog(btn) {
    if (btn) btn.busy(true);
    this.status.textContent = "Reading klippy.log…";
    try {
      const text = await fetchMoonrakerLog(this.app, "klippy.log", HeatSync.LOG_BYTES);
      const { found, added } = HeatSync.record(text);
      this.status.textContent = `${found} heat-up${found === 1 ? "" : "s"} in the last ${Math.round(text.length / 1024)} KB of klippy.log · ${added} new · ${new Date().toTimeString().slice(0, 5)}`;
      this.sel = null;
      this.render();
    } catch (e) {
      this.status.textContent = `Couldn't read klippy.log: ${e.message}`;
    } finally { if (btn) btn.busy(false); }
  }
  heaters() { return [...new Set(HeatSync.load().map((r) => r.heater))].sort((a, b) => (a === "extruder" ? -1 : b === "extruder" ? 1 : a.localeCompare(b))); }
  render() {
    const runs = HeatSync.load(), hs = this.heaters();
    if (!hs.includes(this.heater)) this.heater = hs[0] || null;
    this.heaterBar.innerHTML = "";
    if (hs.length) {
      const tr = ToggleRow(hs, this.heater, (v) => { this.heater = v; this.sel = null; this.render(); }, (v) => (v === "heater_bed" ? "Bed" : prettify(v)));
      this.heaterBar.append(tr.el);
    }
    const mine = runs.filter((r) => r.heater === this.heater).reverse(); // newest first
    if (!this.sel || !mine.includes(this.sel)) this.sel = mine.find((r) => r.tau) || mine[0] || null;
    this.renderLeft(mine);
    this.renderRight();
  }
  devFor(heater) {
    if (heater === "extruder" || heater === "heater_bed" || /^extruder\d+$/.test(heater)) return heater;
    return this.p.tempDevices().find((d) => devName(d) === heater) || heater;
  }
  renderLeft(mine) {
    const L = this.left;
    L.innerHTML = "";
    if (!this.heater) {
      L.append(el("div", { class: "desc", style: { padding: "1em" } },
        "No heat-ups recorded yet.\n\nHeat a heater from cold (raise its target by 10 °C or more), let it reach temperature, then tap Read log. Klipper's log keeps about an hour."));
      return;
    }
    // model card
    const m = HeatSync.model(this.heater);
    const card = el("div", { class: "hs-card" });
    if (m) {
      const dev = this.devFor(this.heater), now = this.p.stat(dev, "temperature");
      card.append(el("div", { class: "title" }, `${this.heater === "heater_bed" ? "Bed" : prettify(this.heater)} ${m.custom ? "saved model (Model page)" : `model · ${m.n} run${m.n === 1 ? "" : "s"}`}`),
        el("div", { class: "hs-kv" },
          el("span", {}, "τ"), el("b", {}, `${m.tau.toFixed(0)} s`),
          el("span", {}, "Lag"), el("b", {}, `${m.lag.toFixed(1)} s`),
          el("span", {}, "T∞ full power"), el("b", {}, `${m.tinf.toFixed(0)} °C`),
          el("span", {}, "Peak rate"), el("b", {}, `${m.rmax.toFixed(2)} °C/s`)));
      const presets = Object.entries(Settings.get("preheat") || {});
      const key = this.heater === "heater_bed" ? "bed" : this.heater.startsWith("extruder") ? "extruder" : null;
      if (key && typeof now === "number") {
        const rows = presets.filter(([, o]) => typeof o[key] === "number" && o[key] > now).map(([name, o]) =>
          el("div", { class: "hs-pred" }, el("span", {}, `${name} ${o[key]}°`), el("b", {}, fmtSecs(HeatSync.predict(m, now, o[key])))));
        if (rows.length) card.append(el("div", { class: "desc" }, `Predicted from ${now.toFixed(0)}° now`), ...rows);
      }
      card.append(...this.syncRows());
    } else card.append(el("div", { class: "desc" }, "No time constant yet: needs a heat-up that ran at full power past its inflection point."));
    L.append(card);
    // the runs
    for (const r of mine) {
      const when = r.wall ? new Date(r.wall * 1000) : null;
      const row = el("div", { class: "hs-run" + (r === this.sel ? " sel" : ""), onclick: () => { this.sel = r; this.renderLeft(mine); this.renderRight(); } },
        el("div", { class: "title" }, `${r.T0.toFixed(0)}° → ${r.target}°`, el("span", { class: "desc" }, when ? `  ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toTimeString().slice(0, 5)}` : "")),
        el("div", { class: "desc" }, r.tau ? `τ ${r.tau.toFixed(0)} s · lag ${r.lag.toFixed(1)} s · ${r.tReach !== null ? "reached in " + fmtSecs(r.tReach) : "didn't reach"}` : r.note || "–"));
      L.append(row);
    }
  }
  /** Bed and extruder together: which to start first so both arrive at once, per preset. */
  syncRows() {
    const mb = HeatSync.model("heater_bed"), me = HeatSync.model("extruder");
    if (!mb || !me) return [];
    const tb = this.p.stat("heater_bed", "temperature"), te = this.p.stat("extruder", "temperature");
    if (typeof tb !== "number" || typeof te !== "number") return [];
    const rows = [];
    for (const [name, o] of Object.entries(Settings.get("preheat") || {})) {
      if (!(o.bed > tb && o.extruder > te)) continue;
      const b = HeatSync.predict(mb, tb, o.bed), e = HeatSync.predict(me, te, o.extruder);
      if (b === null || e === null) continue;
      const d = b - e;
      rows.push(el("div", { class: "hs-pred" }, el("span", {}, name),
        el("b", {}, Math.abs(d) < 3 ? "start together" : d > 0 ? `extruder ${fmtSecs(d)} after bed` : `bed ${fmtSecs(-d)} after extruder`)));
    }
    return rows.length ? [el("div", { class: "desc", style: { marginTop: ".4em" } }, "Heat in sync (both arrive together)"), ...rows] : [];
  }
  renderRight() {
    const r = this.sel;
    this.info.innerHTML = "";
    if (!r) { this.draw(null); return; }
    const f = (v, d, u) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(d)}${u}` : "–");
    const kv = [
      ["Time constant τ", r.tau ? `${f(r.tau, 0, " s")}${r.tauFit && r.tauRatio ? ` (fit ${f(r.tauFit, 0, "")}, −T′/T″ ${f(r.tauRatio, 0, "")})` : ""}` : "–"],
      ["Lag (tangent)", f(r.lag, 1, " s")], ["Inflection", `${fmtSecs(r.tInfl)} · peak ${f(r.rmax, 2, " °C/s")}`],
      ["T∞ full power", f(r.tinf, 0, " °C")], ["To target", r.tReach !== null ? fmtSecs(r.tReach) : "not reached"], ["Overshoot", f(r.overshoot, 1, " °C")],
    ];
    if (r.r2 !== undefined) kv.push(["Fit R²", f(r.r2, 3, "")]);
    this.info.append(el("div", { class: "hs-kv" }, ...kv.flatMap(([k, v]) => [el("span", {}, k), el("b", {}, v)])));
    if (r.note) this.info.append(el("div", { class: "desc" }, r.note));
    requestAnimationFrame(() => this.draw(r));
  }
  /** Temperature on top, T′ and T″ (each on its own scale) below, phases shaded.
      ov: a model curve {T, d1, d2} (1 s grid) drawn dashed over the real run. */
  draw(r, ov, canvas) {
    const c = canvas || this.canvas, box = c.getBoundingClientRect();
    if (box.width < 20 || box.height < 20) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = box.width * dpr; c.height = box.height * dpr;
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    const W = box.width, H = box.height, fs = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.7;
    const text = getComputedStyle(document.body).color;
    g.clearRect(0, 0, W, H);
    g.font = `${fs}px sans-serif`;
    if (!r) { g.fillStyle = text; g.textAlign = "center"; g.fillText("No heat-up selected", W / 2, H / 2); return; }
    // show the heat-up and a while after it, not half an hour of holding
    const full = r.T.length, keep = r.tReach !== null ? Math.min(full, Math.ceil(Math.max(120, r.tReach * 2.2) / r.step) + 1) : full;
    const T = r.T.slice(0, keep), n = T.length, step = r.step, dur = (n - 1) * step;
    const { d1, d2 } = HeatSync.derive(T.flatMap((v, i) => (i < n - 1 && step > 1 ? Array.from({ length: step }, (_, k) => v + ((T[i + 1] - v) * k) / step) : [v])));
    const gx = fs * 3.2, gw = W - gx - fs * 0.8, topH = H * 0.58, gy = fs * 0.6, gh = topH - gy - fs * 1.4, by = topH + fs * 0.4, bh = H - by - fs * 1.6;
    const X = (t) => gx + (gw * t) / Math.max(1, dur);
    // phases
    for (const [p, a, b] of r.phases || []) { if (a >= dur) continue; g.fillStyle = HS_PHASES[p][1]; g.fillRect(X(a), gy, Math.max(1, X(Math.min(b, dur)) - X(a)), H - gy - fs * 1.6); }
    // temperature
    const lo = Math.min(r.T0, ...T) - 2, hi = Math.max(r.target, ...T) + 2, Y = (v) => gy + gh - ((v - lo) / (hi - lo)) * gh;
    g.strokeStyle = "rgba(127,127,127,.35)"; g.lineWidth = 1; g.fillStyle = text; g.textAlign = "right"; g.textBaseline = "middle";
    for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4, y = Y(v); g.beginPath(); g.moveTo(gx, y); g.lineTo(gx + gw, y); g.stroke(); g.fillText(v.toFixed(0), gx - 4, y); }
    g.setLineDash([6, 4]); g.strokeStyle = "#e53935"; g.beginPath(); g.moveTo(gx, Y(r.target)); g.lineTo(gx + gw, Y(r.target)); g.stroke(); g.setLineDash([]);
    g.strokeStyle = text; g.lineWidth = 2; g.beginPath();
    T.forEach((v, i) => (i ? g.lineTo(X(i * step), Y(v)) : g.moveTo(X(0), Y(v)))); g.stroke();
    if (ov) {
      g.strokeStyle = "#35d0e0"; g.lineWidth = 2; g.setLineDash([7, 4]); g.beginPath();
      for (let i = 0; i <= Math.min(dur, ov.T.length - 1); i++) { const y = Math.max(gy, Math.min(gy + gh, Y(ov.T[i]))); i ? g.lineTo(X(i), y) : g.moveTo(X(0), y); }
      g.stroke(); g.setLineDash([]);
    }
    // inflection
    g.strokeStyle = "rgba(255,255,255,.5)"; g.lineWidth = 1; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(X(r.tInfl), gy); g.lineTo(X(r.tInfl), H - fs * 1.6); g.stroke(); g.setLineDash([]);
    // derivatives, each scaled to fit, zero line shared
    const span = (a) => (a ? a.slice(0, dur + 1).map(Math.abs) : []);
    const m1 = Math.max(1e-6, ...d1.map(Math.abs), ...span(ov && ov.d1)), m2 = Math.max(1e-6, ...d2.map(Math.abs), ...span(ov && ov.d2));
    const Z = by + bh / 2;
    g.strokeStyle = "rgba(127,127,127,.5)"; g.beginPath(); g.moveTo(gx, Z); g.lineTo(gx + gw, Z); g.stroke();
    const plot = (d, mx, col) => { g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath(); d.forEach((v, i) => { const x = X(i), y = Z - (v / mx) * (bh / 2) * 0.95; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); };
    plot(d2, m2, "#b77cf0"); plot(d1, m1, "#f0a028");
    if (ov) {
      g.setLineDash([5, 4]);
      plot(ov.d2.slice(0, dur + 1), m2, "rgba(214,170,255,.95)"); plot(ov.d1.slice(0, dur + 1), m1, "rgba(255,214,140,.95)");
      g.setLineDash([]);
    }
    g.fillStyle = text; g.textAlign = "right"; g.fillText("0", gx - 4, Z);
    // time axis
    g.textAlign = "center"; g.textBaseline = "top";
    const tick = dur > 900 ? 300 : dur > 300 ? 60 : dur > 120 ? 30 : 10;
    for (let t = 0; t <= dur; t += tick) g.fillText(fmtSecs(t), X(t), H - fs * 1.4);
  }
};
