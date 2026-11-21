/* Rakerscreen Bed Mesh panel (KlipperScreen bed_mesh.py, plus a heat map of the mesh).
   Left: the mesh drawn as a heat map (the active mesh, or a profile you tap). Right: the profiles (load, delete),
   then Calibrate, Clear and Save as. Klipper keeps profiles in printer.cfg only after SAVE_CONFIG. */
"use strict";

Panels.bed_mesh = class extends Panel {
  constructor(app, title) {
    super(app, title || "Bed Mesh");
    this.view = null; // profile name being previewed; null = the active mesh
    this.canvas = el("canvas", { class: "bm-canvas" });
    this.info = el("div", { class: "bm-info" });
    this.list = el("div", { class: "bm-list scroll" });
    this.B = {
      cal: Button("bed-mesh", "Calibrate", "color3", { lines: 1, onclick: (e, b) => this.calibrate(b) }),
      clear: Button("cancel", "Clear", "color2", { lines: 1, onclick: (e, b) => this.gcode("BED_MESH_CLEAR", b) }),
      save: Button("complete", "Save as", "color4", { lines: 1, onclick: () => this.saveAs() }),
    };
    const left = el("div", { class: "bm-left" }, el("div", { class: "bm-map" }, this.canvas), this.info);
    const right = el("div", { class: "bm-right" }, this.list, el("div", { class: "bm-buttons" }, this.B.cal, this.B.clear, this.B.save));
    this.el.append(el("div", { class: "bm fill" }, left, right));
    this.canvas.addEventListener("click", () => { if (this.view) { this.view = null; this.render(); } });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas.parentNode);
    this.render();
  }
  get mesh() { return this.p.stat("bed_mesh") || {}; }
  update(data) { if (data.bed_mesh) this.render(); }

  /** The matrix and bounds shown: a profile's points, or the active probed mesh. */
  shown() {
    const m = this.mesh, prof = this.view && (m.profiles || {})[this.view];
    if (prof) {
      const mp = prof.mesh_params || {};
      return { z: prof.points, min: [mp.min_x, mp.min_y], max: [mp.max_x, mp.max_y], name: this.view, active: this.view === m.profile_name };
    }
    const z = m.probed_matrix;
    return { z: z && z.length && z[0].length ? z : null, min: m.mesh_min, max: m.mesh_max, name: m.profile_name || "", active: true };
  }

  render() {
    const m = this.mesh, profiles = Object.keys(m.profiles || {}).sort(), s = this.shown();
    this.list.innerHTML = "";
    if (!profiles.length) this.list.append(el("div", { class: "desc", style: { padding: ".5em" } }, "No saved profiles. Calibrate, then Save as."));
    for (const name of profiles) {
      const active = name === m.profile_name, viewing = name === this.view;
      const z = (m.profiles[name].points || []).flat(), range = z.length ? Math.max(...z) - Math.min(...z) : null;
      this.list.append(el("div", { class: `bm-prof${viewing ? " viewing" : ""}` },
        Button(null, `${active ? "● " : ""}${name}${range !== null ? `
${range.toFixed(3)} mm` : ""}`, active ? "selected" : null,
          { onclick: () => { this.view = viewing ? null : name; this.render(); } }),
        Button("load", null, "color3", { onclick: (e, b) => this.gcode(`BED_MESH_PROFILE LOAD="${name}"`, b) }),
        Button("delete", null, "color2", { onclick: () => this.remove(name) })));
    }
    const z = s.z ? s.z.flat() : [];
    const f = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(3) : "–");
    this.info.innerHTML = "";
    const head = this.view ? `Profile ${s.name}${s.active ? " (active)" : " (not loaded)"} · tap the map for the active mesh`
      : s.z ? `Active mesh${s.name ? `: ${s.name}` : ""}` : "No mesh loaded";
    this.info.append(el("div", { class: "bm-head" }, head));
    if (z.length) {
      const lo = Math.min(...z), hi = Math.max(...z), mean = z.reduce((a, b) => a + b, 0) / z.length;
      this.info.append(el("div", { class: "hs-kv" },
        el("span", {}, "Range"), el("b", {}, `${f(hi - lo)} mm`),
        el("span", {}, "Low · high"), el("b", {}, `${f(lo)} · ${f(hi)}`),
        el("span", {}, "Mean"), el("b", {}, f(mean)),
        el("span", {}, "Points"), el("b", {}, `${s.z[0].length} × ${s.z.length}`)));
    }
    this.B.save.disabled = !(m.probed_matrix && m.probed_matrix.length && m.probed_matrix[0].length);
    this.B.clear.disabled = !m.profile_name && this.B.save.disabled;
    this.draw();
  }

  /** Heat map: row 0 is the front (min Y), drawn at the bottom. Blue low, red high, white at 0. */
  draw() {
    const c = this.canvas, box = c.parentNode, s = this.shown();
    const dpr = window.devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    c.width = W * dpr; c.height = H * dpr; c.style.width = `${W}px`; c.style.height = `${H}px`;
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!s.z) { g.fillStyle = "rgba(255,255,255,.4)"; g.font = "14px sans-serif"; g.textAlign = "center"; g.fillText("No mesh", W / 2, H / 2); return; }
    const rows = s.z.length, cols = s.z[0].length, z = s.z.flat();
    const amp = Math.max(1e-3, ...z.map(Math.abs));
    // keep the bed's aspect ratio when the bounds are known
    const bw = s.max && s.min ? s.max[0] - s.min[0] : cols, bh = s.max && s.min ? s.max[1] - s.min[1] : rows;
    const aspect = bw > 0 && bh > 0 ? bw / bh : cols / rows;
    const pad = 4, barW = 46;
    let w = W - pad * 2 - barW, h = w / aspect;
    if (h > H - pad * 2) { h = H - pad * 2; w = h * aspect; }
    const x0 = pad + (W - barW - pad * 2 - w) / 2, y0 = (H - h) / 2, cw = w / cols, ch = h / rows;
    const col = (v) => {
      const t = Math.max(-1, Math.min(1, v / amp));
      const a = Math.abs(t), base = t < 0 ? [40, 110, 230] : [230, 60, 40];
      return `rgb(${base.map((q) => Math.round(255 + (q - 255) * a)).join(",")})`;
    };
    const fs = Math.max(8, Math.min(14, cw / 4.2, ch / 2.2));
    g.font = `${fs}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
      const v = s.z[r][k], x = x0 + k * cw, y = y0 + (rows - 1 - r) * ch;
      g.fillStyle = col(v); g.fillRect(x, y, cw + 0.5, ch + 0.5);
      if (cw > 26 && ch > 14) { g.fillStyle = Math.abs(v / amp) > 0.6 ? "#fff" : "#111"; g.fillText(v.toFixed(cw > 40 ? 3 : 2), x + cw / 2, y + ch / 2); }
    }
    g.strokeStyle = "rgba(255,255,255,.35)"; g.strokeRect(x0, y0, w, h);
    g.fillStyle = "rgba(255,255,255,.6)"; g.font = "10px sans-serif"; g.textAlign = "left";
    g.fillText("front", x0 + 2, y0 + h - 8);
    // colour bar ±amp
    const bx = W - barW + 12, by = y0, bh2 = h;
    for (let i = 0; i < bh2; i++) { g.fillStyle = col(amp * (1 - (2 * i) / bh2)); g.fillRect(bx, by + i, 8, 1.5); }
    g.fillStyle = "rgba(255,255,255,.8)"; g.textAlign = "left";
    g.fillText(`+${amp.toFixed(2)}`, bx - 10, by - 2 < 6 ? 6 : by - 2);
    g.fillText("0", bx + 11, by + bh2 / 2);
    g.fillText(`−${amp.toFixed(2)}`, bx - 10, Math.min(H - 4, by + bh2 + 8));
  }

  calibrate(btn) {
    const cmds = this.p.availableCommands || {};
    const run = (extra) => {
      const lines = [];
      if ((this.p.stat("toolhead", "homed_axes") || "") !== "xyz") lines.push("G28");
      if ("QUAD_GANTRY_LEVEL" in cmds && !this.p.stat("quad_gantry_level", "applied")) lines.push("QUAD_GANTRY_LEVEL", "G28 Z");
      if ("Z_TILT_ADJUST" in cmds && !this.p.stat("z_tilt", "applied")) lines.push("Z_TILT_ADJUST", "G28 Z");
      lines.push(`BED_MESH_CALIBRATE${extra}`);
      this.view = null;
      this.gcode(lines.join("\n"), btn);
    };
    const name = (this.mesh.profile_name && this.mesh.profile_name !== "adaptive") ? this.mesh.profile_name : "default";
    this.app.dialog("Calibrate mesh", [
      { name: "Full bed", style: "dialog-primary", cb: () => run(` PROFILE="${name}"`) },
      { name: "Adaptive", style: "dialog-default", cb: () => run(" ADAPTIVE=1") },
      { name: "Cancel", style: "dialog-error" }],
      `Homes first if needed${"QUAD_GANTRY_LEVEL" in cmds || "Z_TILT_ADJUST" in cmds ? " and levels the gantry" : ""}, then probes the bed.\n\nFull bed saves to profile "${name}". Adaptive probes only where the current print's objects are.`);
  }
  saveAs() {
    Input.prompt({
      title: "Save mesh as", value: this.mesh.profile_name || "default", ok: "Save",
      desc: "Klipper keeps it in printer.cfg after Save Config (which restarts Klipper).",
      validate: (v) => (/^[\w.-]+$/.test(v.trim()) ? null : "Letters, numbers, - _ . only"),
      onSubmit: (v) => this.persist(`BED_MESH_PROFILE SAVE="${v.trim()}"`, `Saved as ${v.trim()}`),
    });
  }
  remove(name) {
    this.app.dialog("Delete profile", [
      { name: "Delete", style: "dialog-error", cb: () => { if (this.view === name) this.view = null; this.persist(`BED_MESH_PROFILE REMOVE="${name}"`, `Deleted ${name}`); } },
      { name: "Cancel", style: "dialog-default" }], `Delete mesh profile "${name}"?`);
  }
  /** Run a profile change, then offer SAVE_CONFIG so it sticks. */
  async persist(script, done) {
    try { await this.mr.gcode(script); } catch (e) { this.app.popup(e.message || String(e)); return; }
    this.app.dialog(done, [
      { name: "Save Config", style: "dialog-primary", cb: () => this.gcode("SAVE_CONFIG") },
      { name: "Later", style: "dialog-default" }],
      "Write it to printer.cfg now? Save Config restarts Klipper (not during a print).");
  }
};
