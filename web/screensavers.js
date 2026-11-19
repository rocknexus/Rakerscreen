"use strict";
/* Screensavers (Rakerscreen extra, Settings → Display → Screensaver)
   Each one is start(host, app) -> stop(). host is the #screensaver element; a saver adds its own canvas.
   "blank" is KlipperScreen's black screen (and the only one that dims the backlight right away). */

const Screensavers = {
  list: [["blank", "Black screen (default)"], ["pipes", "Pipes (3D)"], ["gyroid", "Gyroid layers"], ["starfield", "Starfield"], ["ribbons", "Ribbons"], ["status", "Clock and printer status"], ["random", "Random (not black)"]],
  current: null,

  /** Start the chosen saver in host; returns the key that actually runs. */
  start(host, app, key) {
    this.stop();
    if (key === "random") { const pool = ["pipes", "gyroid", "starfield", "ribbons", "status"]; key = pool[Math.floor(Math.random() * pool.length)]; }
    if (!this.savers[key]) key = "blank";
    if (key === "blank") return key;
    try { this.current = this.savers[key](host, app); } catch (e) { console.warn("screensaver " + key + ": " + e.message); this.current = this.savers.starfield(host, app); key = "starfield"; }
    return key;
  },
  stop() {
    if (this.current) { try { this.current(); } catch (e) { /* ignore */ } }
    this.current = null;
  },

  /** Full-screen canvas sized to host in device pixels (capped: these run for hours). */
  canvas(host, maxDpr = 1.5) {
    const c = document.createElement("canvas");
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    host.append(c);
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr), r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      const changed = c.width !== w || c.height !== h;
      if (changed) { c.width = w; c.height = h; }
      return changed;
    };
    fit();
    return { c, fit };
  },
  /** requestAnimationFrame loop; frame(dt seconds) returns nothing. Returns stop(). */
  loop(frame) {
    let raf = 0, last = performance.now(), on = true;
    const step = (now) => {
      if (!on) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      frame(dt);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { on = false; cancelAnimationFrame(raf); };
  },

  savers: {},

  // ------------------------------------------------------------ per-saver settings (gear beside it in the picker)
  /** key -> {title, store, fields: [[name, field, [[value, label], ...], default]]} */
  configs: {},
  options(key) {
    const c = this.configs[key], saved = Settings.get(c.store) || {}, out = {};
    for (const [, f, , def] of c.fields) out[f] = saved[f] !== undefined ? saved[f] : def;
    return out;
  },
  /** The settings dialog for one saver: a row of choices per setting, Preview and Done. */
  configure(app, key) {
    const c = this.configs[key];
    const cur = this.options(key);
    const body = el("div", { class: "ss-config" }, ...c.fields.map(([name, f, choices]) => {
      const labels = Object.fromEntries(choices.map(([v, l]) => [String(v), l]));
      const tr = ToggleRow(choices.map(([v]) => String(v)), String(cur[f]), (v) => {
        const keep = { ...(Settings.get(c.store) || {}) };
        keep[f] = choices.find(([x]) => String(x) === v)[0];
        Settings.set(c.store, keep);
      }, (v) => labels[v], true);
      return el("div", { class: "ss-config-row" }, el("div", { class: "name" }, name), tr.el);
    }));
    app.dialog(c.title, [
      { name: "Preview", style: "dialog-primary", cb: () => { Settings.set("screensaver", key); setTimeout(() => app.showScreensaver(true), 200); } },
      { name: "Reset", style: "dialog-default", cb: () => { Settings.set(c.store, {}); this.configure(app, key); } },
      { name: "Done", style: "dialog-default" }], body);
  },
};

