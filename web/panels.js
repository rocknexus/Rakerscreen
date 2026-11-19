/* Rakerscreen panels. Each class mirrors the KlipperScreen panel of the same name (panels/*.py). */
"use strict";

const Panels = {};

class Panel {
  constructor(app, title) {
    this.app = app;
    this.p = app.printer;
    this.mr = app.mr;
    this.title = title || "";
    this.el = el("div", { class: "panel" });
  }
  get vertical() { return this.app.vertical; }
  gcode(script, btn) { return this.app.sendAction("printer.gcode.script", { script }, btn); }
}

// ================================================================= splash_screen.py
Panels.splash_screen = class extends Panel {
  constructor(app, title) {
    super(app, title);
    this.text = el("div", { class: "text" }, "Initializing printer...");
    this.actions = el("div", { class: "splash-actions" });
    this.el.append(el("div", { class: "splash-info" }, icon("klipper"), this.text), this.actions);
    this.showButtons();
  }
  setText(t) { this.text.textContent = t; this.showButtons(); }
  showButtons() {
    this.actions.innerHTML = "";
    const connected = this.mr.connected;
    if (connected && this.app.serverInfo && this.app.serverInfo.klippy_connected) {
      this.actions.append(
        Button("refresh", "Klipper Restart", "color1", { onclick: () => this.mr.call("printer.restart").catch(() => {}) }),
        Button("refresh", "Firmware Restart", "color2", { onclick: () => this.mr.call("printer.firmware_restart").catch(() => {}) }),
      );
    }
    this.actions.append(Button("settings", "Menu", "color4", { onclick: () => this.app.showPanel("settings") }));
    this.actions.append(Button("warning", "Report", "color2", { onclick: () => this.app.shareReport() }));
    this.actions.append(Button("load", "Retry", "color3", {
      onclick: () => { if (this.mr.connected) this.app.initKlipper().catch(() => {}); else this.app.connectNow(); },
    }));
  }
};

// ================================================================= menu.py
Panels.menu = class extends Panel {
  constructor(app, title, extra, opts) {
    super(app, title);
    this.items = (opts && opts.items) || [];
    this.scroll = el("div", { class: "scroll fill" });
    this.el.append(this.scroll);
  }
  activate() { this.render(); }
  enabledButtons() {
    const data = this.p.menuData();
    const out = [];
    this.items.forEach((item, i) => {
      if (item.enable && !item.enable(data)) return;
      let iconName = item.icon;
      if (iconName === "notifications" && this.app.notifications.some((n) => n.level >= 3)) iconName = "notifications_important";
      out.push(Button(iconName, item.name, item.style || `color${(i % 4) + 1}`, { onclick: () => this.app.menuItemClicked(item) }));
    });
    return out;
  }
  render(columns, expandLast) {
    const grid = AutoGrid(this.enabledButtons(), columns, expandLast, this.vertical);
    grid.style.height = "100%";
    const rows = parseInt((grid.style.gridTemplateRows.match(/repeat\((\d+)/) || [0, 1])[1]);
    // menu.py: up to 16 items still fit (KlipperScreen shrinks icons to squeeze a 4th row); beyond that, scroll
    if (rows > 4) { grid.style.height = ""; grid.style.gridAutoRows = `${(this.app.content.clientHeight || 300) / 4}px`; grid.style.gridTemplateRows = ""; }
    grid.classList.toggle("rows4", rows >= 4);
    this.scroll.innerHTML = "";
    this.scroll.append(grid);
  }
};

// ================================================================= shared heater list (main_menu.py / temperature.py)
class HeaterList {
  /** tiles: extruders and the bed become big tiles side by side above the list (temperature panel). */
  constructor(app, { onName, onTemp, selectable, tiles, hideChips }) {
    this.app = app; this.p = app.printer;
    this.graph = new HeaterGraph(this.p);
    this.rows = {};
    this.grid = el("div", { class: "heater-grid" }, el("div", { class: "hdr" }), el("div", { class: "hdr label" }, "Temp (°C)"));
    this.tiles = el("div", { class: "heater-tiles" });
    const list = el("div", { class: "scroll heater-list", style: { flex: "0 0 auto", maxHeight: tiles ? "35%" : "60%" } }, this.grid);
    // list keeps its natural height (scrolls only past its max), graph takes the rest
    this.el = el("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%" } }, this.tiles, list, this.graph.canvas);
    const devices = this.p.tempDevices().filter((d) => {
      const n = devName(d);
      // hideChips (main menu, temperature panel) leaves out MCU/host chip sensors: nothing to set there
      const chip = hideChips && d.startsWith("temperature_sensor ") && (/mcu|host|rpi|raspberry/i.test(n) || /temperature_(mcu|host)/.test(this.p.configSection(d).sensor_type || ""));
      return !n.startsWith("_") && !chip && !deviceFiltered(this.p, d) && typeof this.p.stat(d, "temperature") === "number";
    }).sort();
    let listed = 0;
    for (const d of devices) {
      let name = prettify(devName(d));
      if (d === "heater_bed") name = "Heater Bed";
      const asTile = tiles && (d.startsWith("extruder") || d === "heater_bed");
      const nameBtn = Button(deviceIcon(this.p, d), name, null, { side: !asTile, lines: 1, onclick: () => onName(d, nameBtn) });
      nameBtn.style.borderLeftColor = deviceColor(this.p, d);
      const tempBtn = Button(null, "", "temp", { lines: 1, onclick: () => { if (this.p.hasTarget(d)) onTemp(d, tempBtn); } });
      if (asTile) {
        nameBtn.style.borderBottomColor = deviceColor(this.p, d);
        this.tiles.append(el("div", { class: "heater-tile" }, nameBtn, tempBtn));
      } else { this.grid.append(nameBtn, tempBtn); listed++; }
      this.rows[d] = { nameBtn, tempBtn };
    }
    if (!this.tiles.children.length) this.tiles.remove();
    else this.tiles.style.gridTemplateColumns = `repeat(${this.tiles.children.length}, minmax(0, 1fr))`;
    if (tiles && !listed) list.remove();
    if (hideChips) this.graph.only = new Set(Object.keys(this.rows));
    this.refreshVisibility();
    this.update();
  }
  refreshVisibility() {
    for (const [d, r] of Object.entries(this.rows)) r.nameBtn.classList.toggle("graph_label", this.graph.isShowing(d));
    const any = Object.keys(this.rows).some((d) => this.graph.isShowing(d));
    // force must be a real boolean: toggle(name, undefined) flips the class instead of setting it
    this.graph.canvas.classList.toggle("hidden", !any || !!this.hideGraph);
  }
  setGraphHidden(h) { this.hideGraph = h; this.refreshVisibility(); }
  update() {
    const showPower = Settings.get("show_heater_power");
    for (const [d, r] of Object.entries(this.rows)) {
      const t = this.p.stat(d, "temperature"), tg = this.p.stat(d, "target"), pw = this.p.stat(d, "power");
      let s = padNumber(t, 5, 1);
      if (this.p.hasTarget(d) && tg) s += `/${padNumber(tg, 3)}`;
      if (showPower && pw) s += ` ${padNumber(pw * 100, 3)}%`;
      r.tempBtn.setLabel(s);
    }
  }
  start() { this.refreshVisibility(); this.graph.draw(); this.timer = setInterval(() => this.graph.draw(), 5000); }
  stop() { clearInterval(this.timer); }
}

function pidExtra(app, dev) {
  const ctl = (app.printer.configSection(dev).control || "").toLowerCase();
  if (app.printer.isPrinting() || (ctl !== "pid" && ctl !== "mpc")) return null;
  const heater = dev.split(" ").slice(-1)[0];
  const kind = ctl.toUpperCase();
  return {
    icon: "heat-up", label: `Calibrate ${kind}`,
    cb: (temp) => {
      if (temp <= 0) return;
      app.confirmSendAction(`Initiate a ${kind} calibration for: ${heater} @ ${temp} ºC\n\nIt may take more than 5 minutes depending on the heater power.`,
        "printer.gcode.script", { script: `${kind}_CALIBRATE HEATER=${heater} TARGET=${temp}` });
    },
  };
}

