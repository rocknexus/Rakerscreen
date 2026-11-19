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
  MAX_PER_HEATER: 60,
  LOG_BYTES: 2 * 1024 * 1024, // about an hour of klippy.log

  // ------------------------------------------------------------ parsing
  /** klippy.log text -> [{name, samples:[{t, wall, target, temp, pwm}]}], split where Klipper restarted. */
  parse(text) {
    const series = {};
    let wall0 = null, mono0 = null, lastT = -Infinity, session = 0;
    const heat = /(\S+): target=(-?[\d.]+) temp=(-?[\d.]+) pwm=([\d.]+)/g;
    // a rotated log (klippy.log.2026-11-18) starts with "=== Log rollover at Tue Nov 18 00:00:00 2026 ===" instead of
    // Klipper's start line: that local time, pinned to the next Stats line's clock, dates its heat-ups (to a second or so)
    let rollover = null;
    const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    for (const line of text.split("\n")) {
      const sp = line.match(/Start printer at .*\(([\d.]+) ([\d.]+)\)/);
      if (sp) { wall0 = parseFloat(sp[1]); mono0 = parseFloat(sp[2]); session++; lastT = -Infinity; rollover = null; continue; }
      const ro = line.match(/Log rollover at \w{3} (\w{3}) +(\d+) (\d+):(\d+):(\d+) (\d{4})/);
      if (ro && MON[ro[1]] !== undefined) { rollover = new Date(+ro[6], MON[ro[1]], +ro[2], +ro[3], +ro[4], +ro[5]).getTime() / 1000; continue; }
      const m = line.match(/^Stats ([\d.]+):/);
      if (!m) continue;
      const t = parseFloat(m[1]);
      if (t < lastT) { session++; wall0 = mono0 = null; } // restarted without a start line in view
      if (rollover !== null && wall0 === null) { wall0 = rollover; mono0 = t; }
      rollover = null;
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
    // where full power ends (Klipper backs off a few degrees short of the target); the fits stop there
    if (P.some((v) => v > 0)) r.tSat = endSat;
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
      // T′ against T over the same stretch: at full power T′ slopes down as T rises. A straight line
      // T′ = (T∞ − T)/τ gives τ (−1/slope) and T∞ (where it reaches 0) from T′ and T alone, no T″; a bend in it
      // is the loss curvature (see curveQ)
      const pp = this.phaseLine(idx.map((i) => Ts[i]), idx.map((i) => d1[i]));
      if (pp) {
        r.pp = pp;
        // the line is the steadiest estimate when it's clean
        if (pp.r2 >= 0.98 && pp.tau > 0 && pp.tinf > target) { r.tau = pp.tau; r.tinf = pp.tinf; r.tauFrom = "T′ vs T line"; }
      }
    } else r.note = reach >= 0 && reach - iMax < 8 ? "Reached target before the curve bent: no time constant" : "Not enough full-power data after the inflection";
    if (reach >= 0) r.overshoot = Math.max(...T.slice(reach)) - target;
    r.phases = [["lag", 0, i10], ["speedup", i10, iMax], ["approach", iMax, end]];
    if (reach >= 0 && reach < n - 1) r.phases.push(["hold", reach, n - 1]);
    return this.pack(r, T);
  },
  /** T′ (y) against T (x): straight-line fit y = b0 + b1·x -> {tau, tinf, r2}, and a quadratic y = c0 + c1·x + c2·x²
      whose bend gives the loss curvature: expanding around its zero T∞q, y = (T∞q − x)/τq + q·(T∞q − x)²
      (curv = q·τq·A, the extra rate at the start relative to the line). */
  phaseLine(x, y) {
    const n = x.length;
    if (n < 6) return null;
    const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    if (!(sxx > 0) || !(syy > 0)) return null;
    const b1 = sxy / sxx, b0 = my - b1 * mx;
    if (!(b1 < 0)) return null;
    const out = { tau: -1 / b1, tinf: -b0 / b1, r2: (sxy * sxy) / (sxx * syy) };
    const q = this.quadFit(x, y);
    if (q) {
      // its zero nearest the line's T∞, then the slope there
      const [c0, c1, c2] = q;
      let z = out.tinf;
      for (let k = 0; k < 30; k++) { const f = c0 + c1 * z + c2 * z * z, d = c1 + 2 * c2 * z; if (Math.abs(d) < 1e-12) break; z -= f / d; }
      const inv = -(c1 + 2 * c2 * z);
      if (inv > 0 && isFinite(z)) {
        const A = Math.max(1, z - Math.min(...x));
        out.tauQ = 1 / inv; out.tinfQ = z; out.q = c2; out.curv = c2 * out.tauQ * A;
      }
    }
    return out;
  },
  /** Least-squares y = c0 + c1·x + c2·x² (x centred and scaled for the solve). */
  quadFit(x, y) {
    const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n;
    const sc = Math.max(1e-9, Math.max(...x.map((v) => Math.abs(v - mx))));
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], V = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const u = (x[i] - mx) / sc, row = [1, u, u * u];
      for (let a = 0; a < 3; a++) { V[a] += row[a] * y[i]; for (let b = 0; b < 3; b++) M[a][b] += row[a] * row[b]; }
    }
    // Gaussian elimination
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]]; [V[c], V[p]] = [V[p], V[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 3; k++) M[r][k] -= f * M[c][k]; V[r] -= f * V[c]; }
    }
    const [a, b, c] = [V[0] / M[0][0], V[1] / M[1][1], V[2] / M[2][2]];
    // back to y = c0 + c1·x + c2·x²: u = (x − mx)/sc
    const c2 = c / (sc * sc), c1 = b / sc - 2 * c2 * mx, c0 = a - (b / sc) * mx + c2 * mx * mx;
    return [c0, c1, c2];
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
  record(text) { return this.addRuns(this.runsIn(text)); },
  /** A whole klippy log (current or rotated) cut down to what Heat Sync reads. In the app this is done natively while
      streaming, so a big day-long log never has to fit in the page; in a browser the full text is fetched. */
  HEAT_LOG_MAX: 12 * 1024 * 1024,
  fetchHeatLog(app, name) {
    const key = Settings.get("moonraker_api_key") || "";
    if (window.PSBridge && PSBridge.fetchLogHeat) {
      return new Promise((resolve, reject) => {
        const id = ++logReqId;
        const timer = setTimeout(() => { delete logWaiters[id]; reject(new Error("Timed out")); }, 300000);
        logWaiters[id] = (code, text) => {
          clearTimeout(timer);
          if (code === 200) resolve(text);
          else reject(new Error(code ? `Moonraker answered HTTP ${code}` : text || "Request failed"));
        };
        const host = String(Settings.get("moonraker_host") || "").trim().replace(/^\w+:\/\//, "").replace(/[/:].*$/, "");
        PSBridge.fetchLogHeat(id, host, parseInt(app.mr.port(), 10) || 7125, name, key, this.HEAT_LOG_MAX);
      });
    }
    return fetch(`${app.mr.httpBase()}/server/files/logs/${encodeURIComponent(name)}`, { headers: key ? { "X-Api-Key": key } : {}, cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(`Moonraker answered HTTP ${r.status}`); return r.text(); });
  },
  READ_LOGS: "heat_sync_logs_read", // {file name: modified time} of klippy logs already read
  /** Every heat-up in a log's text, analysed. */
  runsIn(text) {
    const runs = [];
    for (const s of this.parse(text)) for (const run of this.findRuns(s)) runs.push(this.analyze(run));
    return runs;
  },
  /** Add analysed heat-ups to the record (skipping ones already there). Returns {found, added}. */
  addRuns(runs) {
    const have = this.load(), ids = new Set(have.map((r) => r.id));
    const seen = new Set();
    const fresh = runs.filter((r) => !ids.has(r.id) && !seen.has(r.id) && seen.add(r.id));
    let all = [...have, ...fresh];
    // newest MAX_PER_HEATER per heater, oldest first (by wall time; undated ones count as oldest, in the order found)
    const by = {};
    for (const r of all) (by[r.heater] = by[r.heater] || []).push(r);
    const when = (r) => (r.wall ? r.wall : 0);
    all = Object.values(by).flatMap((list) => list.map((r, i) => [r, i]).sort((a, b) => when(a[0]) - when(b[0]) || a[1] - b[1]).map(([r]) => r).slice(-this.MAX_PER_HEATER));
    // what the new heat-ups changed in each heater's measured model, kept until the next read that adds some
    if (fresh.length) {
      const changes = {};
      for (const h of new Set(fresh.map((r) => r.heater))) {
        const before = this.measured(h, have), after = this.measured(h, all);
        changes[h] = { before, after, added: fresh.filter((r) => r.heater === h).length, at: Date.now() };
      }
      Settings.set(this.CHANGES, changes);
    }
    this.save(all);
    return { found: runs.length, added: fresh.length };
  },
  // ------------------------------------------------------------ Test heat: heat one heater now and record it live
  /* Sets the target, samples temperature/target/power from the printer status twice a second, stops TEST_HOLD
     seconds after reaching the target (to see the overshoot), then analyses it like a log heat-up and fits the
     two-lag model. Lives here, not in the panel, so it keeps going when you leave the page. */
  TEST_HOLD: 45,
  TEST_MAX: 1500,
  test: null,
  /** Devices with a settable target (extruders, bed, generic heaters). */
  heaterDevs(p) {
    return p.tempDevices().filter((d) => !d.startsWith("temperature_fan") && typeof p.stat(d, "target") === "number");
  },
  /** Klipper's log name for a device: extruder, heater_bed, or the generic heater's own name. */
  logName(dev) { return dev === "extruder" || dev === "heater_bed" || /^extruder\d+$/.test(dev) ? dev : devName(dev); },
  /** Why a test can't start on dev at target, or null. */
  testProblem(app, dev, target) {
    const p = app.printer, now = p.stat(dev, "temperature"), tgt = p.stat(dev, "target");
    if (this.test && this.test.state === "running") return "A test heat is already running";
    if (p.isPrinting()) return "Not while printing";
    if (!(target > 0)) return "Pick a target temperature";
    if (typeof now !== "number") return "No temperature from this heater";
    if (tgt > 0) return `It's heating to ${tgt.toFixed(0)}° now: turn it off first`;
    if (now > target - 15) return `It needs to start at least 15° below the target: it's ${now.toFixed(0)}° now. Let it cool first`;
    return null;
  },
  startTest(app, dev, target, off) {
    const p = app.printer, t0 = performance.now() / 1000;
    const T = { app, dev, heater: this.logName(dev), target, off, samples: [], state: "running", started: t0, wall0: Date.now() / 1000,
      setAt: t0 + 3, set: false, note: "" };
    T.take = () => {
      const now = performance.now() / 1000;
      T.samples.push({ t: now - t0 + 1, wall: T.wall0 + (now - t0), target: Number(p.stat(dev, "target")) || 0,
        temp: Number(p.stat(dev, "temperature")), pwm: Number(p.stat(dev, "power")) || 0 });
    };
    T.take();
    T.timer = setInterval(() => this.testTick(T), 500);
    this.test = T;
    return T;
  },
  testTick(T) {
    T.take();
    const now = performance.now() / 1000;
    // a few seconds at the starting temperature first, then the target
    if (!T.set && now >= T.setAt) {
      T.set = true;
      if (!T.app.setTargetTemp(T.dev, T.target)) { this.endTest(T, "error", "Couldn't set the target"); return; }
    }
    if (T.set) {
      const last = T.samples[T.samples.length - 1];
      if (now - T.setAt > 6 && Math.abs(last.target - T.target) > 0.5) { this.endTest(T, "aborted", "Stopped: the target was changed outside the test"); return; }
      if (T.reachedAt === undefined && last.temp >= T.target - 1) T.reachedAt = now;
      if (T.reachedAt !== undefined && now - T.reachedAt >= this.TEST_HOLD) { this.endTest(T, "done"); return; }
      if (now - T.setAt > this.TEST_MAX) { this.endTest(T, "done", "Stopped after 25 minutes without reaching the target"); return; }
    }
    if (T.onTick) T.onTick(T);
  },
  /** The heat-up so far as a run for analyze(): from the sample just before the target took effect. */
  testRun(T) {
    const k = T.samples.findIndex((s) => Math.abs(s.target - T.target) < 0.5);
    if (k < 1) return null;
    const samples = T.samples.slice(k - 1).filter((s, i) => i === 0 || Math.abs(s.target - T.target) < 0.5);
    if (samples.length < 3 || samples[samples.length - 1].t - samples[1].t < 10) return null;
    return { name: T.heater, samples };
  },
  /** done: analyse, fit and record it. cancelled / error: heater off. aborted (someone else set a target): left alone. */
  endTest(T, state, note) {
    clearInterval(T.timer);
    T.state = state;
    if (note) T.note = note;
    if (T.set && ((state === "done" && T.off) || state === "cancelled" || state === "error")) T.app.setTargetTemp(T.dev, 0);
    if (state === "done") {
      const run = this.testRun(T);
      if (run) {
        const r = this.analyze(run);
        r.test = true;
        r.id = "test|" + r.id;
        T.result = r;
        T.fit = this.fit(r);
        this.addRuns([r]);
      } else { T.state = "error"; T.note = "Not enough was recorded to measure anything"; }
    }
    if (T.onEnd) T.onEnd(T);
  },
  cancelTest() { if (this.test && this.test.state === "running") this.endTest(this.test, "cancelled", "Cancelled"); },

  CHANGES: "heat_sync_changes",
  changes(heater) { return (Settings.get(this.CHANGES) || {})[heater] || null; },
  /** Heaters whose measured model is the two-lag one (median of each run's two-lag fit): the bed, whose thermistor
      sits under a thick plate and lags far behind the heater. Others use medians of the measured τ, lag and T∞. */
  TWO_LAG: ["heater_bed"],
  /** A run's two-lag fit (with loss curvature when the data show it), worked out once and kept with the run. */
  runFit(r) {
    if (r.fit2 === undefined) {
      const f = r.tau > 0 ? this.fit(r) : null;
      r.fit2 = f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === "q" ? v : Math.round(v * 1000) / 1000])) : null;
    }
    return r.fit2;
  },
  /** Medians over a heater's recorded runs (the measured model), or null without a time constant yet. */
  measured(heater, list) {
    const stored = !list;
    if (!list) list = this.load();
    const runs = list.filter((r) => r.heater === heater && r.tau > 0 && r.tinf);
    if (!runs.length) return null;
    const med = (k, from = runs) => this.median(from.map((r) => r[k]).filter((v) => typeof v === "number"));
    if (this.TWO_LAG.includes(heater)) {
      const missing = runs.some((r) => r.fit2 === undefined);
      const fits = runs.map((r) => this.runFit(r)).filter(Boolean);
      if (missing && stored) this.save(list); // keep the new fits
      if (fits.length) {
        const m = { n: fits.length, two: true, lag: med("lag", fits), tinf: med("tinf", fits), tau: med("tau", fits), taus: med("taus", fits), rmax: med("rmax") };
        // curvature only when most of the fits needed it
        const qs = fits.map((f) => f.q || 0);
        if (qs.filter((q) => q).length * 2 > qs.length) m.q = this.median(qs);
        return m;
      }
    }
    return { n: runs.length, tau: med("tau"), lag: med("lag") || 0, tinf: med("tinf"), rmax: med("rmax") };
  },
  /** The heater's model: a saved one (Model page) if there is one, else the measured one. */
  model(heater) {
    const custom = (Settings.get(this.CUSTOM) || {})[heater];
    if (custom) return { ...custom, n: 0, custom: true, rmax: this.toVA(custom, custom.tinf - 23).v };
    return this.measured(heater);
  },

  /** heat_sync.cfg for Klipper: the models as macro variables and HEAT_SYNC BED= EXTRUDER= [WAIT=1], which starts
      the slower heater first and the other after the difference, so both reach their targets together.
      Time to target in the macro is the two-lag curve's long-run form, L + τ·ln(τ/(τ−τs)) + τ·ln(x0·(1+qτ·x1) / (x1·(1+qτ·x0)))
      with x = T∞ − T (q, the loss curvature, is 0 for a straight T′ line), within a second or two of the app's prediction.
      x0 is from the heater's start, T0 + κ·(T0 − room): a bed still warm from a print gets there sooner. */
  cfg() {
    const mb = this.model("heater_bed"), me = this.model("extruder");
    if (!mb || !me) return null;
    const n = (v, d) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "0");
    const src = (m) => (m.custom ? "saved model (Model page)" : `measured, median of ${m.n} heat-up${m.n === 1 ? "" : "s"}`);
    const vars = (p, m) => [`variable_${p}_lag: ${n(m.lag, 1)}`, `variable_${p}_tau: ${n(m.tau, 1)}`, `variable_${p}_taus: ${n(m.taus || 0, 2)}`, `variable_${p}_tinf: ${n(m.tinf, 1)}`,
      `variable_${p}_q: ${m.q ? String(Number(m.q.toPrecision(4))) : "0"}`,
      `variable_${p}_kappa: ${n(m.kappa || 0, 3)}`, `variable_${p}_room: ${n(m.tamb !== undefined ? m.tamb : 25, 1)}`];
    return [
      "# heat_sync.cfg, written by Rakerscreen (Settings → Heat Sync → Export) on " + (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toTimeString().slice(0, 5)}`; })(),
      "# Export rewrites this file: change the model in the app, not here.",
      "# Load it from printer.cfg with  [include heat_sync.cfg]",
      `#   bed:      ${src(mb)}`,
      `#   extruder: ${src(me)}`,
      "#",
      "# HEAT_SYNC BED=60 EXTRUDER=210 [WAIT=1]",
      "#   Starts the heater that needs longer first, then the other, so both arrive together.",
      "#   WAIT=1 (default) also waits for both (M190, M109); WAIT=0 returns once both are on.",
      "#   It dwells (G4) between the two, so nothing else runs meanwhile: use it in a start macro.",
      "",
      "[gcode_macro HEAT_SYNC]",
      "description: Heat bed and extruder so both reach temperature at the same time",
      ...vars("bed", mb),
      ...vars("extruder", me),
      "gcode:",
      "  {% macro ln(x) -%}",
      "    {%- set ns = namespace(x=x, k=0, s=0.0) -%}",
      "    {%- for i in range(40) -%}{%- if ns.x > 1.5 -%}{%- set ns.x = ns.x / 2.718281828459045 -%}{%- set ns.k = ns.k + 1 -%}{%- endif -%}{%- endfor -%}",
      "    {%- set y = (ns.x - 1) / (ns.x + 1) -%}",
      "    {%- for i in range(12) -%}{%- set ns.s = ns.s + y ** (2 * i + 1) / (2 * i + 1) -%}{%- endfor -%}",
      "    { ns.k + 2 * ns.s }",
      "  {%- endmacro %}",
      "  {% macro secs(l, tau, taus, tinf, q, k, room, s0, t) -%}",
      "    {%- set t0 = [s0 + k * ([s0 - room, 0]|max), tinf - 0.5]|min -%}",
      "    {%- if t <= s0 -%}0{%- elif t >= tinf - 0.5 -%}-1",
      "    {%- else -%}{ [0, l + tau * (ln(tau * (tinf - t0) * (1 + q * tau * (tinf - t)) / ((tau - taus) * (tinf - t) * (1 + q * tau * (tinf - t0))))|float)]|max }{%- endif -%}",
      "  {%- endmacro %}",
      "  {% set v = printer[\"gcode_macro HEAT_SYNC\"] %}",
      "  {% set bed = params.BED|default(0)|float %}",
      "  {% set ext = params.EXTRUDER|default(0)|float %}",
      "  {% set wait = params.WAIT|default(1)|int %}",
      "  {% set tb = secs(v.bed_lag, v.bed_tau, v.bed_taus, v.bed_tinf, v.bed_q, v.bed_kappa, v.bed_room, printer.heater_bed.temperature, bed)|float %}",
      "  {% set te = secs(v.extruder_lag, v.extruder_tau, v.extruder_taus, v.extruder_tinf, v.extruder_q, v.extruder_kappa, v.extruder_room, printer.extruder.temperature, ext)|float %}",
      "  {% if tb < 0 or te < 0 %}",
      "    RESPOND TYPE=error MSG=\"HEAT_SYNC: a target is at or above that heater's full-power ceiling, heating both now\"",
      "    M140 S{bed}",
      "    M104 S{ext}",
      "  {% elif tb >= te %}",
      "    RESPOND MSG=\"HEAT_SYNC: bed first, extruder in {(tb - te)|round(0)|int} s (about {tb|round(0)|int} s to target)\"",
      "    M140 S{bed}",
      "    {% if tb - te >= 1 %}G4 P{((tb - te) * 1000)|round(0)|int}{% endif %}",
      "    M104 S{ext}",
      "  {% else %}",
      "    RESPOND MSG=\"HEAT_SYNC: extruder first, bed in {(te - tb)|round(0)|int} s (about {te|round(0)|int} s to target)\"",
      "    M104 S{ext}",
      "    {% if te - tb >= 1 %}G4 P{((te - tb) * 1000)|round(0)|int}{% endif %}",
      "    M140 S{bed}",
      "  {% endif %}",
      "  {% if wait %}",
      "    {% if bed > 0 %}M190 S{bed}{% endif %}",
      "    {% if ext > 0 %}M109 S{ext}{% endif %}",
      "  {% endif %}",
      "",
    ].join("\n");
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
       T″ = A·(e^(−u/τs)/τs − e^(−u/τ)/τ) / (τ − τs)           peak (acceleration, at u = 0) a = A/(τ·τs)
     Loss curvature q: at full power T′ falls as the heater gets hotter. A straight line, T′ = (T∞ − T)/τ, is the
     model above; when that line bends (losses growing faster than linearly, e.g. radiation off a hot bed) the heater
     follows h′ = (T∞ − h)/τ + q·(T∞ − h)², the sensor s′ = (h − s)/τs, stepped numerically. q = 0 is the formula above. */
  CUSTOM: "heat_sync_models",
  /** Where the heater starts: h0 given, else from the model's warm-start factor (a bed still warm from a print has its
      plate and heater ahead of the thermistor: h0 − T0 = κ·(T0 − room)), else at the sensor's temperature. */
  h0For(p, T0, h0) {
    if (typeof h0 === "number") return h0;
    if (p.kappa) return Math.min(p.tinf - 0.5, T0 + p.kappa * Math.max(0, T0 - (p.tamb !== undefined ? p.tamb : 25)));
    return T0;
  },
  /** Model curve on a 1 s grid; once it reaches the target it holds there (an ideal PID).
      h0: the heater's temperature at the start (default: see h0For). During a positive lag the heater is held there
      and the sensor settles towards it; then full power. */
  curve(p, T0, target, n, h0) {
    h0 = this.h0For(p, T0, h0);
    if (p.q) return this.curveQ(p, T0, target, n, h0);
    const T = new Array(n), d1 = new Array(n), d2 = new Array(n);
    const tau = Math.max(1, p.tau), Tinf = p.tinf, L = p.lag;
    const ts = Math.min(Math.max(0.2, p.taus || 0), tau * 0.995);
    // at the end of the lag: heater h0, sensor sL; after it h = T∞ − (T∞ − h0)·e^(−u/τ), s = T∞ − B·e^(−u/τ) + C·e^(−u/τs)
    const sL = L > 0 ? h0 + (T0 - h0) * Math.exp(-L / ts) : T0;
    const B = ((Tinf - h0) * tau) / (tau - ts), C = sL - Tinf + B;
    let held = false;
    for (let i = 0; i < n; i++) {
      if (held) { T[i] = target; d1[i] = 0; d2[i] = 0; continue; }
      if (L > 0 && i <= L) {
        const e = Math.exp(-i / ts);
        T[i] = h0 + (T0 - h0) * e; d1[i] = ((h0 - T0) * e) / ts; d2[i] = -d1[i] / ts;
      } else {
        const u = i - L, e1 = Math.exp(-u / tau), e2 = Math.exp(-u / ts);
        T[i] = Tinf - B * e1 + C * e2;
        d1[i] = (B / tau) * e1 - (C / ts) * e2;
        d2[i] = -(B / (tau * tau)) * e1 + (C / (ts * ts)) * e2;
      }
      if (T[i] >= target) { T[i] = target; held = true; }
    }
    return { T, d1, d2 };
  },
  /** The same with loss curvature q: heater and sensor stepped (midpoint method, 0.1 s steps). */
  curveQ(p, T0, target, n, h0) {
    h0 = this.h0For(p, T0, h0);
    const T = new Array(n), d1 = new Array(n), d2 = new Array(n);
    const tau = Math.max(1, p.tau), ts = Math.min(Math.max(0.2, p.taus || 0), tau * 0.995), q = p.q || 0, tinf = p.tinf, L = p.lag;
    const rate = (h) => { const x = Math.max(0, tinf - h); return x / tau + q * x * x; };
    const sub = p.sub || 10; // steps per second (fewer while a fit searches)
    let h = h0, s = T0, held = false;
    for (let i = 0; i < n; i++) {
      // from the previous second (at i = 0: from a negative lag) up to this one; power on after the lag
      const from = i === 0 ? Math.min(0, L) : i - 1;
      if (!held && i > from) {
        const steps = Math.max(1, Math.round((i - from) * sub)), d = (i - from) / steps;
        for (let k = 0; k < steps; k++) {
          const on = from + (k + 0.5) * d > L;
          const a1 = on ? rate(h) : 0, b1 = (h - s) / ts;
          const hm = h + 0.5 * d * a1, sm = s + 0.5 * d * b1;
          h += d * (on ? rate(hm) : 0);
          s += (d * (hm - sm)) / ts;
        }
      }
      if (held) { T[i] = target; d1[i] = 0; d2[i] = 0; continue; }
      T[i] = s;
      d1[i] = (h - s) / ts;
      d2[i] = ((i > L ? rate(h) : 0) - d1[i]) / ts;
      if (T[i] >= target) { T[i] = target; held = true; }
    }
    return { T, d1, d2 };
  },
  /** τ, τs (and q) -> peak velocity and acceleration for a rise of A. */
  toVA(p, A) {
    if (p.q) {
      // peak T″ is at the start: the heater's starting rate seen through the sensor lag; peak T′ from the curve
      const c = this.curveQ(p, p.tinf - A, Infinity, Math.ceil(p.lag + Math.min(4 * p.tau, 6 * (p.taus || 1) + 60)));
      const x = A;
      return { v: Math.max(...c.d1), a: (x / p.tau + p.q * x * x) / p.taus };
    }
    const r = Math.min(0.995, Math.max(1e-4, p.taus / p.tau));
    return { v: (A / p.tau) * Math.pow(r, r / (1 - r)), a: A / (p.tau * p.taus) };
  },
  /** Loss curvature as "extra rate at the start": q·τ·A (0: a straight T′ line), for a rise of A. */
  curvOf(p, A) { return p && p.q ? p.q * p.tau * A : 0; },
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
  /** Nelder–Mead minimum of cost from x0 (steps: the first simplex), at most iters rounds. -> {x, f} */
  nelder(cost, x0, steps, iters) {
    const D = x0.length;
    let simplex = [x0];
    for (let k = 0; k < D; k++) { const x = x0.slice(); x[k] += steps[k]; simplex.push(x); }
    let f = simplex.map(cost);
    for (let it = 0; it < iters; it++) {
      const ord = f.map((v, i) => i).sort((a, b) => f[a] - f[b]);
      simplex = ord.map((i) => simplex[i]); f = ord.map((i) => f[i]);
      if (f[D] - f[0] < 1e-6 * (1 + f[0])) break;
      const c = x0.map((_, k) => simplex.slice(0, D).reduce((s, x) => s + x[k], 0) / D);
      const pt = (t) => c.map((v, k) => v + t * (simplex[D][k] - v));
      const xr = pt(-1), fr = cost(xr);
      if (fr < f[0]) { const xe = pt(-2), fe = cost(xe); [simplex[D], f[D]] = fe < fr ? [xe, fe] : [xr, fr]; }
      else if (fr < f[D - 1]) { simplex[D] = xr; f[D] = fr; }
      else {
        const xc = pt(fr < f[D] ? -0.5 : 0.5), fc = cost(xc);
        if (fc < Math.min(fr, f[D])) { simplex[D] = xc; f[D] = fc; }
        else for (let i = 1; i <= D; i++) { simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k])); f[i] = cost(simplex[i]); }
      }
    }
    return { x: simplex[0], f: f[0] };
  },
  /** Least squares over the heat-up (up to the target): the two-lag model on L, T∞, ln τ, ln τs (Nelder–Mead).
      With curv, then a second pass that adds the loss curvature c = q·τ·A starting from that fit; it's kept only
      when it fits clearly better (RMS down by 15 % or more), since a heat-up that stops at its target rarely
      shows enough of the bend to pin it down. */
  fit(r, curv = true) {
    const T = this.realCurve(r), n = this.fitLen(r, T.length);
    if (n < 15) return null;
    const T0 = r.T0, target = r.target;
    const sse = (p) => {
      const c = this.curve(p, T0, Infinity, n);
      let s = 0;
      for (let i = 0; i < n; i++) { const d = c.T[i] - T[i]; s += d * d; }
      return s;
    };
    // the log shows a new target up to a second after it was set: the heat-up may start a little before t = 0
    const base = (x) => ({ lag: Math.max(-2, x[0]), tinf: x[1], tau: Math.exp(x[2]), taus: Math.exp(x[3]) });
    const bad = (p) => p.taus >= p.tau * 0.99 || p.tinf <= target + 0.5;
    // start from the T′-vs-T line when it's clean: its slope and zero are τ and T∞
    const pp = r.pp && r.pp.r2 >= 0.95 ? r.pp : {};
    const tau0 = pp.tau || r.tau || Math.max(20, (r.tReach || n) / 1.5), tinf0 = pp.tinf || r.tinf || target + 60;
    const a = this.nelder((x) => { const p = base(x); return bad(p) ? 1e12 : sse(p); },
      [r.lag || 2, tinf0, Math.log(tau0), Math.log(Math.max(1, tau0 * 0.08))], [2, 15, 0.3, 0.5], 600);
    const p4 = base(a.x), rms4 = Math.sqrt(a.f / n);
    if (!curv) return { ...p4, rms: rms4 };
    const withQ = (x) => { const p = base(x); p.q = x[4] / (p.tau * Math.max(1, p.tinf - T0)); return p; };
    const b = this.nelder((x) => { const p = withQ(x); return bad(p) || x[4] <= -0.9 || x[4] > 4 ? 1e12 : sse(p); },
      [...a.x, pp.curv && Math.abs(pp.curv) < 1 ? pp.curv : 0], [0.5, 5, 0.1, 0.2, 0.2], 500);
    const rms5 = Math.sqrt(b.f / n);
    if (rms5 <= rms4 * 0.85 && Math.abs(b.x[4]) >= 0.01) return { ...withQ(b.x), rms: rms5 };
    return { ...p4, rms: rms4 };
  },
  /** One model for many runs: the constants (lag, T∞, τ, τs, and loss curvature if it helps) that fit all of them
      at once, each run counting the same, so the model varies as little as possible from run to run.
      Each run also gets its own start state: d, how far the heater is ahead of the sensor when the heat-up starts
      (a bed still warm from a print isn't at rest), and a time shift of up to ±1.5 s (the log shows a new target up to
      a second late). Then κ: how d grows with the start temperature, d ≈ κ·(T0 − room), which lets the model predict
      heat-ups from a warm start. Alternates: each run's start with the constants held, then the constants with the
      starts held. onProgress(text) between rounds; resolves with null if fewer than 2 runs can be used. */
  async fitMany(runs, onProgress = () => {}, curv = true) {
    const yieldUI = () => new Promise((res) => setTimeout(res, 0));
    const data = runs.map((r) => { const T = this.realCurve(r); return { r, T, n: this.fitLen(r, T.length), d: 0, sh: 0 }; })
      .filter((x) => x.n >= 15 && x.r.target - x.r.T0 >= 10);
    if (data.length < 2) return null;
    const T0s = data.map((x) => x.r.T0), tamb = Math.min(...T0s) < 35 ? Math.min(...T0s) : 25;
    const sse = (p, x, d = x.d, sh = x.sh) => {
      const q = { ...p, lag: p.lag + sh };
      const c = this.curve(q, x.r.T0, Infinity, x.n, x.r.T0 + d);
      let s = 0;
      for (let i = 0; i < x.n; i++) { const e = c.T[i] - x.T[i]; s += e * e; }
      return s / x.n;
    };
    const total = (p) => data.reduce((s, x) => s + sse(p, x), 0) / data.length;
    const shared = (v) => ({ lag: v[0], tinf: v[1], tau: Math.exp(v[2]), taus: Math.exp(v[3]) });
    // start from the median of the cold runs' own fits (all runs' if none started cold)
    const cold = data.filter((x) => x.r.T0 - tamb < 8);
    const own = (cold.length ? cold : data).map((x) => this.fit(x.r, false)).filter(Boolean);
    const med = (k) => this.median(own.map((f) => f[k]));
    let p = own.length ? { lag: med("lag"), tinf: med("tinf"), tau: med("tau"), taus: med("taus") } : { lag: 1, tinf: Math.max(...data.map((x) => x.r.target)) + 60, tau: 150, taus: 10 };
    const maxTarget = Math.max(...data.map((x) => x.r.target));
    const badShared = (q) => !(q.taus < q.tau * 0.99) || q.tinf <= maxTarget + 0.5 || q.lag < -2 || q.lag > 60;
    for (let round = 0; round < 4; round++) {
      onProgress(`Fitting ${data.length} runs: round ${round + 1} of 4…`);
      await yieldUI();
      // each run's start (heater ahead of the sensor by d, time shift sh), constants held
      for (const x of data) {
        const span = Math.max(5, p.tinf - x.r.T0 - 1);
        const b = this.nelder((v) => (Math.abs(v[1]) > 1.5 || v[0] < -span || v[0] > span ? 1e12 : sse(p, x, v[0], v[1])), [x.d, x.sh], [3, 0.5], 120);
        x.d = b.x[0]; x.sh = b.x[1];
      }
      await yieldUI();
      // the constants, starts held
      const a = this.nelder((v) => { const q = shared(v); return badShared(q) ? 1e12 : total(q); },
        [p.lag, p.tinf, Math.log(p.tau), Math.log(p.taus)], [1, 8, 0.15, 0.3], 400);
      p = shared(a.x);
    }
    let err = total(p);
    // loss curvature: the same alternation with the curvature added (searching at 3 steps a second), kept only if it
    // fits clearly better (RMS down 15 % or more) at full resolution; otherwise the runs' starts go back as they were
    if (curv) {
      const A = Math.max(1, p.tinf - tamb);
      const withQ = (v, sub) => ({ ...shared(v), q: v[4] / (Math.exp(v[2]) * A), sub });
      const keep = data.map((x) => [x.d, x.sh]);
      let v5 = [p.lag, p.tinf, Math.log(p.tau), Math.log(p.taus), 0];
      for (let round = 0; round < 3; round++) {
        onProgress(`Fitting ${data.length} runs: trying loss curvature (${round + 1} of 3)…`);
        await yieldUI();
        v5 = this.nelder((v) => { const q = withQ(v, 3); return badShared(q) || v[4] <= -0.9 || v[4] > 4 ? 1e12 : total(q); },
          v5, [0.5, 5, 0.1, 0.2, 0.3], 250).x;
        const pq3 = withQ(v5, 3);
        for (const x of data) {
          const span = Math.max(5, pq3.tinf - x.r.T0 - 1);
          const b = this.nelder((v) => (Math.abs(v[1]) > 1.5 || v[0] < -span || v[0] > span ? 1e12 : sse(pq3, x, v[0], v[1])), [x.d, x.sh], [3, 0.5], 80);
          x.d = b.x[0]; x.sh = b.x[1];
        }
      }
      const pq = withQ(v5), eq = total(pq);
      delete pq.sub;
      if (eq <= err * 0.85 * 0.85 && Math.abs(v5[4]) >= 0.01) { p = pq; err = eq; }
      else data.forEach((x, i) => { [x.d, x.sh] = keep[i]; });
    }
    // κ: the start offsets against how warm each run started (through 0: a run from room temperature starts at rest)
    let sxx = 0, sxy = 0, warm = 0;
    for (const x of data) { const w = x.r.T0 - tamb; if (w >= 5) warm++; sxx += w * w; sxy += w * x.d; }
    const kappa = warm && sxx > 0 ? sxy / sxx : 0;
    const out = { ...p, rms: Math.sqrt(err), n: data.length, tamb: Math.round(tamb * 10) / 10 };
    if (Math.abs(kappa) >= 0.01) out.kappa = Math.round(kappa * 1000) / 1000;
    out.perRun = data.map((x) => {
      const q = { ...p, lag: p.lag + x.sh };
      // to 1° short of the target, the way a real run counts as having reached it
      const c = this.curve(q, x.r.T0, Infinity, Math.max(x.T.length, 3600), x.r.T0 + x.d), reach = c.T.findIndex((v) => v >= x.r.target - 1);
      return { id: x.r.id, T0: x.r.T0, target: x.r.target, d: x.d, sh: x.sh, rms: Math.sqrt(sse(p, x)), reach: reach >= 0 ? reach : null, real: x.r.tReach };
    });
    return out;
  },
  /** How much of a run the fits use: up to the target, and only while the heater ran at full power. */
  fitLen(r, len) {
    let n = Math.min(len, (r.tReach !== null && r.tReach !== undefined ? r.tReach : len - 1) + 1);
    if (typeof r.tSat === "number" && r.tSat >= 14) n = Math.min(n, r.tSat + 1);
    return n;
  },
  /** RMS error (°C) of a model against the real heat-up (the stretch the fits use). */
  rms(p, r) {
    const T = this.realCurve(r), n = this.fitLen(r, T.length);
    const c = this.curve(p, r.T0, Infinity, n);
    let s = 0;
    for (let i = 0; i < n; i++) s += (c.T[i] - T[i]) ** 2;
    return Math.sqrt(s / n);
  },
  saveCustom(heater, p) {
    const all = { ...(Settings.get(this.CUSTOM) || {}) };
    if (p) {
      all[heater] = { lag: p.lag, tinf: p.tinf, tau: p.tau, taus: p.taus };
      if (p.q) all[heater].q = p.q;
      if (p.kappa) { all[heater].kappa = p.kappa; all[heater].tamb = p.tamb !== undefined ? p.tamb : 25; }
    } else delete all[heater];
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
    const read = Button("refresh", "Read log", "color1", { side: true, lines: 1, onclick: (e, b) => this.readDialog(b) });
    const test = Button("heat-up", "Test heat", "color2", { side: true, lines: 1, onclick: () => (HeatSync.test && HeatSync.test.state === "running" ? this.openTest() : this.testDialog()) });
    const clear = Button("delete", "Clear", "color2", { side: true, lines: 1, onclick: () => this.app.dialog("Clear Heat Sync", [
      { name: "Clear", style: "dialog-error", cb: () => { HeatSync.save([]); Settings.set(HeatSync.CHANGES, {}); this.sel = null; this.render(); } },
      { name: "Cancel", style: "dialog-default" }], "Forget every recorded heat-up?") });
    this.left = el("div", { class: "hs-left scroll" });
    this.canvas = el("canvas", { class: "hs-chart" });
    this.info = el("div", { class: "hs-info" });
    this.legend = this.legendEl(() => this.renderRight());
    this.right = el("div", { class: "hs-right" }, this.legend, this.canvas, this.info);
    this.body = el("div", { class: "hs-body fill" }, this.left, this.right);
    const model = Button("fine-tune", "Model", "color3", { side: true, lines: 1, onclick: () => this.openModel() });
    const exp = Button("file", "Export", "color4", { side: true, lines: 1, onclick: (e, b) => this.exportCfg(b) });
    this.main = el("div", { class: "fill", style: { display: "flex", flexDirection: "column", minHeight: 0 } },
      el("div", { class: "hs-top" }, this.heaterBar, test, model, exp, read, clear), this.body, el("div", { class: "hs-foot" }, this.status));
    this.el.append(this.main);
  }

  // ------------------------------------------------------------ Export: heat_sync.cfg next to printer.cfg
  exportCfg(btn) {
    const text = HeatSync.cfg();
    if (!text) { this.app.popup("Export needs both a bed and an extruder model: record a heat-up of each first", 2); return; }
    const body = el("div", {},
      el("div", {}, "Writes heat_sync.cfg in the printer's config folder, next to printer.cfg (replacing the old one), with both heater models and a HEAT_SYNC macro:"),
      el("pre", { class: "hs-cfg scroll" }, text));
    this.app.dialog("Export to printer", [
      { name: "Export", style: "dialog-primary", cb: () => this.doExport(text, btn) },
      { name: "Cancel", style: "dialog-default" }], body);
  }
  async doExport(text, btn) {
    if (btn) btn.busy(true);
    this.status.textContent = "Writing heat_sync.cfg…";
    try {
      await moonrakerConfigFile(this.app, "heat_sync.cfg", text);
      this.status.textContent = `heat_sync.cfg written · ${new Date().toTimeString().slice(0, 5)}`;
      // already loaded (included from printer.cfg or another file): only a restart is needed
      let included = (this.p.macros || []).some((m) => m.toUpperCase() === "HEAT_SYNC");
      let cfg = null;
      if (!included) {
        cfg = await moonrakerConfigFile(this.app, "printer.cfg");
        included = typeof cfg === "string" && /^\s*\[include\s+[^\]]*heat_sync[^\]]*\]/im.test(cfg);
      }
      const restart = () => this.app.mr.call("printer.restart").then(() => this.app.popup("Klipper restarting", 1)).catch((e) => this.app.popup(`Restart failed: ${e.message || e}`, 2));
      if (included) {
        this.app.dialog("heat_sync.cfg written", [
          { name: "Restart Klipper", style: "dialog-primary", cb: restart },
          { name: "Later", style: "dialog-default" }],
          "printer.cfg already includes it. Restart Klipper to load the new models?\n\nA running print is stopped.");
        return;
      }
      if (typeof cfg !== "string") { this.app.dialog("heat_sync.cfg written", [{ name: "OK", style: "dialog-default" }], "Couldn't find printer.cfg to add the include. Add this line to your printer config:\n\n[include heat_sync.cfg]"); return; }
      const add = async (andRestart) => {
        try {
          await moonrakerConfigFile(this.app, "printer.cfg", `[include heat_sync.cfg]\n${cfg}`);
          this.status.textContent = `heat_sync.cfg written · included from printer.cfg · ${new Date().toTimeString().slice(0, 5)}`;
          if (andRestart) restart();
        } catch (e) { this.status.textContent = `Couldn't update printer.cfg: ${e.message}`; }
      };
      this.app.dialog("Include it in printer.cfg?", [
        { name: "Add + restart", style: "dialog-primary", cb: () => add(true) },
        { name: "Add only", style: "dialog-default", cb: () => add(false) },
        { name: "Not now", style: "dialog-default" }],
        "Klipper only reads heat_sync.cfg when printer.cfg includes it. Add this line at the top of printer.cfg?\n\n[include heat_sync.cfg]\n\nThe rest of printer.cfg stays as it is. Restarting Klipper stops a running print.");
    } catch (e) {
      this.status.textContent = `Couldn't write heat_sync.cfg: ${e.message}`;
    } finally { if (btn) btn.busy(false); }
  }

  // ------------------------------------------------------------ Model page: edit the model, see it over the real run
  /** run: open on this run (default: the one picked on the main page). */
  openModel(run) {
    const r = run || this.sel;
    if (!r) { this.app.popup("Pick a heat-up first", 1); return; }
    this.mRun = r;
    this.mp = this.startModel(r);
    this.main.style.display = "none";
    if (!this.mView) { this.mView = el("div", { class: "fill hs-model" }); this.el.append(this.mView); }
    this.renderModel();
    this.app.updateActionBar();
  }
  /** Where the Model page starts for a run: the heater's saved model, else a fit to the run, else its own numbers. */
  startModel(r) {
    const saved = (Settings.get(HeatSync.CUSTOM) || {})[r.heater];
    if (saved) { this.mNote = "Saved model"; return { ...saved }; }
    this.mNote = "Fitted to this run";
    return HeatSync.fit(r) || { lag: r.lag || 2, tinf: r.tinf || r.target + 60, tau: r.tau || 60, taus: Math.max(1, (r.tau || 60) * 0.08) };
  }
  /** Pick which recorded run the model is drawn over: one heater at a time (Extruder / Bed ...), sorted by date and
      time, start temperature, target or rise; tapping the sort in use again flips it. A run of another heater starts
      from that heater's own model. */
  pickModelRun() {
    const all = HeatSync.load(), cur = this.mRun;
    const heaters = [...new Set(all.map((r) => r.heater))].sort((x, y) => (x === "extruder" ? -1 : y === "extruder" ? 1 : x.localeCompare(y)));
    const hName = (h) => (h === "heater_bed" ? "Bed" : prettify(h));
    const saved = Settings.get("hs_run_sort") || {};
    const st = { heater: cur && heaters.includes(cur.heater) ? cur.heater : heaters[0], sort: saved.sort || "date", desc: saved.desc !== false };
    const SORTS = { date: ["Date/time", (r) => r.wall || 0], start: ["Start", (r) => r.T0], target: ["Target", (r) => r.target], rise: ["Rise", (r) => r.target - r.T0] };
    const dateOf = (r) => { const w = r.wall ? new Date(r.wall * 1000) : null; return w ? `${w.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${w.toTimeString().slice(0, 5)}` : "no date"; };
    const label = (r) => `${r.T0.toFixed(0)}° → ${r.target}°  (+${(r.target - r.T0).toFixed(0)}°)${r.test ? "  · Test" : ""}  ·  ${dateOf(r)}${r.tau ? `  ·  τ ${r.tau.toFixed(0)} s` : ""}`;
    let close;
    const body = el("div", { class: "hs-pick" });
    const draw = () => {
      body.innerHTML = "";
      const runs = all.map((r, i) => [r, i]).filter(([r]) => r.heater === st.heater);
      const key = SORTS[st.sort][1];
      // ties: newest first
      runs.sort(([x, i], [y, j]) => (st.desc ? key(y) - key(x) : key(x) - key(y)) || (y.wall || 0) - (x.wall || 0) || j - i);
      const heaterRow = heaters.length > 1 ? ToggleRow(heaters, st.heater, (h) => { st.heater = h; draw(); }, hName, true).el : null;
      const sortRow = ToggleRow(Object.keys(SORTS), st.sort, (k) => {
        if (k === st.sort) st.desc = !st.desc; else { st.sort = k; st.desc = k === "date"; }
        Settings.set("hs_run_sort", { sort: st.sort, desc: st.desc });
        draw();
      }, (k) => `${SORTS[k][0]}${k === st.sort ? (st.desc ? " ▼" : " ▲") : ""}`, true).el;
      const list = el("div", { class: "hs-loglist" }, ...runs.map(([r]) => Button(null, label(r), r === cur || (cur && r.id === cur.id) ? "selected" : null, { lines: 1, onclick: () => {
        close();
        const other = !cur || r.heater !== cur.heater;
        this.mRun = r;
        if (other) this.mp = this.startModel(r); // a different heater: its own model
        else this.mNote = "Same model, another run";
        this.renderModel();
      } })));
      if (!runs.length) list.append(el("div", { class: "desc" }, `No ${hName(st.heater)} heat-ups recorded.`));
      body.append(...[heaterRow, el("div", { class: "hs-pick-sort" }, el("span", { class: "desc" }, "Sort"), sortRow), list,
        el("div", { class: "desc" }, `${runs.length} ${hName(st.heater)} heat-up${runs.length === 1 ? "" : "s"}`)].filter(Boolean));
    };
    draw();
    close = this.app.dialog("Compare with which run?", [{ name: "Cancel", style: "dialog-default" }], body);
  }
  closeModel() {
    if (this.mView) { this.mView.remove(); this.mView = null; }
    this.main.style.display = "flex";
    this.render();
    this.app.updateActionBar();
  }
  // ------------------------------------------------------------ the predicted run (toggle in the chart legend)
  predOn() { return !!Settings.get("hs_predict"); }
  /** Just the Predicted toggle chip (same setting as the chart legends'). */
  predToggle(onChange) {
    const on = this.predOn();
    return el("span", { class: "hs-pred-toggle" + (on ? " on" : ""), onclick: () => { Settings.set("hs_predict", !this.predOn()); onChange(); } },
      el("i", { style: { background: "#7ee06a" } }), `${on ? "☑" : "☐"} Predicted`);
  }
  /** Chart legend with the Predicted toggle; onChange redraws whichever view it's in. */
  legendEl(onChange) {
    const on = this.predOn();
    const toggle = el("span", { class: "hs-pred-toggle" + (on ? " on" : ""), onclick: () => { Settings.set("hs_predict", !this.predOn()); onChange(); } },
      el("i", { style: { background: "#7ee06a" } }), `${on ? "☑" : "☐"} Predicted`);
    const box = el("div", { class: "hs-legend" }, ...Object.values(HS_PHASES).map(([n, c]) => el("span", {}, el("i", { style: { background: c.replace(/[\d.]+\)$/, ".8)") } }), n)),
      el("span", {}, el("i", { style: { background: "#f0a028" } }), "T′"), el("span", {}, el("i", { style: { background: "#b77cf0" } }), "T″"), toggle);
    box.syncToggle = () => { const o = this.predOn(); toggle.classList.toggle("on", o); toggle.lastChild.textContent = `${o ? "☑" : "☐"} Predicted`; };
    return box;
  }
  /** What the heater's current model (saved on the Model page, else measured) says this run should look like:
      {T, reach (s, or -1: never), source} on a 1 s grid, len seconds long; null without a model. */
  predFor(r, len) {
    const m = HeatSync.model(r.heater);
    if (!m) return null;
    const c = HeatSync.curve(m, r.T0, r.target, Math.max(2, Math.round(len)));
    return { T: c.T, reach: c.T.findIndex((v) => v >= r.target), source: m.custom ? "saved model" : `measured model (${m.n} run${m.n === 1 ? "" : "s"})` };
  }
  /** Rows for the info card: predicted time to target vs this run. */
  predRows(r, pred, f) {
    if (!pred) return [["Predicted", "no model for this heater yet"]];
    const p = pred.reach >= 0 ? fmtSecs(pred.reach) : "never (target above the ceiling)";
    const rows = [["Predicted to target", p], ["Prediction from", pred.source]];
    if (pred.reach >= 0 && r.tReach !== null) rows.push(["Real − predicted", `${r.tReach - pred.reach >= 0 ? "+" : "−"}${fmtSecs(Math.abs(r.tReach - pred.reach))}`]);
    return rows;
  }

  canGoBack() { return !!this.mView || !!this.tView; }
  back() {
    if (this.mView) { this.closeModel(); return true; }
    if (this.tView) { this.closeTest(); return true; } // a running test keeps going
    return false;
  }
  deactivate() { if (this.mView) this.closeModel(); if (this.tView) this.closeTest(); }

  // ------------------------------------------------------------ Test heat: pick a heater and target, then watch it
  /** prev: the choices so far (coming back from typing a custom target). */
  testDialog(prev) {
    const devs = HeatSync.heaterDevs(this.p);
    if (!devs.length) { this.app.popup("No heaters found", 1); return; }
    const presets = (d) => (d === "heater_bed" ? [50, 60, 80, 100] : d.startsWith("extruder") ? [150, 200, 240] : [50, 80]);
    const label = (d) => (d === "heater_bed" ? "Bed" : prettify(devName(d)));
    const st = prev ? { ...prev } : { dev: devs.find((d) => HeatSync.logName(d) === this.heater) || devs[0], target: 0, off: true };
    if (!prev) st.target = presets(st.dev)[1] || presets(st.dev)[0];
    const body = el("div", { class: "ss-config" });
    const info = el("div", { class: "desc" });
    const draw = () => {
      body.innerHTML = "";
      const now = this.p.stat(st.dev, "temperature");
      const tg = presets(st.dev);
      const vals = [...tg.map(String), "other"];
      const cur = tg.includes(st.target) ? String(st.target) : "other";
      const targets = ToggleRow(vals, cur, (v) => {
        if (v !== "other") { st.target = Number(v); draw(); return; }
        Input.number({ title: "Test target", value: st.target, unit: "°C", min: 0, ok: "Set", onSubmit: (x) => this.testDialog({ ...st, target: Math.round(x) }) });
      }, (v) => (v === "other" ? (cur === "other" ? `${st.target}°` : "Other…") : `${v}°`), true);
      body.append(
        el("div", { class: "ss-config-row" }, el("div", { class: "name" }, "Heater"),
          ToggleRow(devs, st.dev, (d) => { st.dev = d; st.target = presets(d)[1] || presets(d)[0]; draw(); }, label, true).el),
        el("div", { class: "ss-config-row" }, el("div", { class: "name" }, `Target · now ${typeof now === "number" ? now.toFixed(0) + "°" : "–"}`), targets.el),
        el("div", { class: "ss-config-row" }, el("div", { class: "name" }, "When done"),
          ToggleRow(["off", "keep"], st.off ? "off" : "keep", (v) => { st.off = v === "off"; }, (v) => (v === "off" ? "Turn the heater off" : "Keep heating"), true).el),
        info);
      const why = HeatSync.testProblem(this.app, st.dev, st.target);
      info.textContent = why ? `⚠ ${why}`
        : `Heats ${label(st.dev)} from ${now.toFixed(0)}° to ${st.target}° and records it, then holds ${HeatSync.TEST_HOLD} s to see the overshoot. Best from room temperature: the more of the curve it sees, the better the fit.`;
    };
    draw();
    this.app.dialog("Test heat", [
      { name: "Start", style: "dialog-primary", cb: () => {
        const why = HeatSync.testProblem(this.app, st.dev, st.target);
        if (why) { this.app.popup(why, 2); return; }
        HeatSync.startTest(this.app, st.dev, st.target, st.off);
        this.heater = HeatSync.logName(st.dev);
        this.openTest();
      } },
      { name: "Cancel", style: "dialog-default" }], body);
  }
  openTest() {
    if (this.mView) this.closeModel();
    if (!this.tView) {
      this.main.style.display = "none";
      this.tView = el("div", { class: "fill hs-model hs-test" });
      this.el.append(this.tView);
    }
    const T = HeatSync.test;
    if (T) { T.onTick = () => this.tView && this.renderTest(); T.onEnd = () => { if (this.tView) this.renderTest(); else this.render(); }; }
    this.renderTest();
    this.app.updateActionBar();
  }
  closeTest() {
    if (this.tView) { this.tView.remove(); this.tView = null; }
    const T = HeatSync.test;
    if (T) { T.onTick = null; T.onEnd = () => this.render(); if (T.state !== "running") T.seen = true; }
    this.main.style.display = "flex";
    this.render();
    this.app.updateActionBar();
  }
  /** Every constant side by side: the fit (live or final), what's measured from the curve (so far), and the heater's
      current model (saved, else measured), each for this run's start temperature. dv: derivatives of r.T (optional). */
  constTable(r, fit, model, fitLabel, dv) {
    const f = (v, d, u = "") => (typeof v === "number" && isFinite(v) ? `${v.toFixed(d)}${u}` : "–");
    const A = (p) => (p ? p.tinf - r.T0 : 0);
    const va = (p) => (p && p.taus ? HeatSync.toVA(p, A(p)) : p ? { v: A(p) / p.tau, a: null } : {});
    const vf = va(fit), vm = va(model), pp = r.pp || {};
    if (!dv) dv = HeatSync.derive(r.T);
    const peakA = Math.max(...dv.d2.map((v) => (isFinite(v) ? v : -Infinity))) / (r.step * r.step);
    const reach = (p) => { if (!p) return null; const t = HeatSync.predict(p, r.T0, r.target); return t; };
    const modelRms = model && model.taus ? HeatSync.rms(model, r) : null;
    const rows = [
      ["Lag L", f(fit && fit.lag, 1, " s"), f(r.lag, 1, " s"), f(model && model.lag, 1, " s")],
      ["T∞ full power", f(fit && fit.tinf, 0, "°"), f(r.tinf, 0, "°"), f(model && model.tinf, 0, "°")],
      ["Time constant τ", f(fit && fit.tau, 0, " s"), f(r.tau, 0, " s"), f(model && model.tau, 0, " s")],
      ["Sensor lag τs", f(fit && fit.taus, 1, " s"), "–", model && model.taus ? f(model.taus, 1, " s") : "none"],
      ["Loss curvature", f(fit ? HeatSync.curvOf(fit, A(fit)) * 100 : null, 0, " %"), f(pp.curv !== undefined ? pp.curv * 100 : null, 0, " %"), f(model ? HeatSync.curvOf(model, A(model)) * 100 : null, 0, " %")],
      ["Velocity · peak T′", f(vf.v, 2), f(r.rmax, 2), f(vm.v, 2)],
      ["Accel · peak T″", f(vf.a, 3), f(peakA, 3), vm.a === null ? "–" : f(vm.a, 3)],
      ["T′ vs T line", "", pp.r2 ? `τ ${f(pp.tau, 0)} · T∞ ${f(pp.tinf, 0)}° · R² ${f(pp.r2, 3)}` : "–", ""],
      ["To target", f(reach(fit), 0, " s"), r.tReach !== null && r.tReach !== undefined ? `${r.tReach} s` : "–", f(reach(model), 0, " s")],
      ["Fit error (RMS)", f(fit && fit.rms, 2, "°"), "", f(modelRms, 2, "°")],
    ];
    const src = model ? (model.custom ? "your saved model" : `the measured model${model.two ? " (two-lag)" : ""}`) : "no model yet";
    const td = (v, cls) => el("td", cls ? { class: cls } : {}, v);
    const table = el("table", { class: "hs-const" },
      el("tr", {}, el("th", {}, ""), el("th", {}, fitLabel), el("th", {}, "Curve"), el("th", {}, "Model")),
      ...rows.map(([k, a, b, c]) => (k === "T′ vs T line"
        ? el("tr", {}, td(k, "k"), el("td", { colSpan: 3, class: "wide" }, b))
        : el("tr", {}, td(k, "k"), td(a), td(b), td(c)))));
    return el("div", { class: "hs-const-wrap" }, table,
      el("div", { class: "desc" }, `Curve: measured straight from the heat-up so far. Model: ${src}, for this start temperature.`));
  }
  renderTest() {
    const T = HeatSync.test, V = this.tView;
    if (!T || !V) return;
    const name = T.dev === "heater_bed" ? "Bed" : prettify(devName(T.dev));
    const elapsed = (performance.now() / 1000) - T.started;
    const last = T.samples[T.samples.length - 1] || {};
    const run = T.state === "running" ? HeatSync.testRun(T) : null;
    const r = T.result || (run ? HeatSync.analyze(run) : null);
    const f = (v, d, u) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(d)}${u}` : "–");
    // which phase it's in: the last phase that has started
    const phaseNow = () => {
      if (!r || !r.phases || !r.phases.length) return T.set ? "Lag" : "Recording the start";
      const n = r.T.length - 1, ph = [...r.phases].reverse().find(([, a]) => a <= n);
      return ph ? HS_PHASES[ph[0]][0] : "Lag";
    };
    const canvas = el("canvas", { class: "hs-chart" });
    const buttons = [];
    const kv = [];
    let table = null;
    if (T.state === "running") {
      const now = performance.now() / 1000;
      kv.push(["Now", ""], ["Elapsed", fmtSecs(elapsed)], ["Temperature", `${f(last.temp, 1, "")} → ${T.target} °C`], ["Power", f(last.pwm * 100, 0, " %")], ["Phase", phaseNow()]);
      if (T.reachedAt !== undefined) kv.push(["Holding", `${fmtSecs(now - T.reachedAt)} of ${HeatSync.TEST_HOLD}s`]);
      if (r) {
        // the curve's slope and bend: the smoothing needs a few seconds either side, so the newest points aren't
        // trustworthy yet; read T′ about 4 s back and T″ about 8 s back (long runs are thinned to one point per r.step s)
        const dv = HeatSync.derive(r.T), n = dv.d1.length;
        const at = (sec) => Math.max(0, n - 1 - Math.ceil(sec / r.step));
        const d1now = dv.d1[at(4)] / r.step, d2now = dv.d2[at(8)] / (r.step * r.step);
        kv.push(["T′ (4 s ago)", f(d1now, 2, " °C/s")], ["T″ (8 s ago)", f(d2now, 3, " °C/s²")]);
        // time to target: from τ and T∞ once known, else from the current slope
        const Tn = last.temp;
        let eta = null;
        if (T.reachedAt === undefined && Tn < T.target) {
          if (r.tau && r.tinf > T.target) eta = r.tau * Math.log((r.tinf - Tn) / (r.tinf - T.target));
          else if (d1now > 0.01) eta = (T.target - Tn) / d1now;
        }
        if (eta !== null && isFinite(eta)) kv.push(["To target", `about ${fmtSecs(eta)}`]);
        if (this.predOn()) {
          // where the current model says it should be by now, and when it should arrive
          const pr = this.predFor(r, 3600), t = Math.round((r.T.length - 1) * r.step);
          if (pr) kv.push(["Predicted", ""], ["Should be at", `${f(pr.T[Math.min(t, pr.T.length - 1)], 1, " °C")} (now ${f(Tn, 1, "")})`],
            ["Predicted to target", pr.reach >= 0 ? `${fmtSecs(pr.reach)} (${pr.reach > t ? "in " + fmtSecs(pr.reach - t) : "due already"})` : "never"], ["From", pr.source]);
          else kv.push(["Predicted", "no model for this heater yet"]);
        }
        // the two-lag fit to the data so far, every 5 s once there's something to fit
        if (T.set && r.T.length >= 20 && (!T.liveFitAt || now - T.liveFitAt >= 5)) { T.liveFit = HeatSync.fit(r); T.liveFitAt = now; }
        table = this.constTable(r, T.liveFit, HeatSync.model(T.heater), r.tau ? "Live fit" : "Fit (rough)", dv);
      }
      buttons.push(Button("cancel", "Cancel", "color2", { side: true, lines: 1, onclick: () => HeatSync.cancelTest() }));
    } else if (T.result) {
      const p = T.fit;
      kv.push(["Result", ""], ["To target", r.tReach !== null ? fmtSecs(r.tReach) : "not reached"], ["Overshoot", f(r.overshoot, 1, " °C")]);
      table = this.constTable(r, p, HeatSync.model(T.heater), "Fit");
      if (p) buttons.push(Button("complete", "Save fit as model", "color3", { side: true, lines: 1, onclick: () => {
        HeatSync.saveCustom(T.heater, p); this.app.popup(`${name}: predictions now use the fitted model`, 1); } }));
      buttons.push(Button("fine-tune", "Model page", "color1", { side: true, lines: 1, onclick: () => {
        this.closeTest(); this.heater = T.heater; this.render();
        this.sel = HeatSync.load().find((x) => x.id === r.id) || this.sel; this.openModel(this.sel); } }));
    }
    buttons.push(Button("arrow-left", T.state === "running" ? "Hide" : "Close", "color4", { side: true, lines: 1, onclick: () => this.closeTest() }));
    const head = T.state === "running" ? `Test · ${name} → ${T.target}°`
      : T.state === "done" ? `Done · ${name} ${r ? r.T0.toFixed(0) : ""}°→${T.target}°`
      : `Test heat ${T.state === "cancelled" ? "cancelled" : "stopped"} · ${name}`;
    // it redraws twice a second: keep where the readout was scrolled to
    const oldLeft = V.querySelector(".hs-left"), keepScroll = oldLeft ? oldLeft.scrollTop : 0;
    V.innerHTML = "";
    V.append(
      el("div", { class: "hs-top" }, el("div", { class: "hs-mtitle" }, head), ...buttons),
      el("div", { class: "hs-body fill" },
        el("div", { class: "hs-left scroll" },
          el("div", { class: "hs-card" },
            el("div", { class: "hs-kv" }, ...kv.flatMap(([k, v]) => (v === "" ? [el("span", { class: "hs-kv-head" }, k), el("b", {}, "")] : [el("span", {}, k), el("b", {}, v)]))),
            table,
            T.note ? el("div", { class: "desc", style: { marginTop: ".3em" } }, T.note) : null,
            T.state === "done" && T.result ? el("div", { class: "desc", style: { marginTop: ".3em" } }, "Added to the recorded heat-ups (marked Test).") : null)),
        el("div", { class: "hs-right" }, this.legendEl(() => this.renderTest()), canvas)));
    const newLeft = V.querySelector(".hs-left");
    if (newLeft) newLeft.scrollTop = keepScroll;
    if (r) {
      const p = T.state === "running" ? T.liveFit : T.fit;
      const ov = p ? HeatSync.curve(p, r.T0, r.target, HeatSync.realCurve(r).length) : null;
      // while it runs, widen the time axis to where the prediction reaches the target (plus some hold)
      const pred = this.predOn() ? this.predFor(r, 3600) : null;
      const span = T.state === "running" && pred && pred.reach >= 0 ? Math.min(3600, pred.reach * 1.25 + 20) : 0;
      requestAnimationFrame(() => this.draw(r, ov, canvas, { pred, span }));
    }
  }
  /** Set one variable; velocity/acceleration go through fromVA (they set τ and τs). */
  setVar(key, val) {
    const r = this.mRun, p = this.mp, A = () => p.tinf - r.T0;
    if (!isFinite(val)) return;
    this.mMulti = null; // the joint fit's per-run numbers no longer apply once a constant is edited
    // velocity and acceleration set τ and τs; with loss curvature that's not a closed form, so correct a few times
    const toVA = (v, a) => {
      let tv = v, ta = a, adjusted = false;
      for (let k = 0; k < (p.q ? 6 : 1); k++) {
        const s = HeatSync.fromVA(A(), tv, ta);
        p.tau = s.tau; p.taus = s.taus; adjusted = adjusted || s.adjusted;
        if (!p.q) break;
        const now = HeatSync.toVA(p, A());
        tv *= v / now.v; ta *= a / now.a;
      }
      return adjusted;
    };
    if (key === "lag") p.lag = Math.max(-2, val);
    else if (key === "tinf") {
      // keep velocity and acceleration as they were, the new ceiling changes τ and τs
      const va = HeatSync.toVA(p, A());
      p.tinf = Math.max(r.target + 1, val);
      toVA(va.v, va.a);
    } else if (key === "v" || key === "a") {
      const va = HeatSync.toVA(p, A());
      va[key] = Math.max(1e-4, val);
      const adjusted = toVA(va.v, va.a);
      this.mNote = adjusted ? "Acceleration raised to the lowest a heater with this velocity can have" : "Edited";
      this.renderModel();
      return;
    } else if (key === "tau") p.tau = Math.max(p.taus * 1.05, val);
    else if (key === "taus") p.taus = Math.min(p.tau * 0.95, Math.max(0.2, val));
    else if (key === "kappa") {
      const k = Math.max(-100, Math.min(300, val)) / 100;
      if (Math.abs(k) < 0.005) delete p.kappa; else { p.kappa = k; if (p.tamb === undefined) p.tamb = 25; }
    } else if (key === "curv") {
      // shown as the extra full-power rate at this run's start, in %
      const c = Math.max(-85, Math.min(300, val)) / 100;
      if (Math.abs(c) < 0.005) delete p.q; else p.q = c / (p.tau * Math.max(1, A()));
    }
    this.mNote = "Edited";
    this.renderModel();
  }
  /** Fit all runs: pick this heater's runs (all ticked), then one model for all of them (HeatSync.fitMany). */
  fitAllDialog(btn) {
    const heater = this.mRun.heater, runs = HeatSync.load().filter((r) => r.heater === heater && r.target - r.T0 >= 10).reverse();
    if (runs.length < 2) { this.app.popup("Needs at least two heat-ups of this heater", 2); return; }
    const pick = new Set(runs.map((r) => r.id));
    const dateOf = (r) => { const w = r.wall ? new Date(r.wall * 1000) : null; return w ? `${w.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${w.toTimeString().slice(0, 5)}` : "no date"; };
    const list = el("div", { class: "hs-loglist" });
    const draw = () => {
      list.innerHTML = "";
      for (const r of runs) list.append(Button(null, `${pick.has(r.id) ? "☑" : "☐"} ${r.T0.toFixed(0)}° → ${r.target}°  (+${(r.target - r.T0).toFixed(0)}°)${r.test ? " · Test" : ""}  ·  ${dateOf(r)}`,
        pick.has(r.id) ? "selected" : null, { lines: 1, onclick: () => { if (pick.has(r.id)) pick.delete(r.id); else pick.add(r.id); draw(); } }));
    };
    draw();
    const name = heater === "heater_bed" ? "Bed" : prettify(heater);
    const body = el("div", { class: "hs-pick" }, el("div", { class: "desc" },
      `One set of constants for all the ticked ${name} heat-ups, fitted so the model varies as little as possible between them. Runs that started warm get their own start state, and from those a warm-start factor κ.`), list);
    this.app.dialog(`Fit all ${name} runs`, [
      { name: "Fit", style: "dialog-primary", cb: () => this.fitAll(runs.filter((r) => pick.has(r.id)), btn) },
      { name: "Cancel", style: "dialog-default" }], body);
  }
  async fitAll(runs, btn) {
    if (runs.length < 2) { this.app.popup("Pick at least two heat-ups", 2); return; }
    if (btn) btn.busy(true);
    try {
      const res = await HeatSync.fitMany(runs, (t) => { this.mNote = t; const d = this.mView && this.mView.querySelector(".hs-model .hs-card .desc"); if (d) d.textContent = t; });
      if (!res) { this.mNote = "Not enough usable heat-ups (each needs 15 s at full power and a 10° rise)"; this.renderModel(); return; }
      const p = { lag: res.lag, tinf: res.tinf, tau: res.tau, taus: res.taus };
      if (res.q) p.q = res.q;
      if (res.kappa) { p.kappa = res.kappa; p.tamb = res.tamb; }
      this.mp = p;
      this.mMulti = { p, res };
      this.mNote = `Fitted to ${res.n} runs at once: ${res.rms.toFixed(2)} °C RMS overall${res.q ? ", with loss curvature" : ""}`;
      this.renderModel();
    } finally { if (btn) btn.busy(false); }
  }
  /** The last joint fit, run by run (while its constants are the ones shown). Tap a run to draw the model over it. */
  multiCard(p) {
    const m = this.mMulti;
    if (!m || m.p !== p) return null;
    const res = m.res, all = HeatSync.load();
    const f = (v, d, u = "") => (typeof v === "number" && isFinite(v) ? `${v.toFixed(d)}${u}` : "–");
    const rows = res.perRun.slice().sort((a, b) => a.T0 - b.T0 || a.target - b.target).map((x) => {
      const r = all.find((y) => y.id === x.id), cur = this.mRun && this.mRun.id === x.id;
      return el("tr", { class: cur ? "sel" : "", onclick: () => { if (r) { this.mRun = r; this.renderModel(); } } },
        el("td", { class: "k" }, `${x.T0.toFixed(0)}° → ${x.target}°`), el("td", {}, `${x.d >= 0 ? "+" : "−"}${Math.abs(x.d).toFixed(1)}°`),
        el("td", {}, f(x.rms, 2, "°")), el("td", {}, x.reach !== null ? fmtSecs(x.reach) : "never"), el("td", {}, x.real !== null && x.real !== undefined ? fmtSecs(x.real) : "–"));
    });
    const rmsAll = res.perRun.map((x) => x.rms);
    return el("div", { class: "hs-card" },
      el("div", { class: "title" }, `One model, ${res.n} runs`),
      el("div", { class: "hs-kv" },
        el("span", {}, "Fit error"), el("b", {}, `${f(res.rms, 2, " °C")} overall · ${f(Math.min(...rmsAll), 2)}–${f(Math.max(...rmsAll), 2, " °C")} per run`),
        el("span", {}, "Warm start κ"), el("b", {}, res.kappa ? `${f(res.kappa * 100, 0, " %")}: heater ahead by κ·(start − ${f(res.tamb, 0, "°")})` : "none found")),
      el("div", { class: "hs-const-wrap" }, el("table", { class: "hs-const hs-multi" },
        el("tr", {}, el("th", {}, "Run"), el("th", {}, "Ahead"), el("th", {}, "Error"), el("th", {}, "Model"), el("th", {}, "Real")),
        ...rows)),
      el("div", { class: "desc" }, "Ahead: how far the heater was ahead of the sensor at the start (0 from cold). Model / Real: time to target. Tap a run to draw it."));
  }
  renderModel() {
    const r = this.mRun, p = this.mp, V = this.mView;
    const A = p.tinf - r.T0, va = HeatSync.toVA(p, A);
    const real = HeatSync.realCurve(r);
    // the run's own start (heater ahead of the sensor, time shift) from the last joint fit, while its constants are shown
    const own = this.mMulti && this.mMulti.p === p ? this.mMulti.res.perRun.find((x) => x.id === r.id) : null;
    const pr = own ? { ...p, lag: p.lag + own.sh } : p, h0 = own ? r.T0 + own.d : undefined;
    const ov = HeatSync.curve(pr, r.T0, r.target, real.length, h0);
    const reach = ov.T.findIndex((v) => v >= r.target - 1);
    const rms = (() => { const n = HeatSync.fitLen(r, real.length), c = HeatSync.curve(pr, r.T0, Infinity, n, h0); let e = 0; for (let i = 0; i < n; i++) e += (c.T[i] - real[i]) ** 2; return Math.sqrt(e / n); })();
    // the run the heater's current model (saved, else measured) predicts, to compare the edited constants with
    const pred = this.predOn() ? this.predFor(r, real.length) : null;
    const name = r.heater === "heater_bed" ? "Bed" : prettify(r.heater);
    // one editable variable: value (tap to type) and − / + steps
    const row = (label, key, value, unit, digits, step, mult) => {
      const val = Button(null, `${value.toFixed(digits)} ${unit}`, "hs-val", { lines: 1, onclick: () => Input.number({
        title: label, value: Number(value.toFixed(digits)), unit, min: key === "curv" ? -85 : key === "kappa" ? -100 : key === "lag" ? -2 : 0, ok: "Set", keepOpen: true,
        desc: key === "v" || key === "a" || key === "curv" ? `For this run's start, ${r.T0.toFixed(0)}°` : null,
        onSubmit: (x) => this.setVar(key, x) }) });
      const nudge = (dir) => this.setVar(key, mult ? value * (dir > 0 ? 1 + step : 1 / (1 + step)) : Math.round((value + dir * step) * 1000) / 1000);
      return el("div", { class: "hs-var" }, el("div", { class: "name" }, label),
        Button(null, "−", "hs-step", { onclick: () => nudge(-1) }), val, Button(null, "+", "hs-step", { onclick: () => nudge(1) }));
    };
    const canvas = el("canvas", { class: "hs-chart" });
    V.innerHTML = "";
    V.append(
      el("div", { class: "hs-top" },
        Button(null, `Model · ${name} ${r.T0.toFixed(0)}° → ${r.target}°${r.test ? " · Test" : ""}  ▾`, "hs-mtitle hs-runpick", { lines: 1, onclick: () => this.pickModelRun() }),
        Button("refresh", "Fit all runs", "color4", { side: true, lines: 1, onclick: (e, b) => this.fitAllDialog(b) }),
        Button("refresh", "Fit to run", "color1", { side: true, lines: 1, onclick: () => { const f = HeatSync.fit(r); if (f) { this.mp = f; this.mNote = f.q ? "Fitted to this run (with loss curvature: it fit clearly better)" : "Fitted to this run"; this.renderModel(); } } }),
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
          row("Loss curvature · extra start rate", "curv", HeatSync.curvOf(p, A) * 100, "%", 0, 5, false),
          row(`Warm start κ · heater ahead, of start − ${(p.tamb !== undefined ? p.tamb : 25).toFixed(0)}°`, "kappa", (p.kappa || 0) * 100, "%", 0, 5, false),
          el("div", { class: "hs-card" }, el("div", { class: "hs-kv" },
            el("span", {}, "Fit error"), el("b", {}, `${rms.toFixed(2)} °C RMS`),
            el("span", {}, "Model to target"), el("b", {}, reach >= 0 ? fmtSecs(reach) : "never"),
            el("span", {}, "Real to target"), el("b", {}, r.tReach !== null ? fmtSecs(r.tReach) : "not reached"),
            ...(r.pp ? [el("span", {}, "T′ vs T line"), el("b", {}, `τ ${r.pp.tau.toFixed(0)} s · T∞ ${r.pp.tinf.toFixed(0)}° · R² ${r.pp.r2.toFixed(3)}`)] : []),
            ...(this.predOn() ? (pred ? [el("span", {}, "Predicted to target"), el("b", {}, pred.reach >= 0 ? fmtSecs(pred.reach) : "never"),
              el("span", {}, "Predicted from"), el("b", {}, pred.source),
              el("span", {}, "Predicted fit error"), el("b", {}, `${HeatSync.rms(HeatSync.model(r.heater), r).toFixed(2)} °C RMS`)]
              : [el("span", {}, "Predicted"), el("b", {}, "no model for this heater yet")]) : [])),
            el("div", { class: "desc", style: { marginTop: ".3em" } }, this.mNote || "")),
          this.multiCard(p)),
        el("div", { class: "hs-right" },
          el("div", { class: "hs-legend" }, el("span", {}, el("i", { style: { background: "currentColor" } }), "Real"),
            el("span", {}, el("i", { style: { background: "#35d0e0" } }), "Model"),
            el("span", {}, el("i", { style: { background: "#f0a028" } }), "T′"), el("span", {}, el("i", { style: { background: "#b77cf0" } }), "T″  (model dashed)"),
            this.predToggle(() => this.renderModel())),
          canvas)));
    requestAnimationFrame(() => this.draw(r, ov, canvas, { pred }));
  }
  activate() {
    // back to a test that's running, or one that finished while you were away
    const T = HeatSync.test;
    if (T && (T.state === "running" || !T.seen)) { this.render(); this.openTest(); return; }
    const runs = HeatSync.load();
    this.status.textContent = runs.length ? `${runs.length} heat-up${runs.length === 1 ? "" : "s"} recorded · Read log adds new ones from klippy.log` : "";
    this.render();
    if (!HeatSync.load().length) this.readLog();
  }
  relayout() { if (this.mView) this.renderModel(); else if (this.tView) this.renderTest(); else this.render(); }
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
  /** Pick which klippy logs to read: the current one and the rotated ones on the host (klippy.log.2026-11-18, ...). */
  async readDialog(btn) {
    let files;
    if (btn) btn.busy(true);
    try { files = await this.app.mr.call("server.files.list", { root: "logs" }); }
    catch (e) { files = null; }
    finally { if (btn) btn.busy(false); }
    // no listing (older Moonraker, or not allowed): just the current log, as before
    const logs = (files || []).filter((x) => x && /^klippy\.log(\.[A-Za-z0-9_.-]+)?$/.test(x.path || "") && !/\.(gz|zip|xz|bz2)$/i.test(x.path))
      .sort((a, b) => (a.path === "klippy.log" ? -1 : b.path === "klippy.log" ? 1 : (b.modified || 0) - (a.modified || 0)));
    if (logs.length <= 1) { this.readLog(btn); return; }
    const done = Settings.get(HeatSync.READ_LOGS) || {};
    const isRead = (x) => x.path !== "klippy.log" && done[x.path] && Math.abs(done[x.path] - (x.modified || 0)) < 1;
    // the current log, and any older one not read yet
    const pick = new Set(logs.filter((x) => x.path === "klippy.log" || !isRead(x)).map((x) => x.path));
    const list = el("div", { class: "hs-loglist" });
    const draw = () => {
      list.innerHTML = "";
      for (const x of logs) {
        const when = x.modified ? new Date(x.modified * 1000) : null;
        const meta = [fmtBytes(x.size || 0), when ? `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toTimeString().slice(0, 5)}` : "",
          x.path === "klippy.log" ? "current" : isRead(x) ? "read before" : ""].filter(Boolean).join(" · ");
        list.append(Button(null, `${pick.has(x.path) ? "☑" : "☐"} ${x.path}  ·  ${meta}`, pick.has(x.path) ? "selected" : null, { lines: 1, onclick: () => {
          if (pick.has(x.path)) pick.delete(x.path); else pick.add(x.path);
          draw();
        } }));
      }
    };
    draw();
    const body = el("div", {}, el("div", { class: "desc", style: { marginBottom: ".4em" } },
      "Klipper starts a new log every day and keeps the old ones. Pick the ones to read; each is read whole, keeping only the heater readings."), list);
    this.app.dialog("Read Klipper logs", [
      { name: "Read selected", style: "dialog-primary", cb: () => this.readLogs(logs.filter((x) => pick.has(x.path)), btn) },
      { name: "Read all", style: "dialog-default", cb: () => this.readLogs(logs, btn) },
      { name: "Cancel", style: "dialog-default" }], body);
  }
  /** Read the given klippy logs in turn and add all their heat-ups at once. */
  async readLogs(logs, btn) {
    if (!logs.length) { this.app.popup("Nothing picked", 1); return; }
    if (btn) btn.busy(true);
    const runs = [], failed = [], done = { ...(Settings.get(HeatSync.READ_LOGS) || {}) };
    let bytes = 0;
    try {
      for (let i = 0; i < logs.length; i++) {
        const x = logs[i];
        this.status.textContent = `Reading ${x.path} (${i + 1} of ${logs.length}, ${fmtBytes(x.size || 0)})…`;
        try {
          const text = await HeatSync.fetchHeatLog(this.app, x.path);
          bytes += x.size || 0;
          runs.push(...HeatSync.runsIn(text));
          done[x.path] = x.modified || 0;
        } catch (e) { failed.push(`${x.path}: ${e.message}`); }
      }
      Settings.set(HeatSync.READ_LOGS, done);
      const { found, added } = HeatSync.addRuns(runs);
      this.status.textContent = `${found} heat-up${found === 1 ? "" : "s"} in ${logs.length - failed.length} log${logs.length - failed.length === 1 ? "" : "s"} (${fmtBytes(bytes)}) · ${added} new · ${new Date().toTimeString().slice(0, 5)}`;
      if (failed.length) this.app.popup(`Couldn't read ${failed.join("; ")}`, 2);
      this.sel = null;
      this.render();
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
      // what the last Read log that added heat-ups changed: old → new
      const ch = HeatSync.changes(this.heater);
      const fields = [["τ", "tau", 0, " s"], ["Lag", "lag", 1, " s"], ["T∞ full power", "tinf", 0, " °C"], ["Peak rate", "rmax", 2, " °C/s"]];
      if (m.taus) fields.splice(1, 0, ["Sensor lag τs", "taus", 1, " s"]);
      if (m.q) fields.push(["Loss curvature", "q", 2, " ×10⁻⁴"]);
      const cell = (src, key, d, u) => {
        const sc = key === "q" ? 1e4 : 1, v = typeof src[key] === "number" ? src[key] * sc : src[key];
        const fmt = (x) => (typeof x === "number" && isFinite(x) ? x.toFixed(d) : "–");
        const old = !src.custom && ch && ch.before && typeof ch.before[key] === "number" ? ch.before[key] * sc : undefined;
        if (typeof old !== "number" || fmt(old) === fmt(v)) return el("b", {}, `${fmt(v)}${u}`);
        return el("b", {}, el("span", { class: "hs-old" }, fmt(old)), " → ", `${fmt(v)}${u}`,
          el("span", { class: v > old ? "hs-up" : "hs-down" }, ` ${v > old ? "▲" : "▼"}${Math.abs(v - old).toFixed(d)}`));
      };
      card.append(el("div", { class: "title" }, `${this.heater === "heater_bed" ? "Bed" : prettify(this.heater)} ${m.custom ? "saved model (Model page)" : `${m.two ? "two-lag " : ""}model · ${m.n} run${m.n === 1 ? "" : "s"}`}`),
        el("div", { class: "hs-kv" }, ...fields.flatMap(([label, key, d, u]) => [el("span", {}, label), cell(m, key, d, u)])));
      if (ch && ch.after) {
        const when = new Date(ch.at), stamp = `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toTimeString().slice(0, 5)}`;
        const added = `+${ch.added} heat-up${ch.added === 1 ? "" : "s"} ${stamp}`;
        if (!ch.before) card.append(el("div", { class: "desc hs-change" }, `${added}: first measured model`));
        else if (m.custom) {
          // the saved model doesn't move; say what the measured one did
          const diffs = fields.filter(([, k, d]) => ch.before[k].toFixed(d) !== ch.after[k].toFixed(d))
            .map(([label, k, d, u]) => `${label} ${ch.before[k].toFixed(d)} → ${ch.after[k].toFixed(d)}${u}`);
          card.append(el("div", { class: "desc hs-change" }, `${added}, measured model: ${diffs.length ? diffs.join(" · ") : "unchanged"}`));
        } else card.append(el("div", { class: "desc hs-change" }, `${added} · old → new`));
      }
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
        el("div", { class: "title" }, `${r.T0.toFixed(0)}° → ${r.target}°${r.test ? " · Test" : ""}`, el("span", { class: "desc" }, when ? `  ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toTimeString().slice(0, 5)}` : "")),
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
    // T′ against T (the downward slope at full power) and the run's own two-lag fit
    if (r.pp) kv.push(["T′ vs T line", `τ ${f(r.pp.tau, 0, " s")} · T∞ ${f(r.pp.tinf, 0, "°")} · R² ${f(r.pp.r2, 3, "")}${r.pp.curv !== undefined ? ` · bend ${f(r.pp.curv * 100, 0, "%")}` : ""}`]);
    const fit2 = r.fit2 || (HeatSync.TWO_LAG.includes(r.heater) ? HeatSync.runFit(r) : null);
    if (fit2) kv.push(["Two-lag fit", `τ ${f(fit2.tau, 0, " s")} · τs ${f(fit2.taus, 1, " s")} · T∞ ${f(fit2.tinf, 0, "°")}${fit2.q ? ` · bend ${f(HeatSync.curvOf(fit2, fit2.tinf - r.T0) * 100, 0, "%")}` : ""} · ${f(fit2.rms, 2, "° RMS")}`]);
    this.legend.syncToggle();
    const pred = this.predOn() ? this.predFor(r, HeatSync.realCurve(r).length) : null;
    if (this.predOn()) kv.push(...this.predRows(r, pred, f));
    this.info.append(el("div", { class: "hs-kv" }, ...kv.flatMap(([k, v]) => [el("span", {}, k), el("b", {}, v)])));
    if (r.note) this.info.append(el("div", { class: "desc" }, r.note));
    requestAnimationFrame(() => this.draw(r, null, null, { pred }));
  }
  /** Temperature on top, T′ and T″ (each on its own scale) below, phases shaded.
      ov: a model curve {T, d1, d2} (1 s grid) drawn dashed over the real run.
      extra.pred: the predicted run {T} from the heater's current model, drawn dotted green;
      extra.span: seconds the time axis covers (longer than the run: room for the prediction ahead of a running test). */
  draw(r, ov, canvas, extra = {}) {
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
    const span = Math.max(dur, extra.span || 0), pred = extra.pred;
    const X = (t) => gx + (gw * t) / Math.max(1, span);
    // phases
    for (const [p, a, b] of r.phases || []) { if (a >= dur) continue; g.fillStyle = HS_PHASES[p][1]; g.fillRect(X(a), gy, Math.max(1, X(Math.min(b, dur)) - X(a)), H - gy - fs * 1.6); }
    // temperature
    const lo = Math.min(r.T0, ...T) - 2, hi = Math.max(r.target, ...T) + 2, Y = (v) => gy + gh - ((v - lo) / (hi - lo)) * gh;
    if (pred) {
      // the predicted run first, so the real one is drawn on top of it
      g.strokeStyle = "#7ee06a"; g.lineWidth = 2.5; g.setLineDash([2, 4]); g.lineCap = "round"; g.beginPath();
      for (let i = 0; i <= Math.min(span, pred.T.length - 1); i++) { const y = Math.max(gy, Math.min(gy + gh, Y(pred.T[i]))); i ? g.lineTo(X(i), y) : g.moveTo(X(0), y); }
      g.stroke(); g.setLineDash([]); g.lineCap = "butt";
    }
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
    // derivatives, each scaled to fit the real run only (so editing a model never rescales the recorded run),
    // zero line shared; the model's curves are clipped to the band
    const m1 = Math.max(1e-6, ...d1.map(Math.abs)), m2 = Math.max(1e-6, ...d2.map(Math.abs));
    const Z = by + bh / 2;
    g.strokeStyle = "rgba(127,127,127,.5)"; g.beginPath(); g.moveTo(gx, Z); g.lineTo(gx + gw, Z); g.stroke();
    const plot = (d, mx, col) => {
      g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath();
      d.forEach((v, i) => { const x = X(i), y = Math.max(by, Math.min(by + bh, Z - (v / mx) * (bh / 2) * 0.95)); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    };
    plot(d2, m2, "#b77cf0"); plot(d1, m1, "#f0a028");
    if (ov) {
      g.setLineDash([5, 4]);
      plot(ov.d2.slice(0, dur + 1), m2, "rgba(214,170,255,.95)"); plot(ov.d1.slice(0, dur + 1), m1, "rgba(255,214,140,.95)");
      g.setLineDash([]);
    }
    g.fillStyle = text; g.textAlign = "right"; g.fillText("0", gx - 4, Z);
    // time axis
    g.textAlign = "center"; g.textBaseline = "top";
    const tick = span > 900 ? 300 : span > 300 ? 60 : span > 120 ? 30 : 10;
    for (let t = 0; t <= span; t += tick) g.fillText(fmtSecs(t), X(t), H - fs * 1.4);
  }
};