// ================================================================= Pipes: pipes grow through a 3D grid, turning at random
Screensavers.configs.pipes = {
  title: "Pipes", store: "ss_pipes",
  fields: [
    ["Speed", "speed", [[3, "Slow"], [7.5, "Normal"], [14, "Fast"], [24, "Very fast"]], 7.5],
    ["Pipes at once", "count", [[1, "1"], [2, "2"], [3, "3"], [5, "5"], ["random", "Random"]], "random"],
    ["Joints", "joints", [["random", "Random"], ["balls", "Balls"], ["elbows", "Plain"]], "random"],
    ["Pipe thickness", "radius", [[0.12, "Thin"], [0.18, "Normal"], [0.26, "Thick"]], 0.18],
    ["Grid", "grid", [[6, "Small"], [9, "Medium"], [13, "Large"]], 9],
    ["Fill before starting over", "fill", [[0.25, "25%"], [0.45, "45%"], [0.7, "70%"]], 0.45],
    ["Colours", "colors", [["mixed", "Mixed"], ["warm", "Warm"], ["cool", "Cool"], ["metal", "Metal"]], "mixed"],
  ],
};
Screensavers.savers.pipes = (host, app) => {
  const o = Screensavers.options("pipes");
  const { c, fit } = Screensavers.canvas(host);
  // the colour and depth buffers are kept between frames: each frame only draws what grew, like the old savers did
  const gl = c.getContext("webgl", { preserveDrawingBuffer: true, antialias: true, alpha: false });
  if (!gl) { c.remove(); throw new Error("no WebGL"); }

  // ---- shaders: one light, ambient + diffuse + Blinn specular
  const vs = `attribute vec3 aPos; attribute vec3 aNor;
    uniform mat4 uProj, uView, uModel, uRot;
    varying vec3 vN, vW;
    void main() { vec4 w = uModel * vec4(aPos, 1.0); vW = w.xyz; vN = mat3(uRot) * aNor; gl_Position = uProj * uView * w; }`;
  const fs = `precision mediump float;
    uniform vec3 uColor, uEye, uLight;
    varying vec3 vN, vW;
    void main() {
      vec3 n = normalize(vN), l = normalize(uLight), v = normalize(uEye - vW), h = normalize(l + v);
      float d = max(dot(n, l), 0.0), s = pow(max(dot(n, h), 0.0), 48.0);
      vec3 fill = 0.22 * max(dot(n, normalize(vec3(-0.6, -0.3, 0.5))), 0.0) * uColor;
      gl_FragColor = vec4(uColor * (0.18 + 0.75 * d) + fill + vec3(0.65) * s, 1.0);
    }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = {}; for (const n of ["uProj", "uView", "uModel", "uRot", "uColor", "uEye", "uLight"]) U[n] = gl.getUniformLocation(prog, n);
  const aPos = gl.getAttribLocation(prog, "aPos"), aNor = gl.getAttribLocation(prog, "aNor");

  // ---- meshes: an open cylinder along +z (radius 1, length 1) and a sphere (radius 1)
  const mesh = (pos, nor, idx) => {
    const b = (data, target, T) => { const o = gl.createBuffer(); gl.bindBuffer(target, o); gl.bufferData(target, new T(data), gl.STATIC_DRAW); return o; };
    return { p: b(pos, gl.ARRAY_BUFFER, Float32Array), n: b(nor, gl.ARRAY_BUFFER, Float32Array), i: b(idx, gl.ELEMENT_ARRAY_BUFFER, Uint16Array), count: idx.length };
  };
  const cyl = (() => {
    const S = 20, pos = [], nor = [], idx = [];
    for (let k = 0; k <= S; k++) { const a = (k / S) * Math.PI * 2, x = Math.cos(a), y = Math.sin(a); pos.push(x, y, 0, x, y, 1); nor.push(x, y, 0, x, y, 0); }
    for (let k = 0; k < S; k++) { const q = k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    return mesh(pos, nor, idx);
  })();
  const sph = (() => {
    const A = 14, B = 20, pos = [], idx = [];
    for (let i = 0; i <= A; i++) { const t = (i / A) * Math.PI; for (let j = 0; j <= B; j++) { const p = (j / B) * Math.PI * 2; pos.push(Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)); } }
    for (let i = 0; i < A; i++) for (let j = 0; j < B; j++) { const a = i * (B + 1) + j, b = a + B + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    return mesh(pos, pos, idx);
  })();
  const bind = (m) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, m.p); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.n); gl.enableVertexAttribArray(aNor); gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.i);
  };

  // ---- small matrix helpers (column-major, like GL)
  const perspective = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]; };
  const mul = (a, b) => { const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; };
  const rotY = (a) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
  const rotX = (a) => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
  const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  /** Rotation taking +z to axis direction d (one of the six), as a basis {x, y, z}. */
  const basis = (d) => {
    const z = d, x = Math.abs(d[0]) > 0.5 ? [0, 1, 0] : [1, 0, 0];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
  };
  const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  // ---- the scene
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const PALETTES = {
    mixed: [[0.85, 0.12, 0.1], [0.1, 0.55, 0.9], [0.15, 0.75, 0.25], [0.95, 0.75, 0.1], [0.75, 0.2, 0.85], [0.1, 0.8, 0.8], [0.95, 0.45, 0.1], [0.8, 0.8, 0.82]],
    warm: [[0.85, 0.12, 0.1], [0.95, 0.45, 0.1], [0.95, 0.75, 0.1], [0.8, 0.25, 0.4]],
    cool: [[0.1, 0.55, 0.9], [0.1, 0.8, 0.8], [0.15, 0.75, 0.25], [0.45, 0.3, 0.9]],
    metal: [[0.8, 0.8, 0.82], [0.72, 0.55, 0.3], [0.75, 0.45, 0.3], [0.55, 0.58, 0.62]],
  };
  const COLORS = PALETTES[o.colors] || PALETTES.mixed;
  const R = o.radius; // pipe radius in grid cells
  let NX, NY, NZ, used, pipes, segs, view, world, eye, joints, wait, speed;
  const cellKey = (p) => (p[0] * NY + p[1]) * NZ + p[2];
  const inside = (p) => p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < NX && p[1] < NY && p[2] < NZ;
  const free = (p) => inside(p) && !used[cellKey(p)];
  const pos = (p) => [p[0] - (NX - 1) / 2, p[1] - (NY - 1) / 2, p[2] - (NZ - 1) / 2];

  const draw = (m, model, rot, color) => {
    bind(m);
    gl.uniformMatrix4fv(U.uModel, false, mul(world, model));
    gl.uniformMatrix4fv(U.uRot, false, mul(world, rot));
    gl.uniform3fv(U.uColor, color);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
  };
  const ball = (p, r, color) => { const w = pos(p); draw(sph, mul(translate(w[0], w[1], w[2]), [r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, 0, 0, 0, 1]), ID, color); };
  /** Pipe from cell p, along d, `len` cells long (grows over frames: drawn again a little longer each time). */
  const tube = (p, d, len, color) => {
    const w = pos(p), B = basis(d);
    draw(cyl, mul(translate(w[0], w[1], w[2]), mul(B, [R, 0, 0, 0, 0, R, 0, 0, 0, 0, len, 0, 0, 0, 0, 1])), B, color);
  };

  const newPipe = () => {
    for (let tries = 0; tries < 40; tries++) {
      const p = [Math.floor(Math.random() * NX), Math.floor(Math.random() * NY), Math.floor(Math.random() * NZ)];
      if (!free(p)) continue;
      used[cellKey(p)] = 1;
      const pipe = { p, d: null, t: 1, color: COLORS[Math.floor(Math.random() * COLORS.length)], straight: 0 };
      ball(p, R * 1.25, pipe.color); // the pipe's starting cap
      return pipe;
    }
    return null;
  };
  /** Next direction: mostly keep going; turn sometimes or when blocked. null: boxed in. */
  const turn = (pipe) => {
    const ahead = pipe.d && free(pipe.p.map((v, i) => v + pipe.d[i]));
    if (ahead && Math.random() > 0.22 + pipe.straight * 0.04) { pipe.straight++; return pipe.d; }
    const opts = DIRS.filter((d) => (!pipe.d || d.some((v, i) => v !== -pipe.d[i])) && free(pipe.p.map((v, i) => v + d[i])));
    if (!opts.length) return null;
    pipe.straight = 0;
    return opts[Math.floor(Math.random() * opts.length)];
  };

  const reset = () => {
    fit();
    const asp = c.width / c.height;
    NY = o.grid; NZ = o.grid; NX = Math.max(o.grid, Math.round(NY * asp));
    used = new Uint8Array(NX * NY * NZ);
    segs = 0; wait = 0;
    joints = o.joints === "random" ? (Math.random() < 0.5 ? "balls" : "elbows") : o.joints;
    speed = o.speed * (0.85 + Math.random() * 0.3); // cells per second
    gl.viewport(0, 0, c.width, c.height);
    const dist = NY * 1.55;
    eye = [0, 0, dist];
    gl.uniformMatrix4fv(U.uProj, false, perspective((50 * Math.PI) / 180, asp, 0.5, dist * 3));
    view = translate(0, 0, -dist);
    gl.uniformMatrix4fv(U.uView, false, view);
    // a different slant on the grid each time
    world = mul(rotX((Math.random() - 0.5) * 0.5), rotY((Math.random() - 0.5) * 0.7));
    gl.uniform3fv(U.uEye, eye);
    gl.uniform3fv(U.uLight, [0.5, 0.8, 0.9]);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    pipes = [];
    const n = o.count === "random" ? 1 + Math.floor(Math.random() * 3) : o.count;
    for (let k = 0; k < n; k++) { const p = newPipe(); if (p) pipes.push(p); }
  };
  reset(); // no face culling: the cylinders are open-ended and their insides show at the ends

  const limit = () => Math.floor(NX * NY * NZ * o.fill);
  const stop = Screensavers.loop((dt) => {
    if (fit()) { reset(); return; }
    if (wait > 0) { wait -= dt; if (wait <= 0) reset(); return; }
    for (let k = 0; k < pipes.length; k++) {
      const pipe = pipes[k];
      let budget = speed * dt;
      while (budget > 0 && pipe) {
        if (pipe.t >= 1) {
          // segment done: pick the next one
          const d = turn(pipe);
          if (!d || segs >= limit()) {
            ball(pipe.p, R * 1.25, pipe.color); // end cap
            pipes[k] = segs < limit() ? newPipe() : null;
            break;
          }
          if (pipe.d && d !== pipe.d) ball(pipe.p, joints === "balls" ? R * 1.45 : R, pipe.color);
          pipe.d = d; pipe.t = 0;
          const next = pipe.p.map((v, i) => v + d[i]);
          used[cellKey(next)] = 1;
          pipe.from = pipe.p; pipe.p = next;
          segs++;
        }
        const step = Math.min(budget, 1 - pipe.t);
        pipe.t += step; budget -= step;
        tube(pipe.from, pipe.d, pipe.t, pipe.color);
      }
    }
    if (pipes.every((p) => !p)) wait = 2.5; // full: hold the picture a moment, then start over
  });
  return () => { stop(); const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); c.remove(); };
};

// ================================================================= Starfield: flying through stars
Screensavers.configs.starfield = {
  title: "Starfield", store: "ss_starfield",
  fields: [
    ["Speed", "speed", [[0.15, "Slow"], [0.35, "Normal"], [0.8, "Fast"], [1.6, "Warp"]], 0.35],
    ["Stars", "count", [[150, "Few"], [400, "Normal"], [900, "Many"]], 400],
    ["Trails", "trail", [[0.7, "Short"], [0.35, "Normal"], [0.12, "Long"]], 0.35],
    ["Colour", "color", [["white", "White"], ["blue", "Blue"], ["warm", "Warm"], ["rainbow", "Rainbow"]], "white"],
  ],
};
Screensavers.savers.starfield = (host) => {
  const o = Screensavers.options("starfield");
  const { c, fit } = Screensavers.canvas(host, 1);
  const g = c.getContext("2d");
  const N = o.count, stars = [];
  const tint = (s, b) => (o.color === "blue" ? `rgba(150,190,255,${b})` : o.color === "warm" ? `rgba(255,200,140,${b})`
    : o.color === "rainbow" ? `hsla(${s.h},90%,70%,${b})` : `rgba(255,255,255,${b})`);
  const spawn = (s, far) => { s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; s.z = far ? 1 : Math.random(); s.pz = s.z; s.h = Math.random() * 360; return s; };
  for (let i = 0; i < N; i++) stars.push(spawn({}, false));
  const stop = Screensavers.loop((dt) => {
    fit();
    const W = c.width, H = c.height, cx = W / 2, cy = H / 2, k = Math.max(W, H) * 0.5;
    g.fillStyle = `rgba(0,0,0,${o.trail})`; g.fillRect(0, 0, W, H);
    for (const s of stars) {
      s.pz = s.z; s.z -= dt * o.speed;
      if (s.z <= 0.02) { spawn(s, true); continue; }
      const x = cx + (s.x / s.z) * k, y = cy + (s.y / s.z) * k, px = cx + (s.x / s.pz) * k, py = cy + (s.y / s.pz) * k;
      if (x < 0 || y < 0 || x > W || y > H) { spawn(s, true); continue; }
      const b = Math.min(1, (1 - s.z) * 1.4);
      g.strokeStyle = tint(s, b); g.lineWidth = Math.max(1, (1 - s.z) * 3);
      g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
    }
  });
  return () => { stop(); c.remove(); };
};

// ================================================================= Ribbons: two bouncing outlines leaving trails
Screensavers.configs.ribbons = {
  title: "Ribbons", store: "ss_ribbons",
  fields: [
    ["Shapes", "count", [[1, "1"], [2, "2"], [3, "3"], [4, "4"]], 2],
    ["Corners", "corners", [[3, "3"], [4, "4"], [5, "5"], [6, "6"]], 4],
    ["Speed", "speed", [[0.15, "Slow"], [0.35, "Normal"], [0.7, "Fast"]], 0.35],
    ["Trail", "trail", [[6, "Short"], [14, "Normal"], [28, "Long"]], 14],
    ["Line width", "width", [[1, "Thin"], [2, "Normal"], [4, "Thick"]], 2],
    ["Colour change", "hue", [[0, "Off"], [12, "Slow"], [45, "Fast"]], 12],
  ],
};
Screensavers.savers.ribbons = (host) => {
  const o = Screensavers.options("ribbons");
  const { c, fit } = Screensavers.canvas(host, 1);
  const g = c.getContext("2d");
  const shape = (hue) => ({ hue, pts: Array.from({ length: o.corners }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * o.speed, vy: (Math.random() - 0.5) * o.speed })), trail: [] });
  const shapes = Array.from({ length: o.count }, () => shape(Math.random() * 360));
  const stop = Screensavers.loop((dt) => {
    fit();
    const W = c.width, H = c.height;
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    for (const s of shapes) {
      for (const p of s.pts) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < 0 || p.x > 1) { p.vx = -p.vx; p.x = Math.min(1, Math.max(0, p.x)); }
        if (p.y < 0 || p.y > 1) { p.vy = -p.vy; p.y = Math.min(1, Math.max(0, p.y)); }
      }
      s.hue = (s.hue + dt * o.hue) % 360;
      s.trail.unshift(s.pts.map((p) => [p.x * W, p.y * H]));
      if (s.trail.length > o.trail) s.trail.pop();
      s.trail.forEach((poly, i) => {
        if (i % 2) return;
        g.strokeStyle = `hsla(${s.hue},90%,60%,${1 - i / o.trail})`; g.lineWidth = o.width;
        g.beginPath(); poly.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
      });
    }
  });
  return () => { stop(); c.remove(); };
};

// ================================================================= Clock and printer status, drifting so nothing burns in
Screensavers.configs.status = {
  title: "Clock and printer status", store: "ss_status",
  fields: [
    ["Show", "show", [["all", "Clock, temps, print"], ["print", "Clock and print"], ["clock", "Clock only"]], "all"],
    ["Seconds", "seconds", [[false, "Off"], [true, "On"]], false],
    ["Size", "size", [[0.7, "Small"], [1, "Normal"], [1.4, "Large"], [1.9, "Huge"]], 1],
    ["Brightness", "bright", [[0.45, "Dim"], [0.75, "Normal"], [1, "Bright"]], 0.75],
    ["Drift", "drift", [[0.5, "Slow"], [1, "Normal"], [2.5, "Fast"]], 1],
  ],
};
Screensavers.savers.status = (host, app) => {
  const o = Screensavers.options("status");
  const box = document.createElement("div");
  box.className = "ss-status";
  box.style.fontSize = `${o.size}em`;
  box.style.opacity = o.bright;
  host.append(box);
  let x = Math.random(), y = Math.random(), vx = 0.025 * o.drift, vy = 0.018 * o.drift; // fractions of the free space per second
  const fmt = (v) => (typeof v === "number" ? `${v.toFixed(0)}°` : "–");
  const update = () => {
    const p = app.printer, d = new Date();
    const time = Settings.get("24htime") ? d.toTimeString().slice(0, o.seconds ? 8 : 5)
      : d.toLocaleTimeString([], o.seconds ? { hour: "numeric", minute: "2-digit", second: "2-digit" } : { hour: "numeric", minute: "2-digit" });
    const lines = [`<div class="t">${time}</div>`];
    if (o.show === "clock") { box.innerHTML = lines.join(""); return; }
    const te = p.stat("extruder", "temperature"), tb = p.stat("heater_bed", "temperature");
    const ge = p.stat("extruder", "target"), gb = p.stat("heater_bed", "target");
    if (o.show === "all") lines.push(`<div class="h">Extruder ${fmt(te)}${ge ? ` / ${fmt(ge)}` : ""} · Bed ${fmt(tb)}${gb ? ` / ${fmt(gb)}` : ""}</div>`);
    const state = p.stat("print_stats", "state");
    if (state === "printing" || state === "paused") {
      const prog = p.stat("display_status", "progress") || p.stat("virtual_sdcard", "progress") || 0;
      const file = String(p.stat("print_stats", "filename") || "").split("/").pop().replace(/\.gcode$/i, "");
      lines.push(`<div class="h">${state === "paused" ? "Paused" : "Printing"} ${(prog * 100).toFixed(0)}%</div>`,
        `<div class="bar"><i style="width:${(prog * 100).toFixed(1)}%"></i></div>`,
        `<div class="f"></div>`);
      box.innerHTML = lines.join("");
      box.querySelector(".f").textContent = file;
    } else box.innerHTML = lines.join("");
  };
  update();
  const tick = setInterval(update, 1000);
  const stop = Screensavers.loop((dt) => {
    const W = host.clientWidth, H = host.clientHeight, bw = box.offsetWidth, bh = box.offsetHeight;
    x += vx * dt; y += vy * dt;
    if (x < 0 || x > 1) { vx = -vx; x = Math.min(1, Math.max(0, x)); }
    if (y < 0 || y > 1) { vy = -vy; y = Math.min(1, Math.max(0, y)); }
    box.style.transform = `translate(${(x * (W - bw)).toFixed(1)}px, ${(y * (H - bh)).toFixed(1)}px)`;
  });
  return () => { stop(); clearInterval(tick); box.remove(); };
};

// ================================================================= Gyroid layers: sweeping up through the slices of gyroid infill
/* The gyroid sin x·cos y + sin y·cos z + sin z·cos x = 0 cut at height z is the line pattern slicers print as gyroid
   infill; moving z up layer by layer makes it flow. Drawn in a fragment shader over the whole screen: distance to the
   curve ≈ |f| / |∇f|, with the last few layers fading below the current one. 24 frames a second (nothing is drawn in
   between), a quarter layer per frame. Lava-lamp look: the plane is warped by slow, large waves, the cell size swells
   and shrinks from place to place, and the height runs ahead in some areas and behind in others, so blobs of the
   pattern bulge, drift and morph instead of marching in step. The colour shifts over minutes so nothing burns in. */
Screensavers.configs.gyroid = {
  title: "Gyroid layers", store: "ss_gyroid",
  fields: [
    ["Speed", "speed", [[0.1, "10%"], [0.25, "25%"], [0.5, "50%"], [1, "100%"]], 0.25],
    ["Frame rate", "fps", [[12, "12 fps"], [24, "24 fps"], [30, "30 fps"], [60, "60 fps"]], 24],
    ["Lava-lamp warp", "warp", [[0, "Off"], [0.5, "Gentle"], [1, "Medium"], [1.6, "Strong"]], 1],
    ["Cell size", "cell", [[0.1, "Small"], [0.16, "Medium"], [0.24, "Large"], [0.36, "Huge"]], 0.16],
    ["Line width", "width", [[0.03, "Thin"], [0.045, "Normal"], [0.065, "Thick"]], 0.045],
    ["Colour", "color", [["cycle", "Cycle"], [0.04, "Orange"], [0.0, "Red"], [0.3, "Green"], [0.58, "Blue"], [0.78, "Purple"], ["white", "White"]], "cycle"],
  ],
};
Screensavers.savers.gyroid = (host) => {
  const o = Screensavers.options("gyroid");
  const { c, fit } = Screensavers.canvas(host);
  const gl = c.getContext("webgl", { antialias: false, alpha: false });
  if (!gl) { c.remove(); throw new Error("no WebGL"); }
  const vs = "attribute vec2 aP; void main() { gl_Position = vec4(aP, 0.0, 1.0); }";
  const fs = `precision highp float;
    uniform float uZ, uCell, uLayer, uHue, uT, uWarp, uWidth, uWhite;
    float gy(vec2 p, float z, out float g) {
      float sx = sin(p.x), cx = cos(p.x), sy = sin(p.y), cy = cos(p.y), sz = sin(z), cz = cos(z);
      vec2 grad = vec2(cx * cy - sz * sx, -sx * sy + cy * cz);
      g = max(length(grad), 0.25);
      return sx * cy + sy * cz + sz * cx;
    }
    // slow lava-lamp warp of the plane (in gyroid units, one cell = 2π), and how far ahead in z each place runs
    vec2 warp(vec2 p, out float dz, out float sc) {
      float t = uT;
      vec2 q = p * 0.11;
      sc = 1.0 + uWarp * 0.28 * sin(q.x * 0.9 + t * 0.07) * cos(q.y * 1.1 - t * 0.05);   // cells swell and shrink
      vec2 w = vec2(sin(q.y * 1.3 + t * 0.11) + 0.6 * sin(q.x * 2.1 - q.y * 0.7 + t * 0.17),
                    cos(q.x * 1.2 - t * 0.09) + 0.6 * cos(q.y * 1.9 + q.x * 0.8 - t * 0.13));
      dz = uWarp * 1.6 * sin(q.x * 0.8 + q.y * 0.6 + t * 0.06) * cos(q.y * 0.9 - t * 0.08);
      return p * sc + w * 2.2 * uWarp;
    }
    // distance in pixels from the gyroid line at height z
    float line(vec2 px, float z) {
      float dz, sc;
      vec2 p = warp(px / uCell * 6.2831853, dz, sc);
      float g, f = gy(p, z + dz, g);
      return abs(f) / (g * sc) * uCell / 6.2831853;
    }
    vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
    void main() {
      vec2 px = gl_FragCoord.xy;
      float w = uCell * uWidth;                // extrusion width in pixels
      vec3 col = vec3(0.02, 0.02, 0.025);
      vec2 q = px / uCell;
      // the colour drifts a little across the screen too, like light through wax
      vec3 fil = mix(hue(uHue + 0.06 * sin(q.x * 0.35 + uT * 0.05) * cos(q.y * 0.3 - uT * 0.04)), vec3(1.0), mix(0.15, 1.0, uWhite));
      // the layers below fade out under the current one
      for (int k = 3; k >= 1; k--) {
        float a = smoothstep(w, w * 0.4, line(px, uZ - float(k) * uLayer));
        col = mix(col, fil * (0.5 - 0.12 * float(k)), a * 0.8);
      }
      col = mix(col, fil * 0.9, smoothstep(w, w * 0.4, line(px, uZ)));
      gl_FragColor = vec4(col, 1.0);
    }`;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aP = gl.getAttribLocation(prog, "aP");
  gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
  const U = {}; for (const n of ["uZ", "uCell", "uLayer", "uHue", "uT", "uWarp", "uWidth", "uWhite"]) U[n] = gl.getUniformLocation(prog, n);

  // a layer is 1/24 of a gyroid period (about what 0.2 mm layers in 5 mm cells look like); a quarter layer per frame
  const LAYER = (Math.PI * 2) / 24, FPS = o.fps, PER_FRAME = o.speed;
  const cycle = o.color === "cycle";
  let t = 0, hue = cycle ? Math.random() : typeof o.color === "number" ? o.color : 0, shown = -1;
  const stop = Screensavers.loop((dt) => {
    const resized = fit();
    t += dt;
    if (cycle) hue = (hue + dt / 240) % 1; // the "filament" colour changes over a few minutes
    const frame = Math.floor(t * FPS);
    if (frame === shown && !resized) return; // the canvas keeps the last frame
    shown = frame;
    const W = c.width, H = c.height;
    gl.viewport(0, 0, W, H);
    gl.uniform1f(U.uCell, Math.min(W, H) * o.cell);
    gl.uniform1f(U.uWarp, o.warp);
    gl.uniform1f(U.uWidth, o.width);
    gl.uniform1f(U.uWhite, o.color === "white" ? 1 : 0);
    gl.uniform1f(U.uLayer, LAYER);
    gl.uniform1f(U.uZ, ((frame * PER_FRAME) % 24) * LAYER); // the gyroid repeats every 2π in z
    gl.uniform1f(U.uT, (frame / FPS) % 36000);
    gl.uniform1f(U.uHue, hue);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
  return () => { stop(); const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); c.remove(); };
};