// ================================================================= main_menu.py
Panels.main_menu = class extends Panels.menu {
  constructor(app, title, extra, opts) {
    super(app, title, extra, opts);
    this.el.innerHTML = "";
    this.activeHeater = null;
    this.heaters = new HeaterList(app, {
      // tap a heater (tile) to set its temperature; sensors without a target still toggle their graph line
      onName: (d) => { if (this.p.hasTarget(d)) this.showNumpad(d); else { this.heaters.graph.toggle(d); this.heaters.refreshVisibility(); } },
      onTemp: (d) => this.showNumpad(d),
      tiles: true, hideChips: true,
    });
    this.right = el("div", { style: { minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" } }, this.scroll);
    this.layoutGrid();
  }
  layoutGrid() {
    this.el.innerHTML = "";
    const g = this.vertical
      ? Grid(1, 5, [{ w: this.heaters.el, x: 0, y: 0, ch: 3 }, { w: this.right, x: 0, y: 3, ch: 2 }])
      : Grid(2, 1, [{ w: this.heaters.el, x: 0, y: 0 }, { w: this.right, x: 1, y: 0 }]);
    g.classList.add("fill");
    this.el.append(g);
  }
  relayout() { this.layoutGrid(); this.render(); this.heaters.graph.draw(); }
  activate() { this.render(); this.heaters.start(); }
  deactivate() { this.heaters.stop(); if (this.activeHeater) this.hideNumpad(); }
  render() { super.render(this.vertical ? 3 : 2, true); }
  update() { this.heaters.update(); }
  showNumpad(dev) {
    if (this.activeHeater) this.heaters.rows[this.activeHeater].nameBtn.classList.remove("button_active");
    this.activeHeater = dev;
    this.heaters.rows[dev].nameBtn.classList.add("button_active");
    const kp = Keypad((v) => { if (this.app.setTargetTemp(dev, v)) this.hideNumpad(); }, () => this.hideNumpad(), pidExtra(this.app, dev));
    this.right.innerHTML = "";
    this.right.append(kp);
    if (this.vertical) this.heaters.setGraphHidden(true);
    this.app.updateActionBar();
  }
  hideNumpad() {
    if (this.activeHeater && this.heaters.rows[this.activeHeater]) this.heaters.rows[this.activeHeater].nameBtn.classList.remove("button_active");
    this.activeHeater = null;
    this.right.innerHTML = "";
    this.right.append(this.scroll);
    this.heaters.setGraphHidden(false);
    this.app.updateActionBar();
  }
  canGoBack() { return !!this.activeHeater; }
  back() { if (this.activeHeater) { this.hideNumpad(); return true; } return false; }
};

// ================================================================= move.py
Panels.move = class extends Panel {
  constructor(app, title) {
    super(app, title || "Move");
    this.distances = getIncrements("move_distances");
    this.distance = defaultIncrement("move_distances");
    const B = (img, lbl, style, fn) => Button(img, lbl, style, { onclick: (e, b) => fn(b) });
    this.b = {
      "x+": B("arrow-right", "X+", "color1", (b) => this.move("X", "+", b)),
      "x-": B("arrow-left", "X-", "color1", (b) => this.move("X", "-", b)),
      "y+": B("arrow-up", "Y+", "color2", (b) => this.move("Y", "+", b)),
      "y-": B("arrow-down", "Y-", "color2", (b) => this.move("Y", "-", b)),
      "z+": B("z-farther", "Z+", "color3", (b) => this.move("Z", "+", b)),
      "z-": B("z-closer", "Z-", "color3", (b) => this.move("Z", "-", b)),
      home: B("home", "Home", "color4", () => this.home()),
      motors_off: B("motor-off", "Disable Motors", "color4", () => app.confirmSendAction("Are you sure you wish to disable motors?", "printer.gcode.script", { script: "M18" })),
    };
    this.adjust = Button("settings", null, "color2", { side: true, onclick: () => app.showPanel("move_options") });
    this.pos = {};
    // tap a coordinate to type a position to move to (Rakerscreen extra)
    for (const a of ["x", "y", "z"]) {
      this.pos[a] = Button(null, `${a.toUpperCase()}: ?`, null, { onclick: () => this.enterPosition(a) });
      this.pos[a].classList.add("pos-entry");
    }
    this.build();
    this.update({ gcode_move: this.p.stat("gcode_move") || {} });
  }
  build() {
    this.el.innerHTML = "";
    let [zm, zp] = ["z-", "z+"];
    if (Settings.get("invert_z")) [zm, zp] = [zp, zm];
    const b = this.b;
    const items = this.vertical
      ? [{ w: b["x-"], x: 0, y: 1 }, { w: b["x+"], x: 2, y: 1 }, { w: b["y-"], x: 1, y: 1 }, { w: b["y+"], x: 1, y: 0 }, { w: b[zm], x: 0, y: 2 }, { w: b[zp], x: 2, y: 2 }, { w: this.adjust, x: 1, y: 2 }]
      : [{ w: b["x-"], x: 0, y: 1 }, { w: b["x+"], x: 2, y: 1 }, { w: b["y-"], x: 1, y: 1 }, { w: b["y+"], x: 1, y: 0 }, { w: b[zm], x: 3, y: 1 }, { w: b[zp], x: 3, y: 0 }];
    items.push({ w: b.home, x: 0, y: 0 }, { w: b.motors_off, x: 2, y: 0 });
    const grid = Grid(this.vertical ? 3 : 4, this.vertical ? 3 : 2, items);
    const tr = ToggleRow(this.distances, this.distance, (v) => (this.distance = v));
    const bottomItems = [{ w: this.pos.x, x: 0, y: 0 }, { w: this.pos.y, x: 1, y: 0 }, { w: this.pos.z, x: 2, y: 0 }, { w: el("div", { class: "label" }, "Move Distance (mm)"), x: 0, y: 1, cw: 3 }];
    if (!this.vertical) bottomItems.push({ w: this.adjust, x: 3, y: 0, ch: 2 });
    const bottom = Grid(this.vertical ? 3 : 4, 2, bottomItems);
    for (const k of ["x", "y", "z"]) this.pos[k].style.margin = "0";
    this.adjust.style.justifyContent = "center";
    const wrap = el("div", { class: "grid fill", style: { gridTemplateRows: "repeat(5, minmax(0,1fr))" } });
    grid.style.gridRow = "1 / span 3"; bottom.style.gridRow = "4"; tr.el.style.gridRow = "5";
    wrap.append(grid, bottom, tr.el);
    this.el.append(wrap);
  }
  relayout() { this.build(); this.update({ gcode_move: this.p.stat("gcode_move") || {} }); }
  update(data) {
    if (!data.gcode_move && !(data.toolhead && data.toolhead.homed_axes !== undefined)) return;
    const homed = this.p.stat("toolhead", "homed_axes") || "";
    const pos = this.p.stat("gcode_move", "gcode_position");
    ["x", "y", "z"].forEach((a, i) => {
      if (!homed.includes(a)) this.pos[a].setLabel(`${a.toUpperCase()}: ?`);
      else if (pos) this.pos[a].setLabel(`${a.toUpperCase()}: ${pos[i].toFixed(2)}`);
    });
  }
  speedFor(a) {
    const cfg = this.p.configSection("printer");
    const maxZ = parseFloat(cfg.max_z_velocity || cfg.max_velocity || "10");
    return 60 * Math.max(1, a === "z" ? Math.min(Settings.get("move_speed_z"), maxZ) : Settings.get("move_speed_xy"));
  }
  /** Limits of one axis in G-code coordinates (toolhead limits minus the G-code offset), or null. */
  axisLimits(i) {
    const th = this.p.stat("toolhead") || {};
    const off = (this.p.stat("gcode_move", "homing_origin") || [])[i] || 0;
    let lo = th.axis_minimum ? th.axis_minimum[i] : undefined, hi = th.axis_maximum ? th.axis_maximum[i] : undefined;
    if (lo === undefined || hi === undefined) {
      const st = this.p.configSection(`stepper_${"xyz"[i]}`);
      lo = st.position_min !== undefined ? parseFloat(st.position_min) : 0;
      hi = st.position_max !== undefined ? parseFloat(st.position_max) : undefined;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
    return [Math.round((lo - off) * 1000) / 1000, Math.round((hi - off) * 1000) / 1000];
  }
  enterPosition(a) {
    const A = a.toUpperCase(), i = "xyz".indexOf(a);
    const homed = this.p.stat("toolhead", "homed_axes") || "";
    if (!homed.includes(a)) { this.app.popup(`Home ${A} before moving to a position`, 2); return; }
    const pos = this.p.stat("gcode_move", "gcode_position");
    const cur = pos ? Math.round(pos[i] * 100) / 100 : undefined;
    const lim = this.axisLimits(i);
    Input.number({
      title: `Move ${A} to`, value: cur, unit: "mm", decimals: 3, ok: "Move",
      min: lim ? lim[0] : undefined, max: lim ? lim[1] : undefined,
      desc: cur !== undefined ? `Current ${A}: ${cur.toFixed(2)} mm` : null,
      onSubmit: (v) => {
        // absolute move, then back to the mode the printer was in
        let script = `G90\nG0 ${A}${v} F${this.speedFor(a)}`;
        if (!this.p.stat("gcode_move", "absolute_coordinates")) script += "\nG91";
        this.gcode(script, this.pos[a]);
      },
    });
  }
  move(axis, dir, btn) {
    const a = axis.toLowerCase();
    if (Settings.get(`invert_${a}`) && a !== "z") dir = dir === "+" ? "-" : "+";
    const speed = this.speedFor(a);
    let script = `G91\nG0 ${a}${dir}${this.distance} F${speed}`;
    if (this.p.stat("gcode_move", "absolute_coordinates")) script += "\nG90";
    this.gcode(script, btn);
  }
  home() {
    if ((this.p.configSection("printer").kinematics || "").includes("delta")) { this.gcode("G28"); return; }
    this.app.showPanel("menu", "Homing", null, { items: MENUS["move homing"] });
  }
};

// ================================================================= temperature.py
Panels.temperature = class extends Panel {
  constructor(app, title, extra) {
    super(app, title || "Temperature");
    this.active = [];
    this.extraSelection = extra;
    this.numpadDev = null;
    this.tempdeltas = getIncrements("temp_deltas");
    this.tempdelta = defaultIncrement("temp_deltas");
    this.showPreheat = !this.p.isPrinting();
    this.heaters = new HeaterList(app, { onName: (d) => this.selectHeater(d), onTemp: (d) => this.showNumpad(d), tiles: true, hideChips: true });
    this.right = el("div", { style: { minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" } });
    this.buildRight();
    this.layoutGrid();
  }
  layoutGrid() {
    this.el.innerHTML = "";
    const g = this.vertical
      ? Grid(1, 5, [{ w: this.heaters.el, x: 0, y: 0, ch: 3 }, { w: this.right, x: 0, y: 3, ch: 2 }])
      : Grid(2, 1, [{ w: this.heaters.el, x: 0, y: 0 }, { w: this.right, x: 1, y: 0 }]);
    g.classList.add("fill");
    this.el.append(g);
  }
  relayout() { this.layoutGrid(); this.heaters.graph.draw(); }
  setExtra(extra) { this.extraSelection = extra; }
  activate() { this.heaters.start(); this.setSelection(); }
  deactivate() { this.heaters.stop(); if (this.numpadDev) this.hideNumpad(); }
  update() { this.heaters.update(); }
  setSelection() {
    let sel = [];
    if (this.extraSelection) sel = [this.extraSelection];
    else if (!this.p.isPrinting()) sel = this.p.tempDevices();
    else { const c = this.p.stat("toolhead", "extruder"); if (c) sel = [c]; }
    sel = sel.filter((d) => this.p.hasTarget(d) && this.heaters.rows[d]);
    this.active = sel;
    for (const [d, r] of Object.entries(this.heaters.rows)) r.nameBtn.classList.toggle("button_active", sel.includes(d));
    this.extraSelection = null;
  }
  selectHeater(d) {
    if (this.numpadDev || !this.p.hasTarget(d)) return;
    const i = this.active.indexOf(d);
    if (i >= 0) this.active.splice(i, 1); else this.active.push(d);
    this.heaters.rows[d].nameBtn.classList.toggle("button_active", i < 0);
  }
  buildRight() {
    this.right.innerHTML = "";
    const cooldown = Button("cool-down", "Cooldown", "color4", { side: true, onclick: () => this.setTemperature("cooldown") });
    // toggles between presets and +/- steps; lit while the steps are showing
    const adjust = Button("plus-minus", "Nudge", "color3", { side: true, onclick: () => { this.showPreheat = !this.showPreheat; this.buildRight(); } });
    adjust.classList.toggle("toggle_active", !this.showPreheat);
    adjust.style.justifyContent = "center";
    const body = this.showPreheat ? this.preheat() : this.deltaAdjust();
    const g = Grid(3, 3, [{ w: cooldown, x: 0, y: 0, cw: 2 }, { w: adjust, x: 2, y: 0 }, { w: body, x: 0, y: 1, cw: 3, ch: 2 }]);
    g.classList.add("fill");
    this.right.append(g);
  }
  preheat() {
    const opts = Object.keys(Settings.get("preheat"));
    const rows = Math.max(1, Math.ceil(opts.length / 2));
    const g = Grid(2, rows, opts.map((o, i) => ({ w: Button(null, o, `color${(i % 4) + 1}`, { onclick: () => this.setTemperature(o) }), x: i % 2, y: Math.floor(i / 2) })));
    g.style.height = rows > 3 ? `${rows * 4}em` : "100%";
    return el("div", { class: "scroll" }, g);
  }
  deltaAdjust() {
    const inc = Button("increase", null, "color1", { onclick: () => this.incremental("+") });
    const dec = Button("decrease", null, "color3", { onclick: () => this.incremental("-") });
    const tr = ToggleRow(this.tempdeltas, this.tempdelta, (v) => (this.tempdelta = v));
    const lbl = el("div", { class: "label" }, "Temperature (°C)");
    return this.vertical
      ? Grid(2, 2, [{ w: dec, x: 0, y: 0 }, { w: inc, x: 1, y: 0 }, { w: tr.el, x: 0, y: 1, cw: 2 }])
      : Grid(2, 6, [{ w: dec, x: 0, y: 0, ch: 3 }, { w: inc, x: 1, y: 0, ch: 3 }, { w: lbl, x: 0, y: 3, cw: 2 }, { w: tr.el, x: 0, y: 4, cw: 2, ch: 2 }]);
  }
  incremental(dir) {
    if (!this.active.length) { this.app.popup("Nothing selected"); return; }
    for (const h of this.active) {
      let target = (this.p.stat(h, "target") || 0) + (dir === "+" ? 1 : -1) * parseInt(this.tempdelta);
      const max = parseFloat(this.p.configSection(h).max_temp || "9999");
      if (target > max) { target = max; this.app.popup(`Can't set above the maximum: ${target}`); }
      this.app.setTargetTemp(h, Math.max(0, target));
    }
  }
  setTemperature(setting) {
    if (!this.active.length) { this.app.popup("Nothing selected"); return; }
    const opts = setting === "cooldown" ? {} : Settings.get("preheat")[setting] || {};
    for (const h of this.active) {
      const name = devName(h);
      let target = opts[name] ?? opts[h];
      if (target === undefined) {
        if (setting === "cooldown" && !h.startsWith("temperature_fan ")) target = 0;
        else if (h.startsWith("extruder")) target = opts.extruder;
        else if (h === "heater_bed") target = opts.bed;
        else if (h.startsWith("heater_generic ")) target = opts.heater_generic;
        else if (h.startsWith("temperature_fan ")) target = opts.temperature_fan;
      }
      if (target !== undefined && target !== null) this.app.setTargetTemp(h, target);
    }
    if (opts.gcode) setTimeout(() => this.gcode(opts.gcode), 250);
  }
  showNumpad(dev) {
    this.numpadDev = dev;
    for (const [d, r] of Object.entries(this.heaters.rows)) r.nameBtn.classList.toggle("button_active", d === dev);
    const kp = Keypad((v) => { if (this.app.setTargetTemp(dev, v)) this.hideNumpad(); }, () => this.hideNumpad(), pidExtra(this.app, dev));
    this.right.innerHTML = "";
    this.right.append(kp);
    this.app.updateActionBar();
  }
  hideNumpad() {
    this.numpadDev = null;
    this.buildRight();
    for (const [d, r] of Object.entries(this.heaters.rows)) r.nameBtn.classList.toggle("button_active", this.active.includes(d));
    this.app.updateActionBar();
  }
  canGoBack() { return !!this.numpadDev; }
  back() { if (this.numpadDev) { this.hideNumpad(); return true; } return false; }
};

// ================================================================= extrude.py
Panels.extrude = class extends Panel {
  constructor(app, title) {
    super(app, title || "Extrude");
    this.current = this.p.stat("toolhead", "extruder");
    const macros = this.p.macros.map((m) => m.toUpperCase());
    this.loadMacro = macros.some((m) => m.includes("LOAD_FILAMENT") && !m.includes("UNLOAD"));
    this.unloadMacro = macros.some((m) => m.includes("UNLOAD_FILAMENT"));
    this.speeds = getIncrements("extrude_speeds");
    this.distances = getIncrements("extrude_distances");
    this.distance = parseFloat(defaultIncrement("extrude_distances"));
    this.speed = parseFloat(defaultIncrement("extrude_speeds"));
    this.btn = {
      extrude: Button("extrude", "Extrude", "color4", { onclick: (e, b) => this.check("extrude", "+", b) }),
      load: Button("arrow-down", "Load", "color3", { onclick: (e, b) => this.check("load", "+", b) }),
      unload: Button("arrow-up", "Unload", "color2", { onclick: (e, b) => this.check("load", "-", b) }),
      retract: Button("retract", "Retract", "color1", { onclick: (e, b) => this.check("extrude", "-", b) }),
      temperature: Button("heat-up", "Temperature", "color4", { onclick: () => app.showPanel("temperature") }),
    };
    this.ext = {};
    const xbox = el("div", { class: "grid", style: { gridAutoFlow: "column", gridAutoColumns: "minmax(0,1fr)" } });
    for (const e of this.p.tools.slice(0, 4)) {
      const n = this.p.toolNumber(e);
      // tap the active extruder to set its temperature; tap another one to switch to it
      this.ext[e] = this.p.extruderCount === 1
        ? Button("extruder", "", null, { onclick: () => this.showTempEntry(e) })
        : Button(`extruder-${n}`, `T${n}`, null, { onclick: (ev, b) => (e === this.current ? this.showTempEntry(e) : this.changeExtruder(e, b)) });
      this.ext[e].classList.toggle("button_active", e === this.current);
      xbox.append(this.ext[e]);
    }
    xbox.append(this.btn.temperature);
    const dist = ToggleRow(this.distances, defaultIncrement("extrude_distances"), (v) => (this.distance = parseFloat(v)), undefined, this.vertical);
    const spd = ToggleRow(this.speeds, defaultIncrement("extrude_speeds"), (v) => (this.speed = parseFloat(v)), undefined, this.vertical);
    // tap a label to edit its steps (same editor as Settings → Increments)
    const incLabel = (text, key) => el("div", { class: "label fill inc-edit", onclick: () => app.editIncrements(key) }, text, icon("edit"));
    const distbox = el("div", { style: { display: "flex", flexDirection: "column", justifyContent: "flex-end" } }, incLabel("Distance (mm)", "extrude_distances"), dist.el);
    const speedbox = el("div", { style: { display: "flex", flexDirection: "column", justifyContent: "flex-end" } }, incLabel("Speed (mm/s)", "extrude_speeds"), spd.el);
    // filament sensors: a banner across the top of the page, tap one to turn it on or off
    this.sensors = el("div", { class: "sensor-banner" });
    this.sensorEls = {};
    for (const s of this.p.filamentSensors.slice(0, 9)) {
      const name = s.split(" ").slice(1).join(" ").trim();
      const state = el("span", { class: "state" });
      const sw = el("div", { class: "switch" });
      const box = el("div", { class: "filament_sensor", onclick: () => this.toggleSensor(s, name) }, el("span", { class: "name" }, prettify(name)), state, sw);
      this.sensorEls[s] = { box, sw, state };
      this.sensors.append(box);
    }
    const b = this.btn;
    const g = this.vertical
      ? Grid(4, 6, [{ w: xbox, x: 0, y: 0, cw: 4 }, { w: b.extrude, x: 0, y: 1, cw: 2 }, { w: b.retract, x: 2, y: 1, cw: 2 }, { w: b.load, x: 0, y: 2, cw: 2 }, { w: b.unload, x: 2, y: 2, cw: 2 }, { w: distbox, x: 0, y: 4, cw: 4 }, { w: speedbox, x: 0, y: 5, cw: 4 }])
      : Grid(4, 3, [{ w: xbox, x: 0, y: 0, cw: 4 }, { w: b.extrude, x: 0, y: 1 }, { w: b.load, x: 1, y: 1 }, { w: b.unload, x: 2, y: 1 }, { w: b.retract, x: 3, y: 1 }, { w: distbox, x: 0, y: 2, cw: 2 }, { w: speedbox, x: 2, y: 2, cw: 2 }]);
    if (!this.vertical) g.style.gridTemplateRows = "1fr 1fr auto";
    g.classList.add("fill");
    this.main = el("div", { class: "fill", style: { display: "flex", flexDirection: "column" } }, this.p.filamentSensors.length ? this.sensors : null, g);
    this.el.append(this.main);
    this.update(Object.fromEntries(this.p.tools.map((t) => [t, {}])));
    this.updateSensors();
  }
  activate() { this.enable(this.p.state === "ready" || this.p.state === "paused"); }
  enable(on) { for (const k of ["extrude", "load", "unload", "retract"]) this.btn[k].disabled = !on; }
  update(data) {
    for (const x of this.p.tools) {
      if (!(x in data) || !this.ext[x]) continue;
      const t = this.p.stat(x, "temperature"), tg = this.p.stat(x, "target");
      if (typeof t !== "number") continue;
      let s = `${t.toFixed(0)}`;
      if (tg) s += `/${tg.toFixed(0)}`;
      s += "°";
      if (this.p.extruderCount > 1) s = `T${this.p.toolNumber(x)} ${s}`;
      this.ext[x].setLabel(s);
    }
    if (data.toolhead && data.toolhead.extruder && data.toolhead.extruder !== this.current) {
      this.current = data.toolhead.extruder;
      for (const [e, b] of Object.entries(this.ext)) b.classList.toggle("button_active", e === this.current);
    }
    if (this.p.filamentSensors.some((s) => s in data)) this.updateSensors();
    if (this.tempEntry && this.tempEntry in data) this.updateTempHead();
  }
  onGcodeResponse(t) {
    if (t.includes("action:cancel") || t.includes("action:paused")) this.enable(true);
    else if (t.includes("action:resumed")) this.enable(false);
  }
  updateSensors() {
    for (const [s, { box, sw, state }] of Object.entries(this.sensorEls)) {
      const en = !!this.p.stat(s, "enabled"), det = !!this.p.stat(s, "filament_detected");
      sw.classList.toggle("on", en);
      box.classList.toggle("filament_sensor_detected", en && det);
      box.classList.toggle("filament_sensor_empty", en && !det);
      box.classList.toggle("filament_sensor_off", !en);
      state.textContent = !en ? "Off" : det ? "Filament detected" : "No filament";
    }
  }
  toggleSensor(s, name) { this.gcode(`SET_FILAMENT_SENSOR SENSOR=${name} ENABLE=${this.p.stat(s, "enabled") ? 0 : 1}`); }

  /** Extruder temperature: presets on the left, keypad on the right (Rakerscreen extra). */
  showTempEntry(ext) {
    if (this.tempEntry) this.hideTempEntry();
    this.tempEntry = ext;
    const set = (v) => { if (this.app.setTargetTemp(ext, v)) this.hideTempEntry(); };
    const presets = Object.entries(Settings.get("preheat") || {}).filter(([, o]) => typeof o.extruder === "number");
    const list = el("div", { class: "scroll temp-presets" },
      ...presets.map(([n, o], i) => Button(null, `${n}  ${o.extruder}°`, `color${(i % 4) + 1}`, { lines: 1, onclick: () => set(o.extruder) })),
      Button(null, "Off  0°", "color4", { lines: 1, onclick: () => set(0) }));
    const name = this.p.extruderCount > 1 ? `T${this.p.toolNumber(ext)}` : "Extruder";
    this.tempHead = el("div", { class: "label" });
    const left = el("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 } }, this.tempHead, list);
    const kp = Keypad((v) => set(v), () => this.hideTempEntry(), pidExtra(this.app, ext));
    const g = Grid(2, 1, [{ w: left, x: 0, y: 0 }, { w: kp, x: 1, y: 0 }]);
    g.classList.add("fill");
    this.tempView = g;
    this.tempName = name;
    this.updateTempHead();
    this.main.style.display = "none";
    this.el.append(g);
    this.app.updateActionBar();
  }
  updateTempHead() {
    if (!this.tempEntry || !this.tempHead) return;
    const t = this.p.stat(this.tempEntry, "temperature"), tg = this.p.stat(this.tempEntry, "target");
    this.tempHead.textContent = `${this.tempName}: ${typeof t === "number" ? t.toFixed(0) : "?"}° → ${tg ? tg.toFixed(0) : 0}°`;
  }
  hideTempEntry() {
    this.tempEntry = null;
    if (this.tempView) { this.tempView.remove(); this.tempView = null; }
    this.main.style.display = "flex";
    this.app.updateActionBar();
  }
  deactivate() { if (this.tempEntry) this.hideTempEntry(); }
  canGoBack() { return !!this.tempEntry; }
  back() { if (this.tempEntry) { this.hideTempEntry(); return true; } return false; }
  changeExtruder(e, b) { this.gcode(`T${this.p.toolNumber(e)}`, b); }
  check(method, dir, btn) {
    const ext = this.current || "extruder";
    const temp = this.p.stat(ext, "temperature") || 0, target = this.p.stat(ext, "target") || 0;
    const min = parseFloat(this.p.configSection(ext).min_extrude_temp || "170");
    const pre = temp < min && target > min ? `M109 S${target}\n` : "";
    if (method === "extrude") {
      this.mr.gcode("M83").catch(() => {});
      this.gcode(`${pre}G1 E${dir}${this.distance} F${Math.round(this.speed * 60)}`, btn);
    } else if (dir === "-") {
      if (!this.unloadMacro) this.app.popup("Macro UNLOAD_FILAMENT not found");
      else this.gcode(`${pre}UNLOAD_FILAMENT SPEED=${Math.round(this.speed * 60)}`, btn);
    } else if (!this.loadMacro) this.app.popup("Macro LOAD_FILAMENT not found");
    else this.gcode(`${pre}LOAD_FILAMENT SPEED=${Math.round(this.speed * 60)}`, btn);
  }
};

// ================================================================= fan.py
Panels.fan = class extends Panel {
  constructor(app, title) {
    super(app, title || "Fan");
    this.devices = {};
    const list = el("div", { style: { display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "100%" } });
    const fans = this.p.fans.filter((f) => !devName(f).startsWith("_")).sort((a, b) => (a === "fan" ? -1 : b === "fan" ? 1 : a.localeCompare(b)));
    for (const fan of fans) {
      const changeable = fan === "fan" || fan.startsWith("fan_generic");
      const name = fan === "fan" ? "Part Fan" : fan.split(" ").slice(1).join(" ");
      const ctl = el("div", { class: "ctl" });
      const d = { changeable };
      if (changeable) {
        const scale = el("input", { type: "range", class: "scale", min: "0", max: "100", step: "1" });
        const val = el("span", { class: "scale-val" });
        scale.addEventListener("input", () => { this.paint(d, scale.value); d.dragging = true; });
        scale.addEventListener("change", () => { d.dragging = false; this.setSpeed(fan, parseInt(scale.value)); });
        Object.assign(d, { scale, val });
        ctl.append(Button("cancel", null, "color1", { onclick: () => { this.paint(d, 0); this.setSpeed(fan, 0); } }), scale, val,
          Button("fan-on", "Max", "color2", { onclick: () => { this.paint(d, 100); this.setSpeed(fan, 100); } }));
      } else {
        const bar = el("div"), txt = el("span");
        Object.assign(d, { bar, txt });
        ctl.append(el("div", { class: "progress" }, bar, txt));
      }
      this.devices[fan] = d;
      list.append(el("div", { class: "fan-row" }, el("div", { class: "name" }, name), ctl));
    }
    this.el.append(el("div", { class: "scroll fill" }, list));
    this.update(Object.fromEntries(fans.map((f) => [f, { speed: 0 }])));
  }
  paint(d, v) { d.scale.value = v; d.scale.style.setProperty("--pct", `${v}%`); d.val.textContent = `${v}%`; }
  update(data) {
    for (const [fan, d] of Object.entries(this.devices)) {
      if (!(fan in data)) continue;
      const s = this.p.fanSpeed(fan);
      if (d.changeable) { if (!d.dragging) this.paint(d, Math.round(s * 100)); }
      else { d.bar.style.width = `${s * 100}%`; d.txt.textContent = `${Math.round(s * 100)}%`; }
    }
  }
  setSpeed(fan, v) {
    if (fan === "fan") this.mr.gcode(`M106 S${(v * 2.55).toFixed(0)}`).catch(() => {});
    else this.mr.gcode(`SET_FAN_SPEED FAN=${fan.split(" ")[1]} SPEED=${v / 100}`).catch(() => {});
    setTimeout(() => this.update({ [fan]: {} }), 1000);
  }
};

// ================================================================= job_status.py
Panels.job_status = class extends Panel {
  constructor(app, title) {
    super(app, title || "Job Status");
    this.state = "standby";
    this.filename = "";
    this.meta = {};
    this.progress = 0;
    this.speedFactor = 1; this.speed = 100; this.extrusion = 100; this.reqSpeed = 0; this.vel = 0;
    this.zoffset = 0; this.oheight = 0; this.flowstore = []; this.prevPos = null;
    const dia = parseFloat(this.p.configSection(this.p.stat("toolhead", "extruder") || "extruder").filament_diameter || "1.75");
    this.filaSection = Math.PI * (dia / 2) ** 2;
    this.L = {};
    const lbl = (k, t = "-") => (this.L[k] = el("div", { class: "label start" }, t));
    ["pos_x", "pos_y", "pos_z", "time_left", "duration", "slicer_time", "file_time", "filament_time", "est_time", "req_speed", "max_accel",
      "extrude_factor", "zoffset", "filament_used", "filament_total", "advance", "layer", "height", "flowrate"].forEach((k) => lbl(k));

    this.fileLbl = el("div", { class: "printing-filename" }, "Filename");
    this.lcd = el("div", { class: "printing-status hidden" });
    this.ring = el("canvas", { style: { width: "100%", height: "100%", display: "block" } });
    this.progText = el("div", { class: "printing-progress-text", style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } }, "0%");
    const overlay = el("div", { style: { position: "relative", minHeight: "5em", minWidth: "5em" } }, this.ring, this.progText);
    this.thumb = Button("file", null, null, { onclick: () => this.fullscreenThumb() });
    this.thumb.classList.add("thumb");

    const S = (img, k) => (this.L[`b_${k}`] = Button(img, "-", null, { side: true, lines: 1 }));
    const bSpeed = S("speed+", "speed"), bZ = S("home-z", "z"), bExt = S("extrude", "extrusion"), bFan = S("fan", "fan"), bEl = S("clock", "elapsed"), bLeft = S("hourglass", "left");
    bFan.addEventListener("click", () => app.showPanel("fan"));
    this.tempBtns = {};
    const temps = el("div", { class: "grid", style: { gridAutoFlow: "column", gridAutoColumns: "minmax(0,1fr)" } });
    const nlimit = app.width <= 500 ? 2 : 3;
    const tools = this.p.tools;
    const showTools = nlimit > 2 && tools.length === 2 ? tools : [this.p.stat("toolhead", "extruder") || tools[0]].filter(Boolean);
    let n = 0;
    for (const t of showTools) { this.addTempBtn(temps, t, `extruder-${this.p.toolNumber(t)}`); n++; }
    for (const h of this.p.heaters) { if (n >= nlimit) break; this.addTempBtn(temps, h, h === "heater_bed" ? "bed" : "heater"); n++; }
    const szfe = Grid(5, 2, [{ w: bSpeed, x: 0, y: 0, cw: 3 }, { w: bZ, x: 3, y: 0, cw: 2 }, this.p.tools.length ? { w: bExt, x: 0, y: 1, cw: 3 } : null, this.p.fans.length ? { w: bFan, x: 3, y: 1, cw: 2 } : null]);
    this.statusGrid = Grid(1, 5, [{ w: temps, x: 0, y: 0 }, { w: szfe, x: 0, y: 1, ch: 2 }, { w: bEl, x: 0, y: 3 }, { w: bLeft, x: 0, y: 4 }], "printing-info");
    const back = (style) => { const b = Button("back", null, style, { onclick: () => this.switchInfo(this.statusGrid) }); b.style.flex = "0 0 auto"; return b; };
    const sec = (style, rows) => el("div", { style: { display: "flex", minHeight: 0, minWidth: 0 } }, back(style),
      Grid(2, rows.length, rows.flatMap(([a, k], i) => [{ w: el("div", { class: "label start" }, a), x: 0, y: i }, { w: this.L[k], x: 1, y: i }]), "printing-info-secondary fill"));
    this.extrusionGrid = sec("color1", [["Flow:", "extrude_factor"], ["Flowrate:", "flowrate"], ["Pressure Advance:", "advance"], ["Filament used:", "filament_used"], ["Filament total:", "filament_total"]]);
    const posbox = el("div", { style: { display: "flex", gap: "5px" } }, this.L.pos_x, this.L.pos_y, this.L.pos_z);
    this.L.pos_xyz = posbox;
    this.moveGrid = sec("color2", [["Speed:", "req_speed"], ["Acceleration:", "max_accel"], ["Position:", "pos_xyz"], ["Z offset:", "zoffset"], ["Height:", "height"], ["Layer:", "layer"]]);
    this.timeGrid = sec("color3", [["Elapsed:", "duration"], ["Left:", "time_left"], ["Total:", "est_time"], ["Slicer:", "slicer_time"], ["File:", "file_time"], ["Filament:", "filament_time"]]);
    bExt.addEventListener("click", () => this.switchInfo(this.extrusionGrid));
    bZ.addEventListener("click", () => this.switchInfo(this.moveGrid));
    bSpeed.addEventListener("click", () => this.switchInfo(this.moveGrid));
    bEl.addEventListener("click", () => this.switchInfo(this.timeGrid));
    bLeft.addEventListener("click", () => this.switchInfo(this.timeGrid));

    this.infoSlot = el("div", { style: { minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" } });
    this.infoGrid = el("div", { class: "grid", style: { minHeight: 0 } });
    this.buttonGrid = el("div", { class: "grid", style: { gridTemplateColumns: "repeat(4, minmax(0,1fr))", height: "7.5em" } });
    this.B = {
      cancel: Button("stop", "Cancel", "color2", { onclick: () => this.cancel() }),
      control: Button("settings", "Settings", "color3", { onclick: () => app.goToSubmenu("") }),
      fine_tune: Button("fine-tune", "Fine Tuning", "color4", { onclick: () => app.showPanel("fine_tune") }),
      menu: Button("complete", "Main Menu", "color4", { onclick: () => this.closePanel() }),
      pause: Button("pause", "Pause", "color1", { onclick: (e, b) => { b.disabled = true; this.B.resume.disabled = true; app.sendAction("printer.print.pause", {}); } }),
      restart: Button("refresh", "Restart", "color3", { onclick: () => this.restart() }),
      resume: Button("resume", "Resume", "color1", { onclick: () => app.sendAction("printer.print.resume", {}) }),
      save_offset_probe: Button("home-z", "Save Z Probe", "color1", { onclick: () => this.saveOffset("probe") }),
      save_offset_endstop: Button("home-z", "Save Z Endstop", "color2", { onclick: () => this.saveOffset("endstop") }),
    };
    this.top = el("div", { style: { display: "flex", flexDirection: "column", justifyContent: "center", gap: "10px", minWidth: 0 } }, this.fileLbl, this.lcd);
    this.overlay = overlay;
    this.build();
    this.switchInfo(this.statusGrid);
    const all = {};
    for (const k of ["print_stats", "gcode_move", "toolhead", "display_status", "motion_report", "virtual_sdcard", ...this.p.tempDevices()]) all[k] = this.p.stat(k) || {};
    this.update(all);
  }
  addTempBtn(parent, dev, img) {
    const b = Button(img, "-", null, { side: true, lines: 1, onclick: () => this.app.showPanel("temperature", null, dev) });
    this.tempBtns[dev] = b;
    parent.append(b);
  }
  build() {
    this.el.innerHTML = "";
    this.infoGrid.innerHTML = "";
    if (this.vertical) {
      this.infoGrid.style.gridTemplateColumns = "1fr"; this.infoGrid.style.gridTemplateRows = "minmax(0,1fr) minmax(0,2fr)";
      this.infoGrid.append(this.thumb, this.infoSlot);
    } else {
      this.infoGrid.style.gridTemplateColumns = "minmax(0, 25%) minmax(0,1fr)"; this.infoGrid.style.gridTemplateRows = "minmax(0,1fr)";
      this.infoGrid.append(this.thumb, this.infoSlot);
    }
    const g = el("div", { class: "grid fill", style: { gridTemplateColumns: "repeat(4, minmax(0,1fr))", gridTemplateRows: "auto minmax(0,1fr) auto" } });
    this.overlay.style.gridColumn = "1"; this.overlay.style.gridRow = "1"; this.overlay.style.height = "5.5em";
    this.top.style.gridColumn = "2 / span 3"; this.top.style.gridRow = "1";
    this.infoGrid.style.gridColumn = "1 / span 4"; this.infoGrid.style.gridRow = "2";
    this.buttonGrid.style.gridColumn = "1 / span 4"; this.buttonGrid.style.gridRow = "3";
    g.append(this.overlay, this.top, this.infoGrid, this.buttonGrid);
    this.el.append(g);
  }
  relayout() { this.build(); this.drawRing(); }
  switchInfo(grid) { this.infoSlot.innerHTML = ""; grid.classList.add("fill"); this.infoSlot.append(grid); }
  activate() {
    this.flowTimer = setInterval(() => this.updateFlow(), 2000);
    this.showButtonsForState();
    requestAnimationFrame(() => this.drawRing());
  }
  deactivate() { clearInterval(this.flowTimer); clearTimeout(this.stateTimer); }
  drawRing() {
    const c = this.ring, r = c.getBoundingClientRect();
    if (r.width < 5) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext("2d"); g.scale(dpr, dpr);
    const rad = Math.min(r.width, r.height) * 0.42;
    g.lineWidth = this.app.fontSize * 0.75;
    g.translate(r.width / 2, r.height / 2);
    g.strokeStyle = "rgb(33,33,33)"; g.beginPath(); g.arc(0, 0, rad, 0, 2 * Math.PI); g.stroke();
    g.strokeStyle = "rgb(183,28,28)"; g.beginPath(); g.arc(0, 0, rad, 1.5 * Math.PI, 1.5 * Math.PI + this.progress * 2 * Math.PI); g.stroke();
  }
  updateProgress(p) { this.progress = p; this.progText.textContent = `${Math.trunc(p * 100)}%`; this.drawRing(); }
  update(data) {
    for (const [dev, b] of Object.entries(this.tempBtns)) {
      if (!(dev in data)) continue;
      const t = this.p.stat(dev, "temperature"), tg = this.p.stat(dev, "target");
      b.setLabel(`${padNumber(t, 3)}${tg ? "/" + padNumber(tg, 3) : ""}°`);
    }
    const ds = data.display_status;
    if (ds && "message" in ds) { this.lcd.textContent = ds.message || ""; this.lcd.classList.toggle("hidden", !ds.message); }
    const th = data.toolhead;
    if (th && th.max_accel !== undefined) this.L.max_accel.textContent = `${th.max_accel.toFixed(0)} mm/s²`;
    for (const e of this.p.tools) if (data[e] && data[e].pressure_advance !== undefined && e === (this.p.stat("toolhead", "extruder") || "extruder")) this.L.advance.textContent = data[e].pressure_advance.toFixed(3);
    const gm = data.gcode_move;
    if (gm) {
      if (gm.gcode_position) {
        const z = Number(gm.gcode_position[2]).toFixed(2);
        this.L.b_z.setLabel(`Z: ${z.padStart(6, " ")}${this.oheight > 0 ? "/" + this.oheight : ""} ${this.app.width > 500 ? "mm" : ""}`);
      }
      if (gm.extrude_factor !== undefined) { this.extrusion = Math.round(gm.extrude_factor * 100); this.L.extrude_factor.textContent = `${padNumber(this.extrusion, 3)}%`; }
      if (gm.speed_factor !== undefined) { this.speed = Math.round(gm.speed_factor * 100); this.speedFactor = gm.speed_factor; }
      if (gm.speed !== undefined) { this.reqSpeed = Math.round((gm.speed / 60) * this.speedFactor); this.speedLabel(); }
      if (gm.homing_origin) { this.zoffset = Number(gm.homing_origin[2]); this.L.zoffset.textContent = `${this.zoffset.toFixed(3)} mm`; }
    }
    const mo = data.motion_report;
    if (mo) {
      if (mo.live_position) {
        const p = mo.live_position;
        this.L.pos_x.textContent = `X: ${p[0].toFixed(2)}`; this.L.pos_y.textContent = `Y: ${p[1].toFixed(2)}`; this.L.pos_z.textContent = `Z: ${p[2].toFixed(2)}`;
        const now = Date.now() / 1000;
        if (this.prevPos) { const dt = now - this.prevPos[1]; if (dt > 0) this.flowstore.push(this.filaSection * ((p[3] - this.prevPos[0][3]) / dt)); }
        this.prevPos = [p, now];
      }
      if (mo.live_velocity !== undefined) { this.vel = Number(mo.live_velocity); this.speedLabel(); }
      if (mo.live_extruder_velocity !== undefined) this.flowstore.push(this.filaSection * Number(mo.live_extruder_velocity));
    }
    let fanLabel = "";
    for (const f of this.p.fans) {
      if (f === "fan") fanLabel += ` ${padNumber(this.p.fanSpeed(f) * 100, 3)}%`;
      else if (f.startsWith("fan_generic") && !devName(f).startsWith("_")) fanLabel += ` ${devName(f)[0].toUpperCase()}:${padNumber(this.p.fanSpeed(f) * 100, 3)}%`;
    }
    if (fanLabel) this.L.b_fan.setLabel(fanLabel.slice(0, 12));
    const ps = data.print_stats;
    if (ps) {
      if (ps.state) this.setState(ps.state, ps.message || "");
      if (ps.filename) this.updateFilename(ps.filename);
      if (ps.filament_used !== undefined) this.L.filament_used.textContent = `${(ps.filament_used / 1000).toFixed(1)} m`;
      if (ps.info) {
        if (ps.info.total_layer !== null && ps.info.total_layer !== undefined) this.totalLayers = ps.info.total_layer;
        if (ps.info.current_layer !== null && ps.info.current_layer !== undefined) this.L.layer.textContent = `${ps.info.current_layer} / ${this.totalLayers ?? "-"}`;
      }
      if (ps.total_duration !== undefined) this.L.duration.textContent = formatTime(ps.total_duration);
      if (this.state === "printing" || this.state === "paused") this.updateTimeLeft();
    }
  }
  speedLabel() {
    const unit = this.vel < 1000 && this.reqSpeed < 1000 && this.app.width > 500 ? "mm/s" : "";
    const s = `${padNumber(this.speed, 3)}% ${padNumber(this.vel, 3)}/${padNumber(this.reqSpeed, 3)} ${unit}`;
    this.L.req_speed.textContent = s;
    this.L.b_speed.setLabel(s);
  }
  updateFlow() {
    if (!this.flowstore.length) this.flowstore.push(0);
    const s = [...this.flowstore].sort((a, b) => a - b), m = s.length;
    const med = m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
    this.flowstore = [];
    this.L.flowrate.textContent = `${med.toFixed(1)} mm³/s`;
    this.L.b_extrusion.setLabel(`${padNumber(this.extrusion, 3)}% ${padNumber(med, 5, 1)} mm³/s`);
  }
  updateTimeLeft() {
    const m = this.meta, p = this.p;
    let progress = m.gcode_start_byte !== undefined && m.gcode_end_byte
      ? Math.max((p.stat("virtual_sdcard", "file_position") || 0) - m.gcode_start_byte, 0) / (m.gcode_end_byte - m.gcode_start_byte)
      : p.stat("virtual_sdcard", "progress") || 0;
    this.L.b_elapsed.setLabel(`Elapsed:  ${this.L.duration.textContent}`);
    const lastTime = m.last_time || 0, slicer = m.estimated_time || 0;
    let dur = p.stat("print_stats", "print_duration") || 0;
    const objs = p.stat("exclude_object", "objects") || [], exc = p.stat("exclude_object", "excluded_objects") || [];
    const exRatio = objs.length ? exc.length / objs.length : 0;
    if (dur < 1) dur = lastTime ? lastTime * progress : slicer ? slicer * progress : p.stat("print_stats", "total_duration") || 0;
    const fila = p.stat("print_stats", "filament_used") || 0;
    let filamentTime = 0, fileTime = 0;
    if (m.filament_total && m.filament_total >= fila && fila > 0) { filamentTime = dur / (fila / m.filament_total); this.L.filament_time.textContent = formatTime(filamentTime); }
    if (progress > 0) { fileTime = dur / progress; this.L.file_time.textContent = formatTime(fileTime); }
    const method = Settings.get("print_estimate_method");
    let est;
    if (method === "file") est = fileTime;
    else if (method === "filament") est = filamentTime * (1 - exRatio);
    else if (method === "slicer") est = slicer * (1 - exRatio);
    else est = this.estimate(progress, dur, fileTime, filamentTime, slicer, lastTime, exRatio);
    if (est > 1) {
      progress = Math.min(Math.max(dur / est, 0), 1);
      this.L.est_time.textContent = formatTime(est);
      this.L.time_left.textContent = formatETA(est, dur);
      this.L.b_left.setLabel(`Left:  ${this.L.time_left.textContent}`);
    }
    this.updateProgress(progress);
  }
  estimate(progress, dur, fileTime, filamentTime, slicer, last, ex) {
    const above = 0.3;
    slicer = (slicer / Math.sqrt(this.speedFactor || 1)) * (1 - ex); filamentTime *= 1 - ex; last *= 1 - ex;
    if (progress <= above) return last || slicer || filamentTime || fileTime;
    const wl = dur < last ? 4.0 : 0, ws = dur < slicer ? 1.0 + above - progress : 0;
    const wf = dur < filamentTime ? Math.min(progress - above, 0.33) : 0, wfile = progress - above;
    const tw = wl + ws + wf + wfile;
    return tw === 0 ? 0 : (last * wl + slicer * ws + filamentTime * wf + fileTime * wfile) / tw;
  }
  setState(state, msg) {
    const titles = { printing: this.p.extruderCount > 0 ? "Printing" : "Working", complete: "Complete", error: "Error", cancelling: "Cancelling", paused: "Paused", standby: "Standby", cancelled: "Cancelled" };
    if (state === "standby" && this.state === "cancelled") state = "cancelled";
    if (state === "complete") { this.updateProgress(1); this.L.b_left.setLabel("-"); this.addTimeout(Settings.get("job_complete_timeout")); }
    if (state === "error") { this.app.popup(msg); this.addTimeout(Settings.get("job_error_timeout")); }
    this.title = titles[state] || state;
    if (this.app.current() && this.app.current().panel === this) this.app.setTitle(this.title);
    if (this.state !== state) { this.state = state; this.showButtonsForState(); }
  }
  addTimeout(t) {
    this.app.closeScreensaver(); // a finished/failed print wakes the screen (job_status._add_timeout)
    clearTimeout(this.stateTimer);
    if (t) this.stateTimer = setTimeout(() => this.closePanel(), t * 1000);
  }
  showButtonsForState() {
    const g = this.buttonGrid, B = this.B;
    g.innerHTML = "";
    const put = (...ws) => ws.forEach((w) => g.append(w || el("div")));
    Object.values(B).forEach((b) => { b.disabled = false; b.classList.remove("busy"); });
    if (this.state === "printing") { put(B.pause, B.cancel, B.fine_tune, B.control); this.canClose = false; }
    else if (this.state === "paused") { put(B.resume, B.cancel, B.fine_tune, B.control); this.canClose = false; }
    else if (this.state === "cancelling") { put(B.resume, B.cancel, B.restart, B.menu); B.cancel.busy(true); B.resume.disabled = B.restart.disabled = B.menu.disabled = true; this.canClose = false; }
    else {
      const off = this.p.stat("gcode_move", "homing_origin");
      this.zoffset = off ? Number(off[2]) : 0;
      if (this.zoffset !== 0) put("Z_OFFSET_APPLY_ENDSTOP" in this.p.availableCommands ? B.save_offset_endstop : null, "Z_OFFSET_APPLY_PROBE" in this.p.availableCommands ? B.save_offset_probe : null);
      else put(null, null);
      put(B.restart, B.menu);
      B.restart.disabled = !this.filename;
      this.canClose = true;
    }
  }
  closePanel() { if (this.canClose) this.app.stateReady(); }
  cancel() {
    const buttons = [{ name: "Cancel Print", style: "dialog-error", cb: () => { this.setState("cancelling"); this.mr.call("printer.print.cancel").catch((e) => this.app.popup(e.message)); } },
      { name: "Go Back", style: "dialog-info" }];
    this.app.dialog("Cancel", buttons, "Are you sure you wish to cancel this print?");
  }
  restart() {
    this.app.dialog("Restart", [{
      name: "Restart Print", style: "dialog-default", cb: async () => {
        if (!this.filename) return;
        this.B.restart.disabled = true;
        if (this.state === "error") await this.mr.gcode("SDCARD_RESET_FILE").catch(() => {});
        this.mr.call("printer.print.start", { filename: this.filename }).catch((e) => this.app.popup(e.message));
        this.updateProgress(0); this.setState("printing");
      },
    }, { name: "Go Back", style: "dialog-info" }], "Are you sure you wish to restart this print?");
  }
  saveOffset(dev) {
    const sign = this.zoffset > 0 ? "+" : "-";
    let msg = `Apply ${sign}${Math.abs(this.zoffset).toFixed(3)} offset to ${dev === "probe" ? "Probe" : "Endstop"}?`;
    const saved = dev === "probe" ? (this.p.configSection("probe").z_offset || this.p.configSection("bltouch").z_offset) : this.p.configSection("stepper_z").position_endstop;
    if (saved) msg += `\n\nSaved offset: ${saved}`;
    this.app.dialog("Save Z", [{ name: "Apply", style: "dialog-default", cb: () => { this.mr.gcode(dev === "probe" ? "Z_OFFSET_APPLY_PROBE" : "Z_OFFSET_APPLY_ENDSTOP").then(() => this.mr.gcode("SAVE_CONFIG")).catch((e) => this.app.popup(e.message)); } },
      { name: "Cancel", style: "dialog-error" }], msg);
  }
  async updateFilename(fn) {
    if (!fn || fn === this.filename) return;
    this.filename = fn;
    this.fileLbl.textContent = fn.replace(/\.[^.]+$/, "");
    try { this.meta = await this.mr.call("server.files.metadata", { filename: fn }); } catch (e) { this.meta = {}; }
    if (this.meta.estimated_time) this.L.slicer_time.textContent = formatTime(this.meta.estimated_time);
    if (this.meta.object_height) { this.oheight = Number(this.meta.object_height); this.L.height.textContent = `${this.oheight.toFixed(2)} mm`; }
    if (this.meta.filament_total) this.L.filament_total.textContent = `${(this.meta.filament_total / 1000).toFixed(1)} m`;
    if (this.meta.job_id) {
      this.mr.call("server.history.get_job", { uid: this.meta.job_id }).then((r) => {
        if (r.job && r.job.status === "completed" && r.job.print_duration) this.meta.last_time = r.job.print_duration;
      }).catch(() => {});
    }
    const url = thumbnailUrl(this.app, fn, this.meta);
    if (url) { this.thumb.innerHTML = ""; this.thumb.append(el("img", { class: "thumbimg", src: url })); }
  }
  fullscreenThumb() {
    const url = thumbnailUrl(this.app, this.filename, this.meta);
    if (url) this.app.dialog(this.filename, null, el("img", { src: url, style: { maxWidth: "90vw", maxHeight: "70vh" } }));
  }
};

function thumbnailUrl(app, filename, meta) {
  const th = (meta && meta.thumbnails) || [];
  if (!th.length) return null;
  const best = th.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
  const dir = filename.includes("/") ? filename.slice(0, filename.lastIndexOf("/") + 1) : "";
  return `${app.mr.httpBase()}/server/files/gcodes/${encodeURI(dir + best.relative_path)}`;
}

// ================================================================= gcodes.py
Panels.gcodes = class extends Panel {
  constructor(app, title) {
    super(app, title || "Print");
    this.path = "gcodes";
    this.sort = Settings.get("print_sort_dir");
    this.sortBtns = {};
    const bar = el("div", { class: "sortbar" });
    const n = (i) => `color${(i % 4) + 1}`;
    [["name", "Name"], ["size", "Size"], ["date", "Date"]].forEach(([k, label], i) => {
      this.sortBtns[k] = Button(null, label, n(i), { side: true, lines: 1, onclick: () => this.changeSort(k) });
      this.sortBtns[k].classList.add("center");
      bar.append(this.sortBtns[k]);
    });
    bar.append(Button("refresh", null, n(3), { side: true, onclick: () => this.load() }));
    this.pathLbl = el("div", { class: "path hidden" });
    this.list = el("div", { class: "scroll fill" });
    this.el.append(bar, this.pathLbl, this.list);
    this.refreshSortLabels();
  }
  activate() { this.load(); }
  back() { if (this.path !== "gcodes") { this.path = this.path.slice(0, this.path.lastIndexOf("/")); this.load(); return true; } return false; }
  canGoBack() { return this.path !== "gcodes"; }
  onFilesChanged() { clearTimeout(this.reloadT); this.reloadT = setTimeout(() => this.load(), 500); }
  changeSort(k) {
    const [cur, dir] = this.sort.split("_");
    this.sort = cur === k ? `${k}_${dir === "asc" ? "desc" : "asc"}` : `${k}_asc`;
    Settings.set("print_sort_dir", this.sort);
    this.refreshSortLabels();
    this.render();
  }
  refreshSortLabels() {
    const [cur, dir] = this.sort.split("_");
    for (const [k, b] of Object.entries(this.sortBtns)) b.setLabel(`${{ name: "Name", size: "Size", date: "Date" }[k]}${k === cur ? (dir === "asc" ? " ▲" : " ▼") : ""}`);
  }
  async load() {
    this.pathLbl.textContent = this.path.replace(/^gcodes/, "") || "/";
    this.pathLbl.classList.toggle("hidden", this.path === "gcodes");
    this.app.updateActionBar();
    try { this.dir = await this.mr.call("server.files.get_directory", { path: this.path, extended: true }); }
    catch (e) { this.list.innerHTML = ""; this.list.append(el("div", { class: "label", style: { height: "100%" } }, `Unable to list files\n${e.message}`)); return; }
    this.render();
  }
  render() {
    if (!this.dir) return;
    const [k, dir] = this.sort.split("_");
    const mul = dir === "asc" ? 1 : -1;
    const cmp = (a, b, name) => k === "name" ? mul * a[name].localeCompare(b[name], undefined, { numeric: true }) : k === "size" ? mul * ((a.size || 0) - (b.size || 0)) : mul * ((a.modified || 0) - (b.modified || 0));
    const dirs = (this.dir.dirs || []).filter((d) => !d.dirname.startsWith(".")).sort((a, b) => cmp(a, b, "dirname"));
    const files = (this.dir.files || []).filter((f) => /\.(gco|gcode|g|ufp)$/i.test(f.filename)).sort((a, b) => cmp(a, b, "filename"));
    this.list.innerHTML = "";
    const rel = this.path.replace(/^gcodes\/?/, "");
    for (const d of dirs) {
      const row = el("div", { class: "file-row" }, el("div", { class: "icon" }, icon("folder")),
        el("div", { style: { minWidth: 0 } }, el("div", { class: "name" }, d.dirname), el("div", { class: "info" }, `Modified: ${new Date(d.modified * 1000).toLocaleString()}`)),
        Button("load", null, "color3", { onclick: () => { this.path = `${this.path}/${d.dirname}`; this.load(); } }));
      this.list.append(row);
    }
    for (const f of files) {
      const full = rel ? `${rel}/${f.filename}` : f.filename;
      const meta = f.metadata || f;
      const th = thumbnailUrl(this.app, full, meta);
      const info = [`Uploaded: ${new Date(f.modified * 1000).toLocaleString()}`, `Size: ${formatSize(f.size)}`];
      if (meta.estimated_time) info.push(`Print Time: ${formatTime(meta.estimated_time)}`);
      const row = el("div", { class: "file-row" }, el("div", { class: "icon" }, th ? el("img", { src: th }) : icon("file")),
        el("div", { style: { minWidth: 0 }, onclick: () => this.confirmPrint(full, meta) }, el("div", { class: "name" }, f.filename.replace(/\.[^.]+$/, "")), el("div", { class: "info" }, info.join(" - "))),
        Button("printer", null, "color1", { onclick: () => this.confirmPrint(full, meta) }));
      this.list.append(row);
    }
    if (!dirs.length && !files.length) this.list.append(el("div", { class: "label", style: { height: "100%" } }, "No files"));
  }
  confirmPrint(filename, meta) {
    const th = thumbnailUrl(this.app, filename, meta);
    const body = el("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: ".5em" } });
    if (th) body.append(el("img", { src: th, style: { maxHeight: "40vh", maxWidth: "80vw" } }));
    body.append(el("div", {}, filename));
    if (meta && meta.estimated_time) body.append(el("div", {}, `Print Time: ${formatTime(meta.estimated_time)}`));
    this.app.dialog("Print", [
      { name: "Delete", style: "dialog-warning", cb: () => this.app.confirmSendAction(`Delete File?\n\n${filename}`, "server.files.delete_file", { path: `gcodes/${filename}` }) },
      { name: "Print", style: "dialog-default", cb: () => this.mr.call("printer.print.start", { filename }).catch((e) => this.app.popup(e.message)) },
      { name: "Cancel", style: "dialog-error" },
    ], body);
  }
};

function formatSize(n) {
  if (!n && n !== 0) return "-";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ================================================================= gcode_macros.py (tile grid)
const MACRO_GRID_SIZES = [["auto", "Auto (fill)"], ["2x2", "2 × 2"], ["3x2", "3 × 2"], ["3x3", "3 × 3"], ["4x2", "4 × 2"],
  ["4x3", "4 × 3"], ["4x4", "4 × 4"], ["5x3", "5 × 3"], ["5x4", "5 × 4"], ["6x4", "6 × 4"]];

/** 32 tile colors: 8 hues (columns) x 4 shades (rows: deep, dark, bright, light). */
const MACRO_COLOR_HUES = ["Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "Grey"];
const MACRO_COLOR_SHADES = ["deep", "dark", "bright", "light"];
const MACRO_COLORS = [
  ["#5c1a1a", "#5c2e0e", "#5a4a08", "#1b4320", "#0f3f3c", "#13294f", "#34164f", "#1e2225"],
  ["#8e2424", "#9a4a12", "#8f7510", "#2e7032", "#17695f", "#1f4a8a", "#5a2a87", "#3c4247"],
  ["#d63a3a", "#ef7d22", "#e8c21c", "#43a047", "#1fa392", "#2f7de1", "#9046cf", "#6f777e"],
  ["#f28b82", "#fbb779", "#fce48a", "#a5d6a7", "#8fd9cc", "#9ec5f8", "#cfa8ef", "#c3c8cc"],
];
function macroColorName(hex) {
  for (let r = 0; r < MACRO_COLORS.length; r++) {
    const c = MACRO_COLORS[r].indexOf(hex);
    if (c >= 0) return `${MACRO_COLOR_HUES[c]}, ${MACRO_COLOR_SHADES[r]}`;
  }
  return hex;
}
/** true when dark text and icons read better than white on this background (WCAG relative luminance) */
function isLightColor(hex) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(hex.slice(1), 16);
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.179; // above this, black text has more contrast than white
}
/** Shade a button's background (null: back to the theme's look). */
function paintTile(btn, hex) {
  btn.classList.toggle("macro-colored", !!hex);
  btn.classList.toggle("light-bg", !!hex && isLightColor(hex));
  if (hex) btn.style.setProperty("--macro-bg", hex); else btn.style.removeProperty("--macro-bg");
}

/** {PARAM: default} from a macro's gcode template (params.X | default(...)) */
function macroParams(cfg) {
  const params = {};
  const re = /params\.([A-Za-z_0-9]+)(?:\s*\|\s*default\(\s*([^)]*?)\s*\))?/g;
  let m;
  while ((m = re.exec((cfg && cfg.gcode) || ""))) {
    const k = m[1].toUpperCase();
    if (!(k in params)) params[k] = (m[2] || "").replace(/^['"]|['"]$/g, "");
  }
  return params;
}

/** Columns x rows that fill a W x H area with n tiles: every tile stays tappable, tiles stay close to a
    1.6:1 button shape, and few cells are left empty. If n can't fit, it returns the rows that fit and
    the grid scrolls. */
function autoMacroGrid(n, W, H, fs) {
  const minW = fs * 5.5, minH = fs * 3;
  let best = null;
  for (let cols = 1; cols <= 8; cols++) {
    const cw = W / cols;
    if (cw < minW && cols > 1) break;
    const rows = Math.max(1, Math.ceil(n / cols));
    const ch = H / rows;
    const fits = ch >= minH;
    const empty = (cols * rows - n) / (cols * rows);
    const score = (fits ? 0 : 10 + cols * -0.1) + Math.abs(Math.log(cw / ch / 1.6)) + empty * 1.5;
    if (!best || score < best.score) best = { cols, rows: fits ? rows : Math.max(1, Math.floor(H / minH)), score };
  }
  return best;
}

Panels.gcode_macros = class extends Panel {
  constructor(app, title) {
    super(app, title || "Macros");
    this.baseTitle = this.title;
    this.view = el("div", { class: "fill", style: { display: "flex", flexDirection: "column", minHeight: 0 } });
    this.el.append(this.view);
    this.editing = false;   // the Edit toggle: taps edit tiles instead of running macros
    this.editMode = "hide"; // what a tap does while editing: "hide" (hide/show) or "color"; holding a tile moves it
    // Chrome only lets a touch be kept from scrolling if a non-passive listener was there when it began
    this.el.addEventListener("touchmove", (e) => { if (this.drag) e.preventDefault(); }, { passive: false });
  }
  activate() { this.render(); }
  deactivate() { this.editing = false; this.cancelDrag(); this.app.setPanelActions(null); } // leaving the panel ends editing
  relayout() { this.cancelDrag(); this.render(); }
  hiddenSet() { return Settings.get("macros_hidden") || {}; }
  allMacros() { return [...this.p.macros].sort((a, b) => a.localeCompare(b)); }
  /**
   * What the normal Macros page shows, cell by cell: macro names, and null for an empty gap the user
   * left. Stored as macros_layout. Hidden macros drop out (the tiles after them close up) and come
   * back to their place when shown again; macros added to Klipper later follow alphabetically.
   */
  layoutCells() {
    const exists = new Set(this.p.macros), hidden = this.hiddenSet();
    const stored = Settings.get("macros_layout");
    const seen = new Set();
    const cells = (Array.isArray(stored) ? stored : []).filter((c) => {
      if (c === null) return true;
      if (!exists.has(c) || hidden[c] || seen.has(c)) return false;
      seen.add(c);
      return true;
    });
    for (const m of this.allMacros()) if (!seen.has(m) && !hidden[m] && !(Array.isArray(stored) && stored.includes(m))) cells.push(m);
    while (cells.length && cells[cells.length - 1] === null) cells.pop(); // no trailing gaps
    while (cells.length && cells[0] === null && !cells.some(Boolean)) cells.shift();
    return cells;
  }
  saveLayout(cells) {
    const c = [...cells];
    while (c.length && c[c.length - 1] === null) c.pop();
    // hidden macros keep their stored place, after the visible layout, so showing one again brings it back
    const hidden = this.hiddenSet();
    const old = Settings.get("macros_layout") || [];
    for (const m of old) if (m && hidden[m] && !c.includes(m)) c.push(m);
    Settings.set("macros_layout", c);
  }
  configOf(name) { return this.p.configSection(`gcode_macro ${name}`) || this.p.configSection(`gcode_macro ${name.toLowerCase()}`); }
  setHeading(sub) {
    this.title = sub ? `${this.baseTitle}: ${sub}` : this.baseTitle;
    if (this.app.current() && this.app.current().panel === this) this.app.setTitle(this.title);
  }
  render() {
    if (!this.view.clientHeight) requestAnimationFrame(() => this.renderGrid()); // needs real size
    else this.renderGrid();
    this.app.updateActionBar();
  }
  setEditing(on) { this.editing = on; this.cancelDrag(); this.render(); }
  /** Hide/show one macro in place: the tile just dims or brightens, nothing moves while editing. */
  toggleHidden(name, tile) {
    const h = { ...this.hiddenSet() };
    if (h[name]) delete h[name]; else h[name] = true;
    Settings.set("macros_hidden", h);
    tile.classList.toggle("macro-hidden", !!h[name]);
    this.updateEditCount();
  }
  updateEditCount() {
    if (!this.editing) return;
    if (this.drag) { this.setHeading("drop on an empty slot, or on a macro to swap"); return; }
    const all = this.allMacros(), h = this.hiddenSet();
    if (this.editMode === "color") {
      const n = all.filter((m) => this.colors()[m]).length;
      this.setHeading(`tap to color, hold to move (${n}/${all.length} colored)`);
      return;
    }
    const shown = all.filter((m) => !h[m]).length;
    this.setHeading(`tap to hide/show, hold to move (${shown}/${all.length} shown)`);
  }
  colors() { return Settings.get("macros_colors") || {}; }
  setColor(name, hex, tile) {
    const c = { ...this.colors() };
    if (hex) c[name] = hex; else delete c[name];
    Settings.set("macros_colors", c);
    if (tile) paintTile(tile, hex);
    this.updateEditCount();
  }
  /** The 32-color palette for one macro: tap a swatch to apply it, "No color" for the theme's look. */
  pickColor(name, tile) {
    const cur = this.colors()[name];
    const pal = el("div", { class: "color-palette" });
    let close = () => {};
    MACRO_COLORS.forEach((row) => row.forEach((hex) => {
      const s = el("button", { class: "swatch" + (hex === cur ? " current" : ""), title: macroColorName(hex), "aria-label": macroColorName(hex),
        onclick: () => { close(); this.setColor(name, hex, tile); } });
      paintTile(s, hex);
      pal.append(s);
    }));
    close = this.app.dialog(`Color: ${name.replace(/_/g, " ")}`, [
      { name: "No color", style: "dialog-warning", cb: () => this.setColor(name, null, tile) },
      { name: "Cancel", style: "dialog-error" },
    ], pal);
  }
  editTap(name, tile) {
    if (this.suppressClick) return;
    if (this.editMode === "color") this.pickColor(name, tile);
    else this.toggleHidden(name, tile);
  }

  // ------------------------------------------------------------ press and hold to move (edit mode)
  /**
   * Holding a tile for a moment lifts it. The grid then shows the normal Macros page's tiles (no
   * hidden macros, same tile size) plus empty slots, and the tile follows the finger.
   * Dropping on an empty slot moves it there and leaves a gap where it was; dropping on another
   * macro swaps the two.
   */
  holdStart(e, name, tile) {
    if (!this.editing || this.drag || (e.button !== undefined && e.button > 0)) return;
    if (this.hiddenSet()[name]) return; // hidden macros aren't on the normal page; show one first to move it
    const start = { x: e.clientX, y: e.clientY };
    const tol = this.app.fontSize * 0.6;
    const cancelHold = () => {
      clearTimeout(this.holdTimer);
      window.removeEventListener("pointermove", early);
      window.removeEventListener("pointerup", cancelHold);
      window.removeEventListener("pointercancel", cancelHold);
      tile.classList.remove("holding");
    };
    const early = (ev) => { if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > tol) cancelHold(); }; // a scroll, not a hold
    tile.classList.add("holding");
    window.addEventListener("pointermove", early);
    window.addEventListener("pointerup", cancelHold);
    window.addEventListener("pointercancel", cancelHold);
    this.holdTimer = setTimeout(() => {
      cancelHold();
      this.beginDrag(name, tile, start);
    }, 450);
  }
  beginDrag(name, srcEl, at) {
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* not allowed */ } }
    // the pressed tile itself moves into the new view (it is the touch's target: Android keeps sending
    // the finger's events to it, so it must stay in the page)
    this.drag = { name, srcEl, x: at.x, y: at.y, target: null };
    srcEl.classList.remove("holding");
    this.renderGrid(); // switch to the normal-page view with empty slots
    const grid = this.drag.grid;
    const src = srcEl;
    src.classList.add("drag-placeholder");
    const r = src.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.classList.remove("drag-placeholder");
    ghost.classList.add("drag-ghost");
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
    document.body.append(ghost);
    this.drag.off = { x: r.width / 2, y: r.height / 2 };
    this.drag.ghost = ghost;
    this.drag.from = Number(src.dataset.index);
    const move = (ev) => { ev.preventDefault(); this.dragMove(ev.clientX, ev.clientY); };
    const up = () => this.endDrag(true);
    const cancel = () => this.endDrag(false);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    this.drag.cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    // scroll while the finger rests near the top or bottom edge
    this.drag.timer = setInterval(() => {
      const g = grid.getBoundingClientRect(), edge = this.app.fontSize * 2;
      if (this.drag.y < g.top + edge) grid.scrollTop -= 12; else if (this.drag.y > g.bottom - edge) grid.scrollTop += 12;
    }, 30);
    this.dragMove(at.x, at.y);
    this.updateEditCount();
  }
  dragMove(x, y) {
    const d = this.drag;
    if (!d) return;
    d.x = x; d.y = y;
    d.ghost.style.transform = `translate(${x - d.off.x}px, ${y - d.off.y}px)`;
    const over = document.elementsFromPoint(x, y).find((n) => n.classList && n.classList.contains("macro-cell") && n.parentNode === d.grid);
    const t = over ? Number(over.dataset.index) : null;
    if (t === d.target) return;
    if (d.targetEl) d.targetEl.classList.remove("drop-target");
    d.target = t;
    d.targetEl = over && t !== d.from ? over : null;
    if (d.targetEl) d.targetEl.classList.add("drop-target");
  }
  endDrag(drop) {
    const d = this.drag;
    if (!d) return;
    if (drop && d.target !== null && d.target !== d.from) {
      const cells = [...d.cells];
      while (cells.length <= d.target) cells.push(null);
      const other = cells[d.target];
      cells[d.target] = d.name;
      cells[d.from] = other === undefined ? null : other; // an empty slot leaves a gap; a macro swaps places
      this.saveLayout(cells);
    }
    this.cancelDrag();
    this.suppressClick = true; // the click that ends a drag isn't a tap
    setTimeout(() => (this.suppressClick = false), 0);
    this.render();
  }
  cancelDrag() {
    clearTimeout(this.holdTimer);
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    clearInterval(d.timer);
    if (d.cleanup) d.cleanup();
    if (d.ghost) d.ghost.remove();
  }
  resetLayout() {
    this.app.dialog("Sort A–Z", [
      { name: "Sort", style: "dialog-default", cb: () => { Settings.set("macros_layout", null); this.render(); } },
      { name: "Cancel", style: "dialog-error" }], "Put every macro back in alphabetical order and remove the gaps?");
  }

  /** "Hidden" toggle: whether editing also lists the hidden macros (dimmed) so they can be shown again */
  showHidden() { return !!Settings.get("macros_show_hidden"); }
  /** Action bar button on the Macros page: Edit turns editing on, Done (highlighted) turns it off */
  editButton() {
    const b = Button(this.editing ? "complete" : "edit", this.editing ? "Done" : "Edit", null, { lines: 1, onclick: () => this.setEditing(!this.editing) });
    b.classList.toggle("button_active", this.editing);
    return b;
  }
  /** The editor's bar above the grid: tap mode, grid size, hidden macros, bulk actions, A-Z */
  editBar() {
    const all = this.allMacros();
    const setAll = (hide) => { const h = {}; if (hide) all.forEach((m) => (h[m] = true)); Settings.set("macros_hidden", h); this.render(); };
    const mode = (key, label) => {
      const b = Button(null, label, null, { lines: 1, onclick: () => { this.editMode = key; this.render(); } });
      b.classList.add("mode-btn");
      b.classList.toggle("button_active", this.editMode === key);
      return b;
    };
    const nHidden = all.filter((m) => this.hiddenSet()[m]).length;
    const hiddenBtn = Button(this.showHidden() ? "complete" : "archived", `Hidden${nHidden ? ` (${nHidden})` : ""}`, null,
      { side: true, lines: 1, onclick: () => { Settings.set("macros_show_hidden", !this.showHidden()); this.render(); } });
    hiddenBtn.classList.add("hidden-toggle");
    hiddenBtn.classList.toggle("button_active", this.showHidden());
    const actions = this.editMode === "color"
      ? [Button("cancel", "Clear colors", "color2", { side: true, lines: 1, onclick: () => this.app.dialog("Clear colors", [
          { name: "Clear", style: "dialog-default", cb: () => { Settings.set("macros_colors", {}); this.render(); } },
          { name: "Cancel", style: "dialog-error" }], "Remove the color from every macro?") })]
      : [Button("complete", "Show all", "color3", { side: true, lines: 1, onclick: () => setAll(false) }),
         Button("cancel", "Hide all", "color2", { side: true, lines: 1, onclick: () => setAll(true) })];
    return el("div", { class: "macro-edit-bar" },
      el("div", { class: "mode-switch" }, mode("hide", "Hide/Show"), mode("color", "Color")),
      optionRow(this.app, { key: "macros_grid", name: "Grid", type: "dropdown", options: MACRO_GRID_SIZES, cb: () => this.render() }),
      hiddenBtn, ...actions,
      Button("refresh", "A–Z", "color4", { side: true, lines: 1, onclick: () => this.resetLayout() }));
  }
  /** columns x rows for n cells, the same way in every view so editing matches the normal page */
  gridSize(n, W, H) {
    const size = Settings.get("macros_grid") || "auto";
    let cols, rows;
    if (size === "auto") ({ cols, rows } = autoMacroGrid(n, W, H, this.app.fontSize));
    else [cols, rows] = size.split("x").map((v) => parseInt(v));
    if (this.vertical && size !== "auto") [cols, rows] = [Math.min(cols, rows), Math.max(cols, rows)]; // keep tiles wide when upright
    return { cols, rows };
  }
  renderGrid() {
    this.setHeading(null);
    this.view.innerHTML = "";
    const hidden = this.hiddenSet();
    const all = this.allMacros();
    const cells = this.layoutCells();
    const dragging = !!this.drag;
    // the editor's bar sits above the grid, and stays while a tile is lifted (inert until it's dropped)
    if (this.editing) {
      const bar = this.editBar();
      bar.classList.toggle("inert", dragging);
      this.view.append(bar);
    }
    this.app.setPanelActions([this.editButton()], false); // Edit / Done lives in the action bar on this page
    // with "Show hidden" on, editing adds the hidden macros, dimmed, after the layout to show them again
    const hiddenTail = this.editing && !dragging && this.showHidden() ? all.filter((m) => hidden[m]) : [];
    const W = this.view.clientWidth || this.app.content.clientWidth;
    const barH = this.view.firstChild ? this.view.firstChild.offsetHeight : 0;
    const fullH = this.view.clientHeight || this.app.content.clientHeight;
    // tiles always get the normal page's size (no bar), so editing shows them as they'll appear
    const { cols, rows } = this.gridSize(Math.max(1, cells.length), W, fullH);
    const cellH = fullH / rows;
    const fs = this.app.fontSize;
    const showIcon = cellH >= fs * 4.6;
    const grid = el("div", { class: "macro-grid scroll" + (cellH < fs * 3.4 ? " dense" : "") + (this.editing ? " editing" : "") + (dragging ? " dragging" : "") });
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridAutoRows = `${Math.floor(cellH)}px`;
    grid.addEventListener("contextmenu", (e) => { if (this.editing) e.preventDefault(); }); // long press: no menu
    const colors = this.colors();
    const tile = (m, i) => {
      const params = Object.keys(macroParams(this.configOf(m)));
      const label = m.replace(/_/g, " ") + (params.length ? " …" : ""); // … = asks for parameters
      const b = Button(showIcon ? "custom-script" : null, label, `color${(i % 4) + 1}`, {
        onclick: (e, btn) => (this.editing ? this.editTap(m, btn) : this.runMacro(m, btn)),
      });
      b.classList.add("macro-tile");
      b.dataset.macro = m;
      if (colors[m]) paintTile(b, colors[m]);
      if (this.editing && hidden[m]) b.classList.add("macro-hidden");
      if (this.editing && !dragging) b.addEventListener("pointerdown", (e) => this.holdStart(e, m, b));
      return b;
    };
    const gap = () => el("div", { class: "macro-gap" });
    let slots = cells.length;
    if (dragging) {
      // every free cell of the page is a drop target, plus one more row to grow into
      slots = Math.max(cols * rows, Math.ceil((cells.length + 1) / cols) * cols) + cols;
      this.drag.cells = cells;
      this.drag.grid = grid;
    }
    for (let i = 0; i < slots; i++) {
      const m = cells[i];
      const keep = dragging && m === this.drag.name ? this.drag.srcEl : null; // the pressed tile, reused
      const c = keep || (m ? tile(m, i) : gap());
      c.classList.add("macro-cell");
      c.dataset.index = String(i);
      grid.append(c);
    }
    hiddenTail.forEach((m, i) => grid.append(tile(m, cells.length + i)));
    this.view.append(grid);
    const shownCount = cells.filter(Boolean).length;
    if (!shownCount && !hiddenTail.length && !dragging) grid.prepend(el("div", { class: "label", style: { gridColumn: `1 / span ${cols}` } }, all.length ? "All macros are hidden. Tap Edit to bring them back" : "No macros"));
    this.gridInfo = { cols, rows, total: shownCount, scrolls: grid.children.length > cols * rows || barH > 0 };
    this.updateEditCount();
  }
  /** Tap: macros without parameters run at once (as in KlipperScreen); with parameters, ask first. */
  runMacro(name, btn) {
    const cfg = this.configOf(name);
    const params = macroParams(cfg);
    if (!Object.keys(params).length) { this.gcode(name.toUpperCase(), btn); return; }
    const inputs = {};
    const body = el("div", { style: { width: "100%" } });
    if (cfg.description && cfg.description !== "G-Code macro") body.append(el("div", { class: "desc", style: { marginBottom: ".5em" } }, cfg.description));
    const fields = el("div", { class: "macro-params" });
    for (const [p, def] of Object.entries(params)) {
      inputs[p] = el("input", { class: "entry", type: "text", placeholder: def || "", "data-kb": "text-num" }); // opens on numbers
      fields.append(el("div", { class: "param" }, el("label", {}, p), inputs[p]));
    }
    body.append(fields);
    this.app.dialog(name.toUpperCase(), [
      { name: "Run", style: "dialog-default", cb: () => {
        // macros named like G/M codes (M600…) take "X10", others "X=10", as in KlipperScreen
        const gm = /^[GM]\d{1,3}$/i.test(name);
        const args = Object.entries(inputs).filter(([, i]) => i.value.trim() !== "")
          .map(([p, i]) => { const v = i.value.trim(); return gm ? `${p}${v}` : `${p}=${/\s/.test(v) ? '"' + v + '"' : v}`; });
        this.gcode([name.toUpperCase(), ...args].join(" "), btn);
      } },
      { name: "Cancel", style: "dialog-error" },
    ], body);
  }
  canGoBack() { return this.editing; }
  back() { if (this.editing) { this.setEditing(false); return true; } return false; }
};

// ================================================================= console.py
Panels.console = class extends Panel {
  constructor(app, title) {
    super(app, title || "Console");
    this.hideTemp = true;
    this.text = el("div", { class: "console-text scroll" });
    this.entry = el("input", { class: "entry fill", type: "text", placeholder: "G-code", "data-kb": "gcode" }); // caps, stays open after Send
    this.entry.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.send();
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); this.recall(e.key === "ArrowUp" ? -1 : 1); }
    });
    this.histPos = null; // index into the history while stepping through it
    const sw = el("div", { class: "switch on", onclick: () => { this.hideTemp = !this.hideTemp; sw.classList.toggle("on", this.hideTemp); this.render(); } });
    // while the keyboard is open (it has its own Send) only the command line is shown, so it keeps its width
    const extras = (n) => { n.classList.add("kb-hide"); return n; };
    const bar = el("div", { class: "console-bar" }, extras(el("span", { style: { whiteSpace: "nowrap", paddingLeft: ".3em" } }, "Hide temp.")), extras(sw),
      extras(Button(null, "Clear", "console-clear", { side: true, onclick: () => { app.gcodeLog = []; this.render(); } })),
      this.entry, extras(Button("resume", "Send", "color3", { side: true, onclick: () => this.send() })));
    this.el.append(this.text, bar);
  }
  activate() { this.render(); }
  fmt(entry) {
    const t = entry.time, ts = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    const cls = entry.type === "command" ? "cmd" : entry.message.startsWith("!!") ? "err" : "";
    return el("div", {}, el("span", { class: "time" }, ts + "  "), el("span", { class: cls }, entry.message));
  }
  render() {
    this.text.innerHTML = "";
    for (const e of this.app.gcodeLog) if (!(this.hideTemp && /^(ok\s+)?(B|C|T\d*):/.test(e.message))) this.text.append(this.fmt(e));
    this.text.scrollTop = this.text.scrollHeight;
  }
  onGcodeResponse(t) {
    if (this.hideTemp && /^(ok\s+)?(B|C|T\d*):/.test(t)) return;
    this.text.append(this.fmt(this.app.gcodeLog[this.app.gcodeLog.length - 1]));
    while (this.text.childElementCount > 500) this.text.firstChild.remove(); // match gcodeLog's cap
    this.text.scrollTop = this.text.scrollHeight;
  }
  send() {
    const cmd = this.entry.value.trim();
    if (!cmd) return;
    this.entry.value = "";
    const hist = Settings.get("console_history") || [];
    if (hist[hist.length - 1] !== cmd) hist.push(cmd);
    Settings.set("console_history", hist.slice(-100));
    this.histPos = null;
    const entry = { time: new Date(), message: cmd, type: "command" };
    this.app.gcodeLog.push(entry);
    this.text.append(this.fmt(entry));
    this.text.scrollTop = this.text.scrollHeight;
    this.mr.gcode(cmd).catch(() => {});
  }
  /** Step through earlier commands: -1 older, +1 newer; past the newest gives back what was being typed. */
  recall(dir) {
    const hist = Settings.get("console_history") || [];
    if (!hist.length) return;
    if (this.histPos === null) { if (dir > 0) return; this.draft = this.entry.value; this.histPos = hist.length; }
    this.histPos = Math.max(0, this.histPos + dir);
    if (this.histPos >= hist.length) { this.histPos = null; this.entry.value = this.draft || ""; }
    else this.entry.value = hist[this.histPos];
    const n = this.entry.value.length;
    try { this.entry.setSelectionRange(n, n); } catch (e) { /* not supported */ }
  }
};

// ================================================================= fine_tune.py
Panels.fine_tune = class extends Panel {
  constructor(app, title) {
    super(app, title || "Fine Tuning");
    this.zDelta = defaultIncrement("z_babystep_values");
    this.sDelta = defaultIncrement("fine_speed_steps");
    this.eDelta = defaultIncrement("fine_flow_steps");
    this.speed = 100; this.extrusion = 100; this.zOffset = 0;
    const L = (this.L = {
      "z+": Button("z-farther", "Z+", "color1", { onclick: (e, b) => this.baby("+", b) }),
      "z-": Button("z-closer", "Z-", "color1", { onclick: (e, b) => this.baby("-", b) }),
      zoffset: Button("refresh", "  0.00mm", "color1", { side: true, onclick: (e, b) => this.baby("reset", b) }),
      "speed+": Button("speed+", "Speed +", "color3", { onclick: (e, b) => this.changeSpeed("+", b) }),
      "speed-": Button("speed-", "Speed -", "color3", { onclick: (e, b) => this.changeSpeed("-", b) }),
      speedfactor: Button("refresh", "  100%", "color3", { side: true, onclick: (e, b) => this.changeSpeed("reset", b) }),
      "extrude+": Button("flow+", "Extrusion +", "color4", { onclick: (e, b) => this.changeExt("+", b) }),
      "extrude-": Button("flow-", "Extrusion -", "color4", { onclick: (e, b) => this.changeExt("-", b) }),
      extrudefactor: Button("refresh", "  100%", "color4", { side: true, onclick: (e, b) => this.changeExt("reset", b) }),
    });
    for (const k of ["zoffset", "speedfactor", "extrudefactor"]) L[k].classList.add("center");
    this.makeSteps();
    this.build();
    this.update({ gcode_move: this.p.stat("gcode_move") || {} });
  }
  /** (Re)create the step selectors from the current increment sets, keeping the selection if it still exists. */
  makeSteps() {
    const keep = (key, cur) => (getIncrements(key).includes(cur) ? cur : defaultIncrement(key));
    this.zDelta = keep("z_babystep_values", this.zDelta);
    this.sDelta = keep("fine_speed_steps", this.sDelta);
    this.eDelta = keep("fine_flow_steps", this.eDelta);
    this.zg = ToggleRow(getIncrements("z_babystep_values"), this.zDelta, (v) => (this.zDelta = v)).el;
    this.sg = ToggleRow(getIncrements("fine_speed_steps"), this.sDelta, (v) => (this.sDelta = v), (v) => `${v}%`).el;
    this.eg = ToggleRow(getIncrements("fine_flow_steps"), this.eDelta, (v) => (this.eDelta = v), (v) => `${v}%`).el;
  }
  editSteps(key) { this.app.editIncrements(key, () => { this.makeSteps(); this.build(); this._created = Date.now(); }); }
  /* Layout (landscape): one column per adjustment, value on top, + then - below, step selectors along
       [ Z value ] [ Speed value ] [ Flow value ]
       [   Z+    ] [  Speed +    ] [ Extrusion + ]
       [   Z-    ] [  Speed -    ] [ Extrusion - ]
       [ Z steps ] [ Speed steps ] [ Flow steps ]
     Portrait stacks the same groups as rows: [+][-][value] with each group's step selector below. */
  build() {
    const L = this.L;
    // the step selector plus a small edit (pencil) button that opens the increment editor
    const withEdit = (row, key) => {
      const edit = Button("edit", null, null, { onclick: () => this.editSteps(key) });
      edit.classList.add("step-edit");
      return el("div", { class: "step-with-edit" }, row, edit);
    };
    const zSteps = withEdit(this.zg, "z_babystep_values");
    const sSteps = withEdit(this.sg, "fine_speed_steps");
    const eSteps = withEdit(this.eg, "fine_flow_steps");
    let g;
    if (this.vertical) {
      g = Grid(3, 6, [
        { w: L["z+"], x: 0, y: 0 }, { w: L["z-"], x: 1, y: 0 }, { w: L.zoffset, x: 2, y: 0 }, { w: zSteps, x: 0, y: 1, cw: 3 },
        { w: L["speed+"], x: 0, y: 2 }, { w: L["speed-"], x: 1, y: 2 }, { w: L.speedfactor, x: 2, y: 2 }, { w: sSteps, x: 0, y: 3, cw: 3 },
        { w: L["extrude+"], x: 0, y: 4 }, { w: L["extrude-"], x: 1, y: 4 }, { w: L.extrudefactor, x: 2, y: 4 }, { w: eSteps, x: 0, y: 5, cw: 3 },
      ]);
      g.style.gridTemplateRows = "minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1fr) auto";
    } else {
      g = Grid(3, 4, [
        { w: L.zoffset, x: 0, y: 0 }, { w: L.speedfactor, x: 1, y: 0 }, { w: L.extrudefactor, x: 2, y: 0 },
        { w: L["z+"], x: 0, y: 1 }, { w: L["speed+"], x: 1, y: 1 }, { w: L["extrude+"], x: 2, y: 1 },
        { w: L["z-"], x: 0, y: 2 }, { w: L["speed-"], x: 1, y: 2 }, { w: L["extrude-"], x: 2, y: 2 },
        { w: zSteps, x: 0, y: 3 }, { w: sSteps, x: 1, y: 3 }, { w: eSteps, x: 2, y: 3 },
      ], "fine-tune-cols");
      // value row shorter than the +/- rows; step row at its natural height
      g.style.gridTemplateRows = "minmax(0,.65fr) minmax(0,1fr) minmax(0,1fr) auto";
    }
    g.classList.add("fill");
    this.el.innerHTML = "";
    this.el.append(g);
  }
  relayout() { this.build(); }
  update(data) {
    const gm = data.gcode_move;
    if (!gm) return;
    if (gm.homing_origin) { this.zOffset = Number(gm.homing_origin[2]); this.L.zoffset.setLabel(`  ${this.zOffset.toFixed(3)}mm`); }
    if (gm.extrude_factor !== undefined) { this.extrusion = Math.round(gm.extrude_factor * 100); this.L.extrudefactor.setLabel(`  ${String(this.extrusion).padStart(3)}%`); }
    if (gm.speed_factor !== undefined) { this.speed = Math.round(gm.speed_factor * 100); this.L.speedfactor.setLabel(`  ${String(this.speed).padStart(3)}%`); }
  }
  baby(dir, b) {
    if (dir === "reset") { this.L.zoffset.setLabel("  0.00mm"); this.gcode("SET_GCODE_OFFSET Z=0 MOVE=1", b); return; }
    this.zOffset += (dir === "+" ? 1 : -1) * parseFloat(this.zDelta);
    this.L.zoffset.setLabel(`  ${this.zOffset.toFixed(3)}mm`);
    this.gcode(`SET_GCODE_OFFSET Z_ADJUST=${dir}${this.zDelta} MOVE=1`, b);
  }
  changeSpeed(dir, b) {
    this.speed = dir === "reset" ? 100 : Math.max(1, this.speed + (dir === "+" ? 1 : -1) * parseInt(this.sDelta));
    this.L.speedfactor.setLabel(`  ${String(this.speed).padStart(3)}%`);
    this.gcode(`M220 S${this.speed}`, b);
  }
  changeExt(dir, b) {
    this.extrusion = dir === "reset" ? 100 : Math.max(1, this.extrusion + (dir === "+" ? 1 : -1) * parseInt(this.eDelta));
    this.L.extrudefactor.setLabel(`  ${String(this.extrusion).padStart(3)}%`);
    this.gcode(`M221 S${this.extrusion}`, b);
  }
};

// ================================================================= limits.py
Panels.limits = class extends Panel {
  constructor(app, title) {
    super(app, title || "Limits");
    const cfg = this.p.configSection("printer");
    const maxVel = parseFloat(cfg.max_velocity || "300"), maxAccel = parseFloat(cfg.max_accel || "3000");
    const scv = parseFloat(cfg.square_corner_velocity || "5"), mcr = parseFloat(cfg.minimum_cruise_ratio || "0.5");
    this.opts = [
      { key: "max_velocity", name: "Max Velocity", units: "mm/s", def: maxVel, max: maxVel * 2, step: 1, cmd: "VELOCITY" },
      { key: "max_accel", name: "Max Acceleration", units: "mm/s²", def: maxAccel, max: maxAccel * 2, step: 1, cmd: "ACCEL" },
      { key: "minimum_cruise_ratio", name: "Minimum Cruise Ratio", units: "", def: mcr, max: 0.99, step: 0.01, cmd: "MINIMUM_CRUISE_RATIO" },
      { key: "square_corner_velocity", name: "Square Corner Velocity", units: "mm/s", def: scv, max: scv * 2, step: 0.1, cmd: "SQUARE_CORNER_VELOCITY" },
    ];
    const list = el("div", { class: "scroll fill" });
    for (const o of this.opts) {
      const scale = el("input", { type: "range", class: "scale", min: "0", max: String(o.max), step: String(o.step) });
      // tap the number to type a value (Rakerscreen extra); the slider grows if it's past its end
      const val = el("span", { class: "scale-val tappable", onclick: () => this.enterValue(o) });
      const paint = (v) => {
        v = Number(v);
        if (v > o.max) { o.max = v; scale.max = String(v); }
        scale.value = v; scale.style.setProperty("--pct", `${Math.min(100, (v / o.max) * 100)}%`); val.textContent = `${v.toFixed(o.step < 1 ? 2 : 0)}`;
      };
      scale.addEventListener("input", () => { paint(scale.value); o.drag = true; });
      scale.addEventListener("change", () => { o.drag = false; this.gcode(`SET_VELOCITY_LIMIT ${o.cmd}=${scale.value}`); });
      const reset = Button("refresh", "Reset", "color1", { side: true, onclick: () => { paint(o.def); this.gcode(`SET_VELOCITY_LIMIT ${o.cmd}=${o.def}`); } });
      reset.style.flex = "0 0 auto";
      Object.assign(o, { paint });
      list.append(el("div", { class: "fan-row" }, el("div", { class: "name" }, `${o.name}${o.units ? " (" + o.units + ")" : ""}`), el("div", { class: "ctl" }, scale, val, reset)));
    }
    this.el.append(list);
    this.update({ toolhead: this.p.stat("toolhead") || {} });
  }
  enterValue(o) {
    const cur = this.p.stat("toolhead", o.key);
    const ratio = o.key === "minimum_cruise_ratio";
    Input.number({
      title: o.name, value: typeof cur === "number" ? Math.round(cur * 100) / 100 : o.def, unit: o.units || undefined, ok: "Set",
      min: 0, max: ratio ? 0.99 : undefined, decimals: o.step < 1 ? 2 : 0, keepOpen: true, // Set applies, Close leaves
      desc: `Printer config: ${o.def}${o.units ? " " + o.units : ""}`,
      onSubmit: (v) => { o.paint(v); this.gcode(`SET_VELOCITY_LIMIT ${o.cmd}=${v}`); },
    });
  }
  update(data) {
    if (!data.toolhead) return;
    for (const o of this.opts) {
      const k = o.key === "minimum_cruise_ratio" ? "minimum_cruise_ratio" : o.key;
      const v = this.p.stat("toolhead", k);
      if (typeof v === "number" && !o.drag) o.paint(v);
    }
  }
};

// ================================================================= zcalibrate.py (simplified)
Panels.zcalibrate = class extends Panel {
  constructor(app, title) {
    super(app, title || "Z Calibrate");
    this.distances = [".01", ".05", ".1", ".5", "1", "5"];
    this.distance = ".1";
    this.pos = el("div", { class: "label", style: { fontSize: "1.3em" } }, "Z: ?");
    this.B = {
      start: Button("resume", "Start", "color3", { onclick: () => this.start() }),
      zp: Button("z-farther", "Raise Nozzle", "color4", { onclick: (e, b) => this.gcode(`TESTZ Z=${this.distance}`, b) }),
      zm: Button("z-closer", "Lower Nozzle", "color1", { onclick: (e, b) => this.gcode(`TESTZ Z=-${this.distance}`, b) }),
      complete: Button("complete", "Accept", "color3", { onclick: (e, b) => this.gcode("ACCEPT", b) }),
      cancel: Button("cancel", "Abort", "color2", { onclick: (e, b) => this.gcode("ABORT", b) }),
    };
    if (Settings.get("invert_z")) [this.B.zp, this.B.zm] = [this.B.zm, this.B.zp];
    const tr = ToggleRow(this.distances, this.distance, (v) => (this.distance = v));
    const g = Grid(4, 4, [{ w: this.pos, x: 0, y: 0 }, { w: this.B.start, x: 0, y: 1 }, { w: this.B.zp, x: 1, y: 0, ch: 2 }, { w: this.B.zm, x: 1, y: 2, ch: 1 },
      { w: this.B.complete, x: 3, y: 0, ch: 2 }, { w: this.B.cancel, x: 3, y: 2 }, { w: el("div", { class: "label" }, "Move Distance (mm)"), x: 0, y: 2, cw: 1 }, { w: tr.el, x: 0, y: 3, cw: 4 }]);
    g.classList.add("fill");
    this.el.append(g);
    this.update({ manual_probe: this.p.stat("manual_probe") || {} });
  }
  update(data) {
    const mp = data.manual_probe;
    if (mp) {
      const active = !!this.p.stat("manual_probe", "is_active");
      for (const k of ["zp", "zm", "complete", "cancel"]) this.B[k].disabled = !active;
      this.B.start.disabled = active;
      const z = this.p.stat("manual_probe", "z_position");
      if (active && typeof z === "number") this.pos.textContent = `Z: ${z.toFixed(3)}`;
    }
    if (data.gcode_move && !this.p.stat("manual_probe", "is_active")) {
      const p = this.p.stat("gcode_move", "gcode_position");
      if (p && (this.p.stat("toolhead", "homed_axes") || "").includes("z")) this.pos.textContent = `Z: ${Number(p[2]).toFixed(3)}`;
    }
  }
  start() {
    const cmds = this.p.availableCommands, methods = [];
    if ("PROBE_CALIBRATE" in cmds) methods.push(["Probe", "PROBE_CALIBRATE"]);
    if ("Z_ENDSTOP_CALIBRATE" in cmds && !this.p.configSection("stepper_z").endstop_pin?.includes("probe")) methods.push(["Endstop", "Z_ENDSTOP_CALIBRATE"]);
    if ("BED_MESH_CALIBRATE" in cmds && "PROBE_CALIBRATE" in cmds) { /* same as probe */ }
    if (!methods.length) { this.app.popup("No calibration method available"); return; }
    // as KlipperScreen's start_calibration: clear offset/mesh, home, lift, move over the calibration point, then calibrate
    const run = (cmd) => {
      const at = this.location(!cmd.startsWith("Z_ENDSTOP_CALIBRATE"));
      if (!at) { this.app.popup("Error: Couldn't get a position to probe"); return; }
      const lines = ["SET_GCODE_OFFSET Z=0"];
      if ("bed_mesh" in this.p.config) lines.push("BED_MESH_CLEAR");
      if ((this.p.stat("toolhead", "homed_axes") || "") !== "xyz") lines.push("G28");
      lines.push(`G91\nG0 Z${at.hop} F${at.hopSpeed * 60}`, `G90\nG0 X${+at.x.toFixed(3)} Y${+at.y.toFixed(3)} F3000`, cmd);
      this.gcode(lines.join("\n"));
    };
    if (methods.length === 1) run(methods[0][1]);
    else this.app.dialog("Calibrate", [...methods.map(([n, c]) => ({ name: n, style: "dialog-default", cb: () => run(c) })), { name: "Cancel", style: "dialog-error" }], "Select calibration method");
  }
  /** zcalibrate.py _get_calibration_location: zero reference, safe_z_home, round-bed origin, mesh centre or bed centre. */
  location(applyProbeOffset) {
    const cfg = (n) => this.p.configSection(n);
    const nums = (s) => String(s).split(",").map((v) => parseFloat(v));
    const probeName = Object.keys(this.p.config).find((k) => /^(probe|bltouch|smart_effector|probe_eddy_current\b.*|beacon|cartographer|scanner)$/.test(k));
    const probe = probeName ? this.p.config[probeName] : {};
    const off = applyProbeOffset ? [parseFloat(probe.x_offset) || 0, parseFloat(probe.y_offset) || 0] : [0, 0];
    let hop = parseFloat(probe.sample_retract_dist) || 5, hopSpeed = parseFloat(probe.speed) || 15;
    const out = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? { x, y, hop, hopSpeed } : null);
    const mesh = cfg("bed_mesh"), safe = cfg("safe_z_home");
    if (mesh.zero_reference_position) { const [x, y] = nums(mesh.zero_reference_position); return out(x - off[0], y - off[1]); }
    if (safe.home_xy_position && !("Z_ENDSTOP_CALIBRATE" in this.p.availableCommands)) {
      const [x, y] = nums(safe.home_xy_position);
      if (safe.z_hop) hop = parseFloat(safe.z_hop) || hop;
      if (safe.z_hop_speed) hopSpeed = parseFloat(safe.z_hop_speed) || hopSpeed;
      return out(x, y); // KlipperScreen doesn't shift the safe-home point by the probe offset
    }
    if (mesh.mesh_radius || /delta/.test(cfg("printer").kinematics || "")) {
      const [x, y] = mesh.mesh_origin ? nums(mesh.mesh_origin) : [0, 0];
      return out(x - off[0], y - off[1]);
    }
    let min, max;
    if (mesh.mesh_min && mesh.mesh_max) { min = nums(mesh.mesh_min); max = nums(mesh.mesh_max); }
    else if (mesh.min_x && mesh.max_x) { min = [parseFloat(mesh.min_x), parseFloat(mesh.min_y)]; max = [parseFloat(mesh.max_x), parseFloat(mesh.max_y)]; }
    if (min && max) return out((min[0] + max[0]) / 2 - off[0], (min[1] + max[1]) / 2 - off[1]);
    const mx = parseFloat(cfg("stepper_x").position_max), my = parseFloat(cfg("stepper_y").position_max);
    if (Number.isFinite(mx) && Number.isFinite(my)) return out(mx / 2 - off[0], my / 2 - off[1]);
    // last resort (not in KlipperScreen): the centre of the travel range Klipper reports
    const lo = this.p.stat("toolhead", "axis_minimum"), hi = this.p.stat("toolhead", "axis_maximum");
    if (lo && hi) return out((lo[0] + hi[0]) / 2 - off[0], (lo[1] + hi[1]) / 2 - off[1]);
    return null;
  }
};

// ================================================================= camera.py (MJPEG streams)
Panels.camera = class extends Panel {
  constructor(app, title) {
    super(app, title || "Camera");
    this.idx = 0;
    this.img = el("img", { style: { width: "100%", height: "100%", objectFit: "contain" } });
    this.el.append(el("div", { class: "fill", style: { display: "flex" } }, this.img));
    if (app.webcams.length > 1) {
      const bar = el("div", { class: "sortbar" });
      app.webcams.forEach((w, i) => bar.append(Button(null, w.name, `color${(i % 4) + 1}`, { side: true, lines: 1, onclick: () => { this.idx = i; this.activate(); } })));
      this.el.append(bar);
    }
  }
  streamUrl(w) {
    let u = w.stream_url || "";
    if (u.startsWith("/")) u = `http://${Settings.get("moonraker_host")}:${Settings.get("webui_port") || 8888}${u}`;
    return u;
  }
  activate() { const w = this.app.webcams[this.idx]; if (w) { this.img.style.transform = `${w.flip_horizontal ? "scaleX(-1)" : ""} ${w.flip_vertical ? "scaleY(-1)" : ""} rotate(${w.rotation || 0}deg)`; this.img.src = this.streamUrl(w); } }
  deactivate() { this.img.removeAttribute("src"); } // stops the MJPEG stream; src="" would re-request the page
};

// ================================================================= notifications.py
Panels.notifications = class extends Panel {
  constructor(app, title) {
    super(app, title || "Notifications");
    this.list = el("div", { class: "scroll fill" });
    this.el.append(this.list, el("div", { class: "sortbar" },
      Button("delete", "Clear", "color2", { side: true, lines: 1, onclick: () => { app.notifications = []; this.refresh(); } }),
      Button("warning", "Error Report", "color1", { side: true, lines: 1, onclick: () => app.shareReport() })));
  }
  activate() { this.app.notificationIcon(0); this.refresh(); }
  refresh() {
    this.list.innerHTML = "";
    const cls = { 1: "message_popup_echo", 2: "message_popup_warning", 3: "message_popup_error" };
    for (const n of [...this.app.notifications].reverse()) {
      this.list.append(el("div", { class: `frame-item`, style: { borderLeft: `.4em solid ${n.level >= 3 ? "var(--error)" : n.level === 2 ? "var(--warning)" : "var(--echo)"}` } },
        el("div", { class: "grow" }, el("div", { class: "desc" }, n.time.toLocaleString()), el("div", { class: cls[n.level] ? "" : "" }, n.message))));
    }
    if (!this.app.notifications.length) this.list.append(el("div", { class: "label", style: { height: "100%" } }, "No notifications"));
  }
};

// ================================================================= Logs (Rakerscreen extra)
/** Tail of klippy.log / moonraker.log from Moonraker, and Rakerscreen's own log. */
const LOG_TABS = [["klipper", "Klipper", "klippy.log"], ["moonraker", "Moonraker", "moonraker.log"], ["rakerscreen", "Rakerscreen", null]];
const LOG_TAIL_BYTES = 256 * 1024;
let logReqId = 0;
const logWaiters = {};
window.__pslog = (id, code, text) => { const w = logWaiters[id]; if (w) { delete logWaiters[id]; w(code, text); } };
/** Last part of a Moonraker log file: native fetch in the app, plain fetch in a browser. */
function fetchMoonrakerLog(app, name, bytes = LOG_TAIL_BYTES) {
  const key = Settings.get("moonraker_api_key") || "";
  if (window.PSBridge && PSBridge.fetchLog) {
    return new Promise((resolve, reject) => {
      const id = ++logReqId;
      const timer = setTimeout(() => { delete logWaiters[id]; reject(new Error("Timed out")); }, 20000);
      logWaiters[id] = (code, text) => {
        clearTimeout(timer);
        if (code === 200 || code === 206) resolve(text);
        else reject(new Error(code ? `Moonraker answered HTTP ${code}` : text || "Request failed"));
      };
      // numbers must be real numbers here: Android turns a string passed for an int into 0
      const host = String(Settings.get("moonraker_host") || "").trim().replace(/^\w+:\/\//, "").replace(/[/:].*$/, "");
      PSBridge.fetchLog(id, host, parseInt(app.mr.port(), 10) || 7125, name, key, Math.round(bytes));
    });
  }
  const headers = { Range: `bytes=-${bytes}` };
  if (key) headers["X-Api-Key"] = key;
  return fetch(`${app.mr.httpBase()}/server/files/logs/${name}`, { headers, cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Moonraker answered HTTP ${r.status}`);
    return r.text();
  });
}
const cfgWaiters = {};
window.__pscfg = (id, code, text) => { const w = cfgWaiters[id]; if (w) { delete cfgWaiters[id]; w(code, text); } };
/** Read (text undefined) or write a file in Moonraker's config folder, next to printer.cfg.
    Resolves with the file text (read) or Moonraker's answer (write); a missing file reads as null. */
function moonrakerConfigFile(app, name, text) {
  const key = Settings.get("moonraker_api_key") || "";
  const upload = typeof text === "string";
  const done = (code, body) => {
    if (code === 200 || code === 201) return body;
    if (!upload && code === 404) return null;
    throw new Error(code ? `Moonraker answered HTTP ${code}` : body || "Request failed");
  };
  if (window.PSBridge && PSBridge.configFile) {
    return new Promise((resolve, reject) => {
      const id = ++logReqId;
      const timer = setTimeout(() => { delete cfgWaiters[id]; reject(new Error("Timed out")); }, 20000);
      cfgWaiters[id] = (code, body) => { clearTimeout(timer); try { resolve(done(code, body)); } catch (e) { reject(e); } };
      const host = String(Settings.get("moonraker_host") || "").trim().replace(/^\w+:\/\//, "").replace(/[/:].*$/, "");
      PSBridge.configFile(id, host, parseInt(app.mr.port(), 10) || 7125, name, key, upload ? text : null);
    });
  }
  const headers = key ? { "X-Api-Key": key } : {};
  let req;
  if (upload) {
    const form = new FormData();
    form.append("root", "config");
    form.append("file", new Blob([text], { type: "text/plain" }), name);
    req = fetch(`${app.mr.httpBase()}/server/files/upload`, { method: "POST", headers, body: form });
  } else req = fetch(`${app.mr.httpBase()}/server/files/config/${name}`, { headers, cache: "no-store" });
  return req.then(async (r) => done(r.status, await r.text()));
}
Panels.logs = class extends Panel {
  constructor(app, title) {
    super(app, title || "Logs");
    this.tab = "klipper";
    this.req = 0;
    this.text = el("pre", { class: "log-text scroll fill" });
    this.status = el("span", { class: "log-status" });
    const tabs = ToggleRow(LOG_TABS.map((t) => t[0]), this.tab, (v) => { this.tab = v; this.load(); }, (v) => LOG_TABS.find((t) => t[0] === v)[1]);
    tabs.el.classList.add("log-tabs");
    const share = window.PSBridge && PSBridge.shareText
      ? Button(null, "Share", "color3", { side: true, lines: 1, onclick: () => PSBridge.shareText(`${this.tabName()} log`, this.current || "") })
      : Button(null, "Copy", "color3", { side: true, lines: 1, onclick: () => this.copy() });
    this.el.append(tabs.el, this.text, el("div", { class: "sortbar log-bar" }, this.status,
      Button("arrow-down", "Newest", "color4", { side: true, lines: 1, onclick: () => (this.text.scrollTop = this.text.scrollHeight) }),
      Button("refresh", "Refresh", "color1", { side: true, lines: 1, onclick: () => this.load() }), share));
  }
  tabName() { return LOG_TABS.find((t) => t[0] === this.tab)[1]; }
  activate() { this.load(); }
  copy() {
    const t = this.current || "";
    if (window.PSBridge && PSBridge.copyText) { PSBridge.copyText(t); this.app.popup("Log copied", 1); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => this.app.popup("Log copied", 1), () => this.app.popup("Copy failed"));
  }
  /** Show text, newest at the bottom; tail: the first line was cut mid-way, drop it. Keeps the last 2000 lines. */
  show(text, tail) {
    let lines = text.replace(/\r/g, "").split("\n");
    if (tail && lines.length > 1) lines.shift();
    if (lines.length > 2000) lines = lines.slice(-2000);
    this.current = lines.join("\n");
    this.text.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const cls = /(^|\s)(!!|ERROR|Error|error:|Traceback|Exception|Internal error|shutdown)/.test(l) ? "log-err" : /WARNING|warning/.test(l) ? "log-warn" : null;
      frag.append(cls ? el("span", { class: cls }, l + "\n") : document.createTextNode(l + "\n"));
    }
    this.text.append(frag);
    this.text.scrollTop = this.text.scrollHeight;
  }
  async load() {
    const tab = LOG_TABS.find((t) => t[0] === this.tab);
    const req = ++this.req;
    if (!tab[2]) {
      this.show([this.app.buildReport(), "", "Log since start:", ...AppLog.lines].join("\n"));
      this.status.textContent = `Rakerscreen ${VERSION} · ${AppLog.lines.length} line${AppLog.lines.length === 1 ? "" : "s"}`;
      return;
    }
    this.status.textContent = `Loading ${tab[2]}…`;
    try {
      const text = await fetchMoonrakerLog(this.app, tab[2]);
      if (req !== this.req) return; // another tab was picked meanwhile
      this.show(text, text.length >= LOG_TAIL_BYTES * 0.99);
      this.status.textContent = `${tab[2]} · last ${Math.max(1, Math.round(text.length / 1024))} KB · ${new Date().toTimeString().slice(0, 5)}`;
    } catch (e) {
      if (req !== this.req) return;
      this.current = "";
      this.text.textContent = `Couldn't load ${tab[2]}: ${e.message}`;
      this.status.textContent = "";
    }
  }
};

// ================================================================= system.py (simplified)
Panels.system = class extends Panel {
  constructor(app, title) {
    super(app, title || "System");
    this.info = el("div", { class: "scroll fill", style: { padding: ".5em", whiteSpace: "pre-wrap" } }, "Loading...");
    this.el.append(this.info, el("div", { class: "sortbar" },
      Button("refresh", "Klipper Restart", "color1", { side: true, lines: 1, onclick: () => this.mr.call("printer.restart").catch(() => {}) }),
      Button("refresh", "Firmware Restart", "color2", { side: true, lines: 1, onclick: () => this.mr.call("printer.firmware_restart").catch(() => {}) }),
      Button("refresh", "Moonraker Restart", "color3", { side: true, lines: 1, onclick: () => this.mr.call("server.restart").catch(() => {}) }),
      Button("warning", "Error Report", "color4", { side: true, lines: 1, onclick: () => app.shareReport() }),
      Button("refresh", "Check for Updates", "color1", { side: true, lines: 1, onclick: () => app.updater.check(true) })));
  }
  async activate() {
    const lines = [];
    const si = this.app.serverInfo || {};
    lines.push(`Moonraker: ${si.moonraker_version || "?"}  (API ${(si.api_version_string || "?")})`);
    try { const pi = await this.mr.call("printer.info"); lines.push(`Klipper: ${pi.software_version}`, `Host: ${pi.hostname}`, `State: ${pi.state}`); } catch (e) { /* */ }
    try {
      const s = (await this.mr.call("machine.system_info")).system_info || {};
      if (s.cpu_info) lines.push(`CPU: ${s.cpu_info.model || s.cpu_info.processor || ""} x${s.cpu_info.cpu_count || "?"}`, `Memory: ${formatSize((s.cpu_info.total_memory || 0) * 1024)}`);
      if (s.distribution) lines.push(`OS: ${s.distribution.name || ""} ${s.distribution.version || ""}`);
    } catch (e) { /* */ }
    lines.push("", `Rakerscreen ${VERSION}`, `Endpoint: ${this.mr.url()}`, `Transport: ${this.mr.native ? "native (Android)" : "browser WebSocket"}`);
    if ((si.warnings || []).length) lines.push("", "Warnings:", ...si.warnings);
    this.info.textContent = lines.join("\n");
  }
};

// ================================================================= shutdown.py
/* Same layout as KlipperScreen. Moonraker runs on this phone, so KlipperScreen's "printer_is_local"
   path applies: one Accept button, sent to Moonraker as machine.shutdown / machine.reboot. Whether
   Klip Pocket can actually power off or reboot the phone depends on it; errors are shown. */
Panels.shutdown = class extends Panel {
  constructor(app, title) {
    super(app, title || "Shutdown");
    const showEstop = !["disconnected", "startup", "shutdown", "error"].includes(this.p.state);
    const estop = Button("emergency", "Emergency Stop", "color2", { onclick: () => app.emergencyStop() });
    const poweroff = Button("shutdown", "Shutdown", "color1", { onclick: () => this.rebootPoweroff("shutdown") });
    const restart = Button("refresh", "Restart Klipper", "color3", { onclick: () => this.rebootPoweroff("reboot") });
    const restartKs = Button("refresh", "Restart Rakerscreen", "color3", { onclick: () => location.reload() });
    const lock = Button("lock", "Lock", "color3", { onclick: () => app.lock() });
    const items = [{ w: restartKs, x: 1, y: 0 }, { w: lock, x: 2, y: 0 }, { w: poweroff, x: 1, y: 1 }, { w: restart, x: 2, y: 1 }];
    if (showEstop) items.push({ w: estop, x: 0, y: 0, ch: 2 });
    const g = Grid(3, 2, items);
    g.classList.add("fill");
    this.el.append(g);
  }
  rebootPoweroff(method) {
    const action = Settings.get(`${method}_action`);
    // Restart is a Klipper restart (printer.restart, like RESTART); Shutdown powers off the host
    const run = () => (method === "reboot" ? this.mr.call("printer.restart") : this.mr.call("machine.shutdown"))
      .catch((e) => this.app.popup(method === "reboot" ? `Failed to restart Klipper: ${e.message}` : `Failed to power off host: ${e.message}`));
    // power_action_response: skip the dialog unless set to ask, always ask while printing
    if (action && action !== "ask" && !this.p.isPrinting()) { run(); return; }
    this.app.dialog(method === "reboot" ? "Restart Klipper" : "Shutdown", [
      { name: "Accept", style: "dialog-primary", cb: run },
      { name: "Cancel", style: "dialog-error" },
    ], method === "reboot" ? "Restart Klipper?\n\nKlipper reloads printer.cfg; a running print is stopped." : "Are you sure you wish to shutdown the system?");
  }
};

// ================================================================= led.py (simplified)
Panels.led = class extends Panel {
  constructor(app, title) {
    super(app, title || "Leds");
    this.rows = {};
    const list = el("div", { class: "scroll fill" });
    for (const led of this.p.leds) {
      const name = led.split(" ").slice(1).join(" ");
      if (name.startsWith("_")) continue;
      const cfg = this.p.configSection(led);
      const hasWhite = /W/i.test(cfg.color_order || "") || "white_pin" in cfg;
      const chans = hasWhite ? ["RED", "GREEN", "BLUE", "WHITE"] : ["RED", "GREEN", "BLUE"];
      const swatch = el("div", { class: "led-swatch" });
      const sliders = {};
      const body = el("div", { class: "grow" });
      for (const c of chans) {
        const s = el("input", { type: "range", class: "scale", min: "0", max: "255", step: "1" });
        const v = el("span", { class: "scale-val" });
        s.addEventListener("input", () => { this.paint(led); });
        s.addEventListener("change", () => this.send(led));
        sliders[c] = { s, v };
        body.append(el("div", { class: "ctl", style: { display: "flex", alignItems: "center" } }, el("span", { style: { width: "4.5em" } }, prettify(c.toLowerCase())), s, v));
      }
      const preset = (label, vals, i) => Button(null, label, `color${(i % 4) + 1}`, { side: true, lines: 1, onclick: () => { chans.forEach((c, j) => (sliders[c].s.value = vals[j] ?? 0)); this.paint(led); this.send(led); } });
      const presets = el("div", { class: "sortbar" }, preset("Off", [0, 0, 0, 0], 0), preset("White", hasWhite ? [0, 0, 0, 255] : [255, 255, 255], 1),
        preset("Red", [255, 0, 0, 0], 2), preset("Green", [0, 255, 0, 0], 3), preset("Blue", [0, 0, 255, 0], 0));
      this.rows[led] = { name, chans, sliders, swatch };
      list.append(el("div", { class: "fan-row" }, el("div", { class: "name", style: { display: "flex", gap: ".5em", alignItems: "center" } }, swatch, prettify(name)), body, presets));
    }
    this.el.append(list);
    this.update(Object.fromEntries(this.p.leds.map((l) => [l, {}])));
  }
  paint(led) {
    const r = this.rows[led];
    const val = (c) => parseInt(r.sliders[c] ? r.sliders[c].s.value : 0);
    for (const c of r.chans) { const s = r.sliders[c]; s.v.textContent = s.s.value; s.s.style.setProperty("--pct", `${(s.s.value / 255) * 100}%`); }
    const w = val("WHITE");
    r.swatch.style.background = `rgb(${Math.min(255, val("RED") + w)},${Math.min(255, val("GREEN") + w)},${Math.min(255, val("BLUE") + w)})`;
  }
  send(led) {
    const r = this.rows[led];
    const parts = r.chans.map((c) => `${c}=${(parseInt(r.sliders[c].s.value) / 255).toFixed(3)}`);
    this.gcode(`SET_LED LED="${r.name}" ${parts.join(" ")} SYNC=0 TRANSMIT=1`);
  }
  update(data) {
    for (const [led, r] of Object.entries(this.rows)) {
      if (!(led in data)) continue;
      const cd = this.p.stat(led, "color_data");
      if (!Array.isArray(cd) || !cd.length) { this.paint(led); continue; }
      const first = cd[0];
      r.chans.forEach((c, i) => { if (document.activeElement !== r.sliders[c].s) r.sliders[c].s.value = Math.round((first[i] || 0) * 255); });
      this.paint(led);
    }
  }
};

// ================================================================= settings (ks_includes/config.py + panels/settings.py)
const BLANKING_OPTIONS = [["off", "Never"], ["60", "1 minute"], ["120", "2 minutes"], ["300", "5 minutes"], ["900", "15 minutes"],
  ["1800", "30 minutes"], ["3600", "1 hour"], ["7200", "2 hours"], ["14400", "4 hours"]];
const shortcutChoices = (withOff) => [...(withOff ? [["off", "Off (hidden)"]] : []),
  ...Object.entries(SHORTCUT_TARGETS).map(([k, v]) => [k, v.name + (v.extra ? " +" : "")])];
const reloadCb = (app) => app.reloadPanels();
/* KlipperScreen's configurable_options in the same order (categories appear in order of first use),
   plus two Rakerscreen extras marked as such. */
const KS_OPTIONS = [
  { key: "theme", cat: "Appearance", name: "Icon Theme", type: "dropdown", tip: "Changes how the interface looks",
    options: [["z-bolt", "Z-bolt (default)"], ["colorized", "colorized"], ["material-dark", "material-dark"], ["material-darker", "material-darker"], ["material-light", "material-light"]],
    cb: () => location.reload() },
  { key: "print_estimate_method", cat: "Printing", name: "Estimated Time Method", type: "dropdown", tip: "Changes how the time remaining is calculated",
    options: [["auto", "Auto (default)"], ["file", "File"], ["filament", "Filament Used"], ["slicer", "Slicer"]] },
  { key: "screen_blanking", cat: "Display", name: "Screen Power Off Time", type: "dropdown", tip: "Timeout for screen black-out or power-off",
    options: BLANKING_OPTIONS, cb: (app) => app.resetScreensaver() },
  { key: "screen_blanking_printing", cat: "Display", name: "Screen Power Off Time (Printing)", type: "dropdown", tip: "Timeout for screen black-out or power-off during printing",
    options: BLANKING_OPTIONS, cb: (app) => app.resetScreensaver() },
  { key: "24htime", cat: "Appearance", name: "24 Hour Time", type: "binary", tip: "Disable for 12hs with am / pm", cb: (app) => app.updateTime() },
  { key: "side_shortcut_target", cat: "Behaviour", name: "Action bar Shortcut", type: "dropdown", options: shortcutChoices(false), cb: (app) => app.updateShortcuts() },
  { key: "side_shortcut_2", cat: "Behaviour", name: "Second Action bar Shortcut", type: "dropdown", extra: true,
    tip: "Adds another button to the action bar. + marks targets KlipperScreen doesn't offer", options: shortcutChoices(true), cb: (app) => app.updateShortcuts() },
  { key: "font_size", cat: "Appearance", name: "Font Size", type: "dropdown", tip: "Inversely affects the icon size",
    options: [["small", "Small"], ["medium", "Medium (default)"], ["large", "Large"], ["extralarge", "Extra Large"], ["max", "Maximum"]],
    cb: (app) => { app.reloadPanels(); app.layout(); } },
  { key: "confirm_estop", cat: "Behaviour", name: "Confirm Emergency Stop", type: "binary", tip: "Asks for confirmation before stopping" },
  { key: "shutdown_action", cat: "Behaviour", name: "Shutdown Action", type: "dropdown",
    tip: "Skips the confirmation and shuts down the selected target. Always asks while printing",
    options: [["ask", "Ask (default)"], ["host", "Host"], ["printer", "Printer"], ["both", "Both"]] },
  { key: "reboot_action", cat: "Behaviour", name: "Restart Klipper", type: "dropdown",
    tip: "Whether Restart Klipper asks first. Always asks while printing",
    options: [["ask", "Ask (default)"], ["host", "Don't ask"]] },
  { key: "only_heaters", cat: "Appearance", name: "Hide sensors in Temp.", type: "binary", tip: "Show only devices that are able to be set", cb: reloadCb },
  { key: "use_dpms", cat: "Display", name: "Screen DPMS", type: "binary",
    tip: "Enable screen power management\nOn Android this turns the backlight down to minimum while the screen is blanked" },
  { key: "autoclose_popups", cat: "Behaviour", name: "Auto-close notifications", type: "binary", tip: "Close messages after a timeout" },
  { key: "show_heater_power", cat: "Appearance", name: "Show Heater Power", type: "binary", tip: "Current percentage and graph line", cb: reloadCb },
  { key: "show_scroll_steppers", cat: "Appearance", name: "Show Scrollbars Buttons", type: "binary",
    tip: "Useful for un-responsive touchscreens (Rakerscreen shows wider scrollbars)", cb: (app) => app.applyAppearance() },
  { key: "auto_open_extrude", cat: "Printing", name: "Auto-open Extrude On Pause", type: "binary" },
  { key: "show_cursor", cat: "Appearance", name: "Show cursor", type: "binary", tip: "For mouse control or to verify touchscreen accuracy", cb: (app) => app.applyAppearance() },
  { key: "orientation", cat: "Display", name: "Screen Orientation", type: "dropdown", extra: true,
    tip: "Forces the screen to one orientation. Either side: turns 180° with the phone. Auto follows Android's rotation lock",
    options: [["auto", "Auto (default)"], ["sensor", "Auto (ignore rotation lock)"],
      ["landscape", "Landscape (either side)"], ["landscape_fixed", "Landscape"], ["landscape_reverse", "Landscape (flipped)"],
      ["portrait", "Portrait (either way)"], ["portrait_fixed", "Portrait"], ["portrait_reverse", "Portrait (upside down)"]],
    cb: (app) => app.applyOrientation() },
  { key: "screensaver_wake_delay", cat: "Display", name: "Screen wake delay", type: "dropdown", tip: "Helps to prevent unwanted touchs during screen wake up",
    options: [0, 1, 2, 3, 4, 5].map((n) => [String(n), `${n} ${n === 1 ? "second" : "seconds"}`]) },
  { key: "screensaver", cat: "Display", name: "Screensaver", type: "dropdown", extra: true,
    tip: "Shown after the Screen Power Off Time. Picking one shows a preview: touch to close it",
    options: Screensavers.list, cb: (app) => setTimeout(() => app.showScreensaver(true), 300) },
  { key: "screensaver_blackout", cat: "Display", name: "Screensaver Black-out", type: "dropdown", extra: true,
    tip: "Turns an animated screensaver into a black screen after this long (and dims the backlight with Screen DPMS)",
    options: [["0", "Never"], ["300", "5 minutes"], ["900", "15 minutes"], ["1800", "30 minutes"], ["3600", "1 hour"], ["7200", "2 hours"]] },
  { key: "lock_password", cat: "Behaviour", name: "Lock Password", type: "entry", password: true, extra: true,
    tip: "Asked when unlocking the Lock screen. Empty: tap to unlock" },
  { key: "enable_addons", cat: "Others", name: "Enable Add-ons", type: "binary", disabled: true,
    tip: "Runs third-party code from the addons folder at startup. Not available in Rakerscreen: Android apps can't load KlipperScreen's Python add-ons" },
];

/** One settings row (ScreenPanel.add_option): binary -> switch, dropdown -> picker, entry/number -> input */
function optionRow(app, def) {
  const ctl = (() => {
    if (def.type === "binary") {
      const s = el("div", { class: "switch" + (Settings.get(def.key) ? " on" : "") });
      if (!def.disabled) s.addEventListener("click", () => {
        Settings.set(def.key, !Settings.get(def.key)); s.classList.toggle("on", !!Settings.get(def.key)); if (def.cb) def.cb(app);
      });
      return s;
    }
    if (def.type === "dropdown") {
      const label = () => { const o = def.options.find(([v]) => String(v) === String(Settings.get(def.key))); return o ? o[1] : String(Settings.get(def.key)); };
      const b = Button(null, label(), "dropdown", { lines: 1 });
      b.addEventListener("click", () => {
        let close;
        // landscape: spread long option lists over columns so the picker needs no scrolling
        const n = def.options.length;
        const cols = app.vertical ? 1 : n > 8 ? 3 : n > 4 ? 2 : 1;
        const list = el("div", { class: `choice-list cols${cols}` });
        for (const [v, l] of def.options) {
          const ob = Button(null, l, String(v) === String(Settings.get(def.key)) ? "selected" : null, { lines: 1, onclick: () => {
            close(); Settings.set(def.key, v); b.setLabel(label()); if (def.cb) def.cb(app);
          } });
          list.append(ob);
        }
        close = app.dialog(def.name, [{ name: "Cancel", style: "dialog-error" }], list);
      });
      return b;
    }
    const i = el("input", { class: "entry", type: def.password ? "password" : "text",
      value: String(Settings.get(def.key) ?? ""), placeholder: def.placeholder || "",
      "data-kb": def.kb || (def.type === "number" ? "numeric" : "text") });
    if (def.type === "number") { i.min = def.min; i.max = def.max; i.style.width = "6em"; }
    i.addEventListener("change", () => {
      let v = i.value.trim();
      if (def.type === "number") { v = Math.max(def.min, Math.min(def.max, parseFloat(v) || def.min)); i.value = v; }
      Settings.set(def.key, v); if (def.cb) def.cb(app);
    });
    return i;
  })();
  const tip = def.tip ? el("div", { class: "desc" }, def.tip.replace(/\n/g, " - ")) : null;
  const name = el("div", { class: "title" }, def.name, def.extra ? el("span", { class: "desc" }, "  Rakerscreen") : null);
  return el("div", { class: "opt-row" + (def.disabled ? " disabled" : "") }, el("div", { class: "grow" }, name, tip), ctl);
}

/* Landscape: the top level is a KlipperScreen-style button grid and each category is a two-column
   grid sized to the screen, so everything fits without scrolling. Portrait keeps a scrolling list. */
const SETTINGS_ICONS = { "Heat Sync": "heat-up", Appearance: "light", Printing: "printer", Display: "info", Behaviour: "custom-script",
  Others: "hashtag", Increments: "fine-tune", "Printer Connections": "network", Language: "file", Updates: "refresh" };
Panels.settings = class extends Panel {
  constructor(app, title) {
    super(app, title || "Rakerscreen");
    this.baseTitle = this.title;
    this.view = el("div", { class: "fill" });
    this.el.append(this.view);
    this.sub = null;
    this.showTop();
  }
  categories() {
    const cats = [];
    for (const o of KS_OPTIONS) if (!cats.includes(o.cat)) cats.push(o.cat);
    return cats;
  }
  setHeading(name) {
    this.title = name ? `${this.baseTitle}: ${name}` : this.baseTitle;
    if (this.app.current() && this.app.current().panel === this) this.app.setTitle(this.title);
  }
  showTop() {
    this.sub = null;
    this.setHeading(null);
    const entries = [...this.categories().map((c) => [c, () => this.showCategory(c)]),
      ["Increments", () => this.showIncrements()], ["Heat Sync", () => this.app.showPanel("heat_sync")],
      ["Printer Connections", () => this.showConnections()], ["Language", () => this.showLanguage()],
      ["Updates", () => this.showUpdates()]];
    const btns = entries.map(([name, fn], i) => Button(SETTINGS_ICONS[name] || "settings", name, `color${(i % 4) + 1}`, { onclick: fn }));
    const grid = AutoGrid(btns, this.vertical ? 2 : 4, false, false);
    grid.style.height = "100%";
    this.view.className = "fill";
    this.view.innerHTML = "";
    this.view.append(grid);
    this.app.updateActionBar();
  }
  /** Lay rows out: two equal-height columns that fill the screen in landscape, a scroll list in portrait. */
  place(name, rows) {
    this.sub = name;
    this.setHeading(name);
    this.view.innerHTML = "";
    if (this.vertical) {
      this.view.className = "scroll fill";
      rows.forEach((r) => this.view.append(r));
    } else {
      const n = Math.ceil(rows.length / 2);
      this.view.className = "fill settings-fit";
      this.view.style.gridTemplateRows = `repeat(${n}, minmax(0, 1fr))`;
      // fill column by column so related options stay together
      rows.forEach((r, i) => { r.style.gridColumn = String(Math.floor(i / n) + 1); r.style.gridRow = String((i % n) + 1); this.view.append(r); });
    }
    this.app.updateActionBar();
  }
  showCategory(cat) {
    this.place(cat, KS_OPTIONS.filter((x) => x.cat === cat).map((o) => optionRow(this.app, o)));
  }
  /** Every step selector's values, each with an Edit button (comma-separated list + Default). */
  showIncrements() {
    const rows = Object.entries(INCREMENT_SETS).map(([key, set]) => {
      const vals = getIncrements(key);
      const custom = JSON.stringify(vals) !== JSON.stringify(set.def);
      const edit = Button("edit", "Edit", custom ? "color3" : null, { side: true, lines: 1, onclick: () => this.app.editIncrements(key, () => this.showIncrements()) });
      return el("div", { class: "opt-row" }, el("div", { class: "grow" },
        el("div", { class: "title" }, set.name),
        el("div", { class: "desc" }, `${vals.join(", ")} ${set.unit}${custom ? "  (custom)" : ""}`)), edit);
    });
    this.place("Increments", rows);
  }
  relayout() {
    if (!this.sub) this.showTop();
    else if (this.sub === "Increments") this.showIncrements();
    else if (this.sub === "Printer Connections") this.showConnections();
    else if (this.sub === "Language") this.showLanguage();
    else if (this.sub === "Updates") this.showUpdates();
    else this.showCategory(this.sub);
  }
  showConnections() {
    const app = this.app;
    const defs = [
      { key: "moonraker_host", name: "Moonraker host", type: "entry", placeholder: "127.0.0.1", tip: "127.0.0.1 when Klipper runs on this phone (Klip Pocket / Beam)" },
      { key: "moonraker_port", name: "Moonraker port", type: "entry", kb: "numeric", placeholder: "7125", tip: "7125 is Moonraker's default" },
      { key: "auto_port", name: "Auto-detect port", type: "binary", extra: true, tip: "If the port refuses, also try 7125, 8888, 7126 and 80" },
      { key: "moonraker_api_key", name: "API key", type: "entry", password: true, tip: "Only needed if Moonraker requires authorization" },
      { key: "webui_port", name: "Web UI port", type: "entry", kb: "numeric", placeholder: "8888", extra: true, tip: "Used for relative webcam URLs" },
    ];
    const rows = defs.map((d) => optionRow(app, d));
    const connect = Button("refresh", "Connect", "color3", { side: true, lines: 1, onclick: () => app.connectNow() });
    const report = Button("warning", "Report", "color2", { side: true, lines: 1, onclick: () => app.shareReport() });
    rows.push(
      el("div", { class: "opt-row" }, el("div", { class: "grow" }, el("div", { class: "title" }, "Reconnect"), el("div", { class: "desc" }, `Now: ${Settings.get("moonraker_host")}:${this.mr.port()}`)), connect),
      el("div", { class: "opt-row" }, el("div", { class: "grow" }, el("div", { class: "title" }, "Error report"), el("div", { class: "desc" }, "Errors only, repeats collapsed. No API key or settings values.")), report));
    this.place("Printer Connections", rows);
  }
  showLanguage() {
    const ok = icon("complete"); ok.classList.add("chev");
    this.place("Language", [
      el("div", { class: "opt-row" }, el("div", { class: "grow" }, el("div", { class: "title" }, "System language / English (en)")), ok),
      el("div", { class: "opt-row disabled" }, el("div", { class: "grow" }, el("div", { class: "desc" }, "Rakerscreen is English-only for now; KlipperScreen's translations aren't ported.")))]);
  }
  canGoBack() { return !!this.sub; }
  /** Self-update (update.js): installed and latest version, check / install, automatic checks. */
  showUpdates() {
    const u = this.app.updater;
    if (this.offUpdate) this.offUpdate();
    const status = el("div", { class: "desc" });
    const action = Button("refresh", "Check now", "color1", { side: true, lines: 1, onclick: () => (u.state === "available" && u.latest && u.latest.url ? u.install() : u.check(true)) });
    const refresh = () => {
      status.textContent = u.statusText();
      const canInstall = u.state === "available" && u.latest && u.latest.url;
      action.setLabel(canInstall ? `Update to v${u.latest.version}` : "Check now");
      action.classList.toggle("disabled", u.busy());
    };
    const row = (title, desc, ctl) => el("div", { class: "opt-row" }, el("div", { class: "grow" }, el("div", { class: "title" }, title), desc), ctl || null);
    const rows = [
      row("Installed version", el("div", { class: "desc" }, `Rakerscreen ${VERSION}`)),
      row("Latest release", status, action),
      optionRow(this.app, { key: "auto_update", name: "Check automatically", type: "binary",
        tip: "At startup and every 6 hours. Never interrupts a print; a failed check stays quiet" }),
      row("Source", el("div", { class: "desc" }, `github.com/${UPDATE_REPO}\nUpdates need the same signing key as the installed app`)),
    ];
    this.place("Updates", rows);
    refresh();
    this.offUpdate = u.onChange(() => { if (this.sub === "Updates") refresh(); });
    if (u.state === "idle" || (u.state !== "checking" && Date.now() - u.lastCheck > 10 * 60 * 1000)) u.check(false);
  }
  back() { if (this.sub) { this.showTop(); return true; } return false; }
};

// ================================================================= move.py options menu (the gear button)
Panels.move_options = class extends Panel {
  constructor(app, title) {
    super(app, title || "Settings");
    const cfg = this.p.configSection("printer");
    const maxV = Math.max(parseInt(parseFloat(cfg.max_velocity || "500")), 2);
    const maxZ = Math.max(parseInt(parseFloat(cfg.max_z_velocity || cfg.max_velocity || "50")), 2);
    const list = el("div", { class: "scroll fill" });
    const defs = [
      { key: "invert_x", name: "Invert X", type: "binary", tip: "This will affect screw positions and mesh graph" },
      { key: "invert_y", name: "Invert Y", type: "binary", tip: "This will affect screw positions and mesh graph" },
      { key: "invert_z", name: "Invert Z", type: "binary", tip: "Swaps buttons if they are on top of each other, affects other panels", cb: reloadCb },
      { key: "move_speed_xy", name: "XY Speed (mm/s)", type: "number", min: 1, max: maxV, tip: "Only for the move panel" },
      { key: "move_speed_z", name: "Z Speed (mm/s)", type: "number", min: 1, max: maxZ, tip: "Only for the move panel" },
    ];
    for (const d of defs) list.append(optionRow(app, d));
    this.el.append(list);
  }
};
