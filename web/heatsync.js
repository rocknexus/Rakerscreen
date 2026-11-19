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
    return this.addRuns(runs);
  },
  /** Add analysed heat-ups to the record (skipping ones already there). Returns {found, added}. */
  addRuns(runs) {
    const have = this.load(), ids = new Set(have.map((r) => r.id));
    const fresh = runs.filter((r) => !ids.has(r.id));
    let all = [...have, ...fresh];
    // newest MAX_PER_HEATER per heater (by wall time when known, else as found)
    const by = {};
    for (const r of all) (by[r.heater] = by[r.heater] || []).push(r);
    all = Object.values(by).flatMap((list) => list.slice(-this.MAX_PER_HEATER));
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
  /** Medians over a heater's recorded runs (the measured model), or null without a time constant yet. */
  measured(heater, list = this.load()) {
    const runs = list.filter((r) => r.heater === heater && r.tau > 0 && r.tinf);
    if (!runs.length) return null;
    const med = (k) => this.median(runs.map((r) => r[k]).filter((v) => typeof v === "number"));
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
      Time to target in the macro is the two-lag curve's long-run form, L + τ·ln(τ·(T∞−T0) / ((τ−τs)·(T∞−T))),
      which is within a second or two of the app's prediction once the sensor lag has passed. */
  cfg() {
    const mb = this.model("heater_bed"), me = this.model("extruder");
    if (!mb || !me) return null;
    const n = (v, d) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "0");
    const src = (m) => (m.custom ? "saved model (Model page)" : `measured, median of ${m.n} heat-up${m.n === 1 ? "" : "s"}`);
    const vars = (p, m) => [`variable_${p}_lag: ${n(m.lag, 1)}`, `variable_${p}_tau: ${n(m.tau, 1)}`, `variable_${p}_taus: ${n(m.taus || 0, 2)}`, `variable_${p}_tinf: ${n(m.tinf, 1)}`];
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
      "  {% macro secs(l, tau, taus, tinf, t0, t) -%}",
      "    {%- if t <= t0 -%}0{%- elif t >= tinf - 0.5 -%}-1",
      "    {%- else -%}{ [0, l + tau * (ln(tau * (tinf - t0) / ((tau - taus) * (tinf - t)))|float)]|max }{%- endif -%}",
      "  {%- endmacro %}",
      "  {% set v = printer[\"gcode_macro HEAT_SYNC\"] %}",
      "  {% set bed = params.BED|default(0)|float %}",
      "  {% set ext = params.EXTRUDER|default(0)|float %}",
      "  {% set wait = params.WAIT|default(1)|int %}",
      "  {% set tb = secs(v.bed_lag, v.bed_tau, v.bed_taus, v.bed_tinf, printer.heater_bed.temperature, bed)|float %}",
      "  {% set te = secs(v.extruder_lag, v.extruder_tau, v.extruder_taus, v.extruder_tinf, printer.extruder.temperature, ext)|float %}",
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
  // ------------------------------------------------------------ the predicted run (toggle in the chart legend)
  predOn() { return !!Settings.get("hs_predict"); }
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
        kv.push(["Measured so far", ""], ["Peak T′", r.rmax ? `${f(r.rmax, 2, " °C/s")} at ${fmtSecs(r.tInfl)}` : "–"], ["Lag", f(r.lag, 1, " s")],
          ["Time constant τ", r.tau ? f(r.tau, 0, " s") : "after the bend"], ["T∞ full power", r.tinf ? f(r.tinf, 0, " °C") : "after the bend"]);
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
        const p = T.liveFit;
        if (p) {
          const va = HeatSync.toVA(p, p.tinf - r.T0);
          kv.push([r.tau ? "Live fit (two-lag)" : "Live fit (rough until it bends)", ""], ["τ · τs", `${f(p.tau, 0, " s")} · ${f(p.taus, 1, " s")}`], ["T∞", f(p.tinf, 0, " °C")], ["Lag L", f(p.lag, 1, " s")],
            ["Velocity · peak T′", f(va.v, 2, " °C/s")], ["Accel · peak T″", f(va.a, 3, " °C/s²")], ["Fit error", f(p.rms, 2, " °C RMS")]);
        }
      }
      buttons.push(Button("cancel", "Cancel", "color2", { side: true, lines: 1, onclick: () => HeatSync.cancelTest() }));
    } else if (T.result) {
      const p = T.fit, A = p ? p.tinf - r.T0 : 0, va = p ? HeatSync.toVA(p, A) : null;
      kv.push(["Measured", ""], ["Time constant τ", f(r.tau, 0, " s")], ["Lag", f(r.lag, 1, " s")], ["T∞ full power", f(r.tinf, 0, " °C")],
        ["Peak rate", f(r.rmax, 2, " °C/s")], ["To target", r.tReach !== null ? fmtSecs(r.tReach) : "not reached"], ["Overshoot", f(r.overshoot, 1, " °C")]);
      if (p) kv.push(["Fitted (two-lag)", ""], ["Lag L", f(p.lag, 1, " s")], ["T∞", f(p.tinf, 0, " °C")], ["τ", f(p.tau, 0, " s")], ["Sensor lag τs", f(p.taus, 1, " s")],
        ["Velocity · peak T′", f(va.v, 2, " °C/s")], ["Accel · peak T″", f(va.a, 3, " °C/s²")], ["Fit error", f(p.rms, 2, " °C RMS")]);
      if (p) buttons.push(Button("complete", "Save fit as model", "color3", { side: true, lines: 1, onclick: () => {
        HeatSync.saveCustom(T.heater, p); this.app.popup(`${name}: predictions now use the fitted model`, 1); } }));
      buttons.push(Button("fine-tune", "Model page", "color1", { side: true, lines: 1, onclick: () => {
        this.closeTest(); this.heater = T.heater; this.render();
        this.sel = HeatSync.load().find((x) => x.id === r.id) || this.sel; this.openModel(); } }));
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
      const cell = (src, key, d, u) => {
        const v = src[key], fmt = (x) => (typeof x === "number" && isFinite(x) ? x.toFixed(d) : "–");
        const old = !src.custom && ch && ch.before ? ch.before[key] : undefined;
        if (typeof old !== "number" || fmt(old) === fmt(v)) return el("b", {}, `${fmt(v)}${u}`);
        return el("b", {}, el("span", { class: "hs-old" }, fmt(old)), " → ", `${fmt(v)}${u}`,
          el("span", { class: v > old ? "hs-up" : "hs-down" }, ` ${v > old ? "▲" : "▼"}${Math.abs(v - old).toFixed(d)}`));
      };
      card.append(el("div", { class: "title" }, `${this.heater === "heater_bed" ? "Bed" : prettify(this.heater)} ${m.custom ? "saved model (Model page)" : `model · ${m.n} run${m.n === 1 ? "" : "s"}`}`),
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
