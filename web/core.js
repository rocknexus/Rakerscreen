/* Rakerscreen core: DOM helpers, Moonraker client, printer model, screen (base panel).
   Behaviour mirrors KlipperScreen (screen.py, ks_includes/printer.py, panels/base_panel.py). */
"use strict";

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  if ((tag === "input" && !["range", "checkbox", "radio", "button"].includes(e.type)) || tag === "textarea") prepareTextField(e, attrs || {});
  return e;
}

/* Every text field uses the in-app input module (keyboard.js: Input), never Android's keyboard. */
function prepareTextField(e, attrs) { Input.prepare(e, attrs); }

/** Action bar shortcut targets: KlipperScreen's five first, then Rakerscreen extras. */
const SHORTCUT_TARGETS = {
  notifications: { name: "Notifications", icon: "notifications" },
  lock_screen: { name: "Lock", icon: "lock" },
  gcode_macros: { name: "Macros", icon: "custom-script" },
  camera: { name: "Camera", icon: "camera" },
  led: { name: "LEDs", icon: "light" },
  console: { name: "Console", icon: "console", extra: true },
  temperature: { name: "Temperature", icon: "heat-up", extra: true },
  fan: { name: "Fan", icon: "fan", extra: true },
  fine_tune: { name: "Fine Tuning", icon: "fine-tune", extra: true },
  move: { name: "Move", icon: "move", extra: true },
  extrude: { name: "Extrude", icon: "extrude", extra: true },
  gcodes: { name: "Print", icon: "printer", extra: true },
  settings: { name: "Settings", icon: "settings", extra: true },
};

/** Icon from the active theme, falling back to z-bolt (like KlippyGtk.PixbufFromIcon per theme dir). */
const THEMES = ["z-bolt", "colorized", "material-dark", "material-darker", "material-light"];
function iconUrl(name) {
  const t = THEMES.includes(Settings.get("theme")) ? Settings.get("theme") : "z-bolt";
  return `icons/${t}/${name}.svg`;
}
function setIcon(img, name) {
  img.onerror = () => { img.onerror = null; img.src = `icons/z-bolt/${name}.svg`; };
  img.src = iconUrl(name);
}
function icon(name) { const i = el("img", { alt: "", draggable: "false" }); setIcon(i, name); return i; }

/** KlippyGtk.Button(image_name, label, style, scale, position, lines) */
function Button(image, label, style, opts = {}) {
  const b = el("button", { class: "btn" });
  if (opts.side) b.classList.add("side");
  if (opts.lines === 1) b.classList.add("lines1");
  if (style) style.split(" ").forEach((s) => b.classList.add(s));
  if (image) { b._img = icon(image); b.append(b._img); }
  if (label !== undefined && label !== null) { b._lbl = el("span", { class: "lbl" }, label); b.append(b._lbl); }
  else b.classList.add("noLabel");
  if (opts.onclick) b.addEventListener("click", (ev) => { if (!b.disabled) opts.onclick(ev, b); });
  b.setLabel = (t) => { if (!b._lbl) { b._lbl = el("span", { class: "lbl" }); b.append(b._lbl); b.classList.remove("noLabel"); } b._lbl.textContent = t; };
  b.setImage = (n) => { if (b._img) setIcon(b._img, n); };
  b.busy = (on) => { b.classList.toggle("busy", !!on); b.disabled = !!on; };
  return b;
}

/** A homogeneous Gtk.Grid. items: [{w, x, y, cw, ch}] */
function Grid(cols, rows, items, cls = "") {
  const g = el("div", { class: `grid ${cls}` });
  g.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  g.style.gridTemplateRows = rows ? `repeat(${rows}, minmax(0, 1fr))` : "";
  for (const it of items || []) {
    if (!it || !it.w) continue;
    it.w.style.gridColumn = `${it.x + 1} / span ${it.cw || 1}`;
    it.w.style.gridRow = `${it.y + 1} / span ${it.ch || 1}`;
    g.append(it.w);
  }
  return g;
}

/** ks_includes/widgets/autogrid.py */
function AutoGrid(widgets, maxColumns, expandLast = false, vertical = false) {
  if (!maxColumns) maxColumns = vertical ? 3 : 4;
  const n = widgets.length;
  let columns;
  if (vertical && n < 4) columns = 1;
  else if (n === 4 || n === 2) columns = Math.min(2, maxColumns);
  else if (n === 3 || n === 5 || n === 6) columns = Math.min(3, maxColumns);
  else columns = Math.min(4, maxColumns);
  const rows = Math.max(1, Math.ceil(n / columns));
  const items = widgets.map((w, i) => {
    const span = expandLast && i + 1 === n && n % 2 === 1 ? 2 : 1;
    return { w, x: i % columns, y: Math.floor(i / columns), cw: Math.min(span, columns - (i % columns)) };
  });
  return Grid(columns, rows, items);
}

/** Row of horizontal_togglebuttons. Returns {el, set(value)} */
function ToggleRow(values, current, onchange, fmt = (v) => v, smaller = false) {
  const row = el("div", { class: "togglerow" + (smaller ? " smaller" : "") });
  const btns = {};
  const set = (v) => { for (const k in btns) btns[k].classList.toggle("toggle_active", k === String(v)); };
  for (const v of values) {
    btns[v] = Button(null, fmt(v), null, { onclick: () => { set(v); onchange(v); } });
    row.append(btns[v]);
  }
  set(current);
  return { el: row, set };
}

const padNumber = (n, width = 3, digits = 0) => Number(n || 0).toFixed(digits).padStart(width, " ");
const prettify = (name) => { name = name.replace(/_/g, " "); return name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name; };
const devName = (d) => (d.split(" ").length > 1 ? d.split(" ").slice(1).join(" ") : d);

function formatTime(seconds) {
  if (seconds === null || seconds === undefined || seconds < 1) return "-";
  let s = Math.floor(seconds);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  const sp = " ";
  const parts = [];
  if (d) parts.push(`${d}${sp}${d === 1 ? "day" : "days"}`);
  if (h) parts.push(`${h}${sp}${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${m}${sp}${m === 1 ? "minute" : "minutes"}`);
  if (!d && !h) parts.push(`${s}${sp}s`);
  return parts.join(" ");
}

function formatETA(total, elapsed) {
  if (total === null || total === undefined) return "-";
  const secs = total - elapsed;
  if (secs <= 0) return "-";
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  const eta = new Date(Date.now() + secs * 1000);
  const hh = Settings.get("24htime") ? String(eta.getHours()).padStart(2, "0") + ":" + String(eta.getMinutes()).padStart(2, "0")
    : eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  let left = "";
  if (d) left += `${d}d `;
  left += `${h ? h + "h " : ""}${m}m`;
  return `${left.trim()} | ${hh}`;
}

// ---------------------------------------------------------------- settings (KlipperScreen.conf equivalents)
const Settings = {
  defaults: {
    moonraker_host: "127.0.0.1",
    moonraker_port: "7125",
    moonraker_api_key: "",
    webui_port: "8888",
    auto_port: true,
    // KlipperScreen [main] options (ks_includes/config.py), same names and defaults
    theme: "z-bolt",
    "24htime": true,
    font_size: "medium",
    only_heaters: false,
    show_scroll_steppers: false,
    show_cursor: false,
    auto_open_extrude: true,
    screen_blanking: "3600",
    screen_blanking_printing: "3600",
    use_dpms: true,
    screensaver_wake_delay: "0",
    confirm_estop: false,
    shutdown_action: "ask",
    reboot_action: "ask",
    autoclose_popups: true,
    enable_addons: false,
    language: "system_lang",
    lock_password: "",
    side_shortcut_target: "notifications",
    side_shortcut_2: "off", // Rakerscreen extra: second configurable action-bar button
    orientation: "auto",    // Rakerscreen extra: forced screen orientation (Android only)
    auto_update: true,      // check GitHub releases at startup and every 6 hours (update.js)
    update_skip: "",        // version the user chose to skip in the automatic prompt
    macros_grid: "auto",    // Macros panel tile grid: "auto" or "<cols>x<rows>"
    macros_hidden: {},      // macro name -> true when hidden from the Macros panel
    macros_colors: {},      // macro name -> "#rrggbb" tile background (MACRO_COLORS)
    macros_order: [],       // macro names in the user's order (Edit → Move); [] = alphabetical
    move_speed_xy: 50,
    move_speed_z: 10,
    invert_x: false, invert_y: false, invert_z: false,
    print_estimate_method: "auto",
    print_sort_dir: "date_desc",
    show_heater_power: false,
    job_complete_timeout: 0,
    job_error_timeout: 0,
    graph_hidden: {},
    preheat: {
      PLA: { bed: 60, extruder: 195 },
      ABS: { bed: 90, extruder: 220 },
      PETG: { bed: 80, extruder: 240 },
      FLEX: { bed: 0, extruder: 210 },
    },
  },
  data: {},
  load() {
    try { this.data = JSON.parse(localStorage.getItem("pocketscreen") || "{}"); } catch (e) { this.data = {}; }
  },
  get(k) { return k in this.data ? this.data[k] : this.defaults[k]; },
  set(k, v) { this.data[k] = v; try { localStorage.setItem("pocketscreen", JSON.stringify(this.data)); } catch (e) { /* ignore */ } },
};
Settings.load();

// ---------------------------------------------------------------- customizable increments
/* Step selectors. KlipperScreen reads some of these from KlipperScreen.conf (z_babystep_values,
   move_distances, extrude_distances, extrude_speeds); here they're editable in the app.
   pick = which value is pre-selected when the panel opens (KlipperScreen's choice for the defaults). */
const INCREMENT_SETS = {
  z_babystep_values: { name: "Fine Tuning: Z step", unit: "mm", def: ["0.01", "0.05"], max: 4, decimals: true, pick: "last" },
  fine_speed_steps: { name: "Fine Tuning: Speed step", unit: "%", def: ["5", "25"], max: 4, decimals: false, pick: "last" },
  fine_flow_steps: { name: "Fine Tuning: Flow step", unit: "%", def: ["1", "2"], max: 4, decimals: false, pick: "last" },
  move_distances: { name: "Move: distances", unit: "mm", def: [".1", ".5", "1", "5", "10", "25", "50"], max: 7, decimals: true, pick: "second-last" },
  extrude_distances: { name: "Extrude: distances", unit: "mm", def: ["5", "10", "15", "25"], max: 4, decimals: true, pick: "second" },
  extrude_speeds: { name: "Extrude: speeds", unit: "mm/s", def: ["1", "2", "5", "25"], max: 4, decimals: true, pick: "second" },
  temp_deltas: { name: "Temperature: +/- steps", unit: "°C", def: ["1", "5", "10", "25"], max: 4, decimals: false, pick: "third" },
};
function getIncrements(key) {
  const v = Settings.get(`inc_${key}`);
  return Array.isArray(v) && v.length ? v.slice() : INCREMENT_SETS[key].def.slice();
}
function defaultIncrement(key) {
  const vals = getIncrements(key), pick = INCREMENT_SETS[key].pick, n = vals.length;
  const idx = pick === "last" ? n - 1 : pick === "second-last" ? n - 2 : pick === "second" ? 1 : pick === "third" ? 2 : 0; // "first" -> 0
  return vals[Math.max(0, Math.min(n - 1, idx))];
}
/** "0.05, 0.01 0.1" -> {values: ["0.01","0.05","0.1"]} or {error} */
function parseIncrements(key, text) {
  const set = INCREMENT_SETS[key];
  const parts = String(text).split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return { error: "Enter at least one value" };
  const nums = [];
  for (const p of parts) {
    const n = Number(p);
    if (!isFinite(n) || n <= 0) return { error: `"${p}" is not a positive number` };
    if (!set.decimals && !Number.isInteger(n)) return { error: `${set.name} needs whole numbers ("${p}")` };
    if (!nums.includes(n)) nums.push(n);
  }
  if (nums.length > set.max) return { error: `${set.name}: at most ${set.max} values` };
  nums.sort((a, b) => a - b);
  // keep a compact form: 0.10 -> "0.1", but ".5" style is fine either way
  return { values: nums.map((n) => String(+n.toFixed(4))) };
}

// ---------------------------------------------------------------- lean error log
/* Keeps only errors (no status dumps, temps or settings values), collapses repeats into one line
   with a count, caps the size, and survives app restarts so a crash-loop can still be reported. */
const ErrorLog = {
  max: 40,
  entries: [],
  load() { try { this.entries = JSON.parse(localStorage.getItem("pocketscreen_errors") || "[]"); } catch (e) { this.entries = []; } },
  save() { try { localStorage.setItem("pocketscreen_errors", JSON.stringify(this.entries)); } catch (e) { /* ignore */ } },
  add(cat, msg) {
    msg = String(msg || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!msg) return;
    const now = Date.now();
    // a popup that just repeats an RPC error already logged adds nothing
    const same = (a, b) => a === b || a.endsWith(": " + b);
    if (cat === "ui" && this.entries.some((e) => e.cat !== "ui" && now - e.t1 < 3000 && same(e.msg, msg))) return;
    // ...and if the popup came first (Klipper sends "!! ..." before the RPC error), drop it
    if (cat !== "ui") this.entries = this.entries.filter((e) => !(e.cat === "ui" && now - e.t1 < 3000 && same(msg, e.msg)));
    const hit = this.entries.find((e) => e.cat === cat && e.msg === msg);
    if (hit) { hit.n++; hit.t1 = now; this.entries.splice(this.entries.indexOf(hit), 1); this.entries.push(hit); }
    else { this.entries.push({ cat, msg, n: 1, t0: now, t1: now }); if (this.entries.length > this.max) this.entries.shift(); }
    clearTimeout(this._t); this._t = setTimeout(() => this.save(), 500);
  },
  clear() { this.entries = []; this.save(); },
};
ErrorLog.load();
window.addEventListener("error", (e) => ErrorLog.add("js", `${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => ErrorLog.add("js", `unhandled: ${(e.reason && e.reason.message) || e.reason}`));

// ---------------------------------------------------------------- Moonraker JSON-RPC client
/* Transport: inside the Android app a native WebSocket (window.PSBridge) is used, which lets us
   connect to 127.0.0.1 without a browser Origin header (Moonraker rejects file:// origins) and add
   the X-Api-Key header. In a desktop browser the regular WebSocket API is used. */
class Moonraker {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = {};
    this.connected = false;
    this.ws = null;
    window.__psws = {
      onOpen: () => this._onOpen(),
      onMessage: (m) => this._onMessage(m),
      onClose: (code, reason) => this._onClose(code, reason),
      onError: (e) => this._emit("error", e),
    };
  }
  get native() { return typeof window.PSBridge !== "undefined"; }
  port() { return this.portOverride || Settings.get("moonraker_port"); }
  url() { return `ws://${Settings.get("moonraker_host")}:${this.port()}/websocket`; }
  httpBase() { return `http://${Settings.get("moonraker_host")}:${this.port()}`; }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  _emit(ev, ...a) { (this.listeners[ev] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); }

  connect() {
    this.close();
    const url = this.url(), key = Settings.get("moonraker_api_key") || "";
    if (this.native) { window.PSBridge.connect(url, key); return; }
    try {
      this.ws = new WebSocket(url);
    } catch (e) { setTimeout(() => this._onClose(0, String(e)), 0); return; }
    this.ws.onopen = () => this._onOpen();
    this.ws.onmessage = (ev) => this._onMessage(ev.data);
    this.ws.onclose = (ev) => this._onClose(ev.code, ev.reason);
    this.ws.onerror = () => this._emit("error", "websocket error");
  }
  close() {
    if (this.native) { try { window.PSBridge.close(); } catch (e) { /* ignore */ } }
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
    this.connected = false;
    // fail in-flight requests, otherwise anything awaiting them would hang after a manual reconnect
    for (const [, p] of this.pending) p.reject(new Error("connection closed"));
    this.pending.clear();
  }
  _onOpen() { this.connected = true; this._emit("open"); }
  _onClose(code, reason) {
    const was = this.connected;
    this.connected = false;
    for (const [, p] of this.pending) p.reject(new Error("disconnected"));
    this.pending.clear();
    this._emit("close", { code, reason, was });
  }
  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        ErrorLog.add("rpc", `${p.method}: ${msg.error.message || "error"}`);
        p.reject(Object.assign(new Error(msg.error.message || "error"), { rpc: msg.error }));
      }
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this._emit("notify", msg.method, msg.params || []);
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error("not connected")); return; }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params, id });
      try {
        if (this.native) window.PSBridge.send(payload); else this.ws.send(payload);
      } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  gcode(script) { return this.call("printer.gcode.script", { script }); }
}

// ---------------------------------------------------------------- printer model (ks_includes/printer.py)
class Printer {
  constructor() { this.reset(); }
  reset() {
    this.data = {};
    this.config = {};
    this.state = "disconnected";
    this.availableCommands = {};
    this.objects = [];
    this.tools = []; this.heaters = []; this.sensors = []; this.tempFans = [];
    this.fans = []; this.filamentSensors = []; this.outputPins = []; this.leds = []; this.macros = []; this.ledConfigs = [];
    this.tempStore = {};
  }
  reinit(objects, config) {
    this.objects = objects;
    this.config = config || {};
    const sections = Object.keys(this.config);
    const has = (p) => objects.filter((o) => o === p || o.startsWith(p + " "));
    this.tools = objects.filter((o) => /^extruder\d*$/.test(o)).sort((a, b) => (parseInt(a.slice(8) || "0") - parseInt(b.slice(8) || "0")));
    this.heaters = [...objects.filter((o) => o === "heater_bed"), ...has("heater_generic").filter((o) => o !== "heater_generic")];
    this.sensors = has("temperature_sensor").filter((o) => o !== "temperature_sensor");
    this.tempFans = has("temperature_fan").filter((o) => o !== "temperature_fan");
    this.fans = objects.filter((o) => o === "fan" || /^(controller_fan|fan_generic|heater_fan) /.test(o));
    this.filamentSensors = objects.filter((o) => /^filament_(switch|motion)_sensor /.test(o));
    this.outputPins = objects.filter((o) => o.startsWith("output_pin "));
    this.leds = objects.filter((o) => /^(led|neopixel|dotstar|pca9533|pca9632) /.test(o));
    this.macros = sections.filter((s) => s.startsWith("gcode_macro ")).map((s) => s.slice(12)).filter((m) => !m.startsWith("_"));
  }
  configSection(name) { return this.config[name] || this.config[name.toLowerCase()] || {}; }
  get extruderCount() { return this.tools.length; }
  tempDevices() { return [...this.tools, ...this.heaters, ...this.sensors, ...this.tempFans]; }
  hasTarget(dev) { return this.tools.includes(dev) || this.heaters.includes(dev) || this.tempFans.includes(dev); }
  hasPower(dev) { return this.tools.includes(dev) || this.heaters.includes(dev); }
  stat(obj, key) { const o = this.data[obj]; if (!o) return undefined; return key === undefined ? o : o[key]; }
  fanSpeed(fan) { const s = this.stat(fan, "speed"); return typeof s === "number" ? s : 0; }
  toolNumber(ext) { return ext === "extruder" ? 0 : parseInt(ext.slice(8)) || 0; }
  update(status) {
    for (const [obj, vals] of Object.entries(status)) {
      if (typeof vals !== "object" || vals === null || Array.isArray(vals)) { this.data[obj] = vals; continue; }
      this.data[obj] = Object.assign(this.data[obj] || {}, vals);
    }
    this.processState();
  }
  processState() {
    const wh = this.stat("webhooks", "state");
    let st = wh || this.state;
    if (wh === "ready") {
      const ps = this.stat("print_stats", "state");
      if (ps === "printing" || ps === "paused") st = ps;
      else st = "ready";
    }
    if (st !== this.state) { const old = this.state; this.state = st; window.screenApp && screenApp.onPrinterState(st, old); }
  }
  isPrinting() { return this.state === "printing" || this.state === "paused"; }
  /** values used by menu "enable" rules (get_printer_status_data) */
  menuData() {
    return {
      extruders: this.tools.length,
      temperature_devices: this.tempDevices().length - this.tools.length,
      fans: this.fans.length,
      leds: this.leds.length,
      gcode_macros: this.macros.length,
      output_pins: this.outputPins.length,
      config_sections: Object.keys(this.config),
      available_commands: this.availableCommands,
      is_paused: !!this.stat("pause_resume", "is_paused"),
    };
  }
  sampleTemps() {
    const now = Date.now();
    for (const d of this.tempDevices()) {
      const t = this.stat(d, "temperature");
      if (typeof t !== "number") continue;
      const s = (this.tempStore[d] = this.tempStore[d] || { t: [], temperatures: [], targets: [], powers: [] });
      s.t.push(now); s.temperatures.push(t);
      s.targets.push(this.stat(d, "target") || 0);
      s.powers.push(this.stat(d, "power") || 0);
      if (s.t.length > 1200) for (const k in s) s[k].shift();
    }
  }
}

// ---------------------------------------------------------------- graph colors (styles/<theme>/style.conf)
const MATERIAL_GRAPH = {
  extruder: ["C62828", "9C27B0", "F06292", "F44336", "6A1B9A"], bed: ["00B0FF"],
  fan: ["558B2F", "8BC34A", "00695C", "009688"], sensor: ["FF8F00", "3F51B5", "9E9D24", "CDDC39", "FFC107"],
};
const THEME_GRAPH = {
  "z-bolt": {
    extruder: ["ED6500", "ED8500", "EDA500", "EDC500", "EDF500"], bed: ["009384"],
    fan: ["A7E100", "7ECE21", "AAA920", "AC7140"], sensor: ["B10080", "7800B0", "AC4958", "B1A080", "B1C080"],
  },
  colorized: {
    extruder: ["DC322F", "B58900", "CB4B16", "AA1F1D", "973911"], bed: ["268BD2"],
    fan: ["859900", "2AA198", "637300", "1F7A72"], sensor: ["D33682", "6C71C4", "C06CC4", "6D26D1", "2A34A1"],
  },
  "material-dark": MATERIAL_GRAPH, "material-darker": MATERIAL_GRAPH, "material-light": MATERIAL_GRAPH,
};
function deviceColor(printer, dev) {
  const G = THEME_GRAPH[Settings.get("theme")] || THEME_GRAPH["z-bolt"];
  const pick = (arr, i) => "#" + arr[Math.max(0, i) % arr.length];
  if (dev.startsWith("extruder")) return pick(G.extruder, printer.tools.indexOf(dev));
  if (dev === "heater_bed") return pick(G.bed, 0);
  if (dev.startsWith("temperature_fan")) return pick(G.fan, printer.tempFans.indexOf(dev));
  const others = [...printer.heaters.filter((h) => h !== "heater_bed"), ...printer.sensors];
  return pick(G.sensor, others.indexOf(dev));
}
/** only_heaters: "Show only devices that are able to be set" */
function deviceFiltered(printer, dev) {
  return Settings.get("only_heaters") && !dev.startsWith("extruder") && dev !== "heater_bed"
    && !dev.startsWith("heater_generic") && !dev.startsWith("temperature_fan");
}
function deviceIcon(printer, dev) {
  if (dev.startsWith("extruder")) return printer.extruderCount > 1 ? `extruder-${printer.toolNumber(dev)}` : "extruder";
  if (dev.startsWith("heater_bed")) return "bed";
  if (dev.startsWith("temperature_fan")) return "fan";
  if (dev.startsWith("heater_generic")) return "heater";
  return "heat-up";
}

// ---------------------------------------------------------------- heater graph (ks_includes/widgets/heatergraph.py)
class HeaterGraph {
  constructor(printer) {
    this.printer = printer;
    this.canvas = el("canvas", { class: "heatergraph" });
    this.hidden = Settings.get("graph_hidden") || {};
  }
  isShowing(dev) { return !this.hidden[dev]; }
  toggle(dev) { this.hidden[dev] = !this.hidden[dev]; Settings.set("graph_hidden", this.hidden); this.draw(); }
  draw() {
    const c = this.canvas, r = c.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    const W = r.width, H = r.height, fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const gx = fs * 2.2, gw = W - gx - fs * 1.2, gy = fs * 0.6, gh = H - fs * 1.4 - gy;
    const store = this.printer.tempStore;
    let maxT = 0, n = 0;
    for (const d in store) {
      if (!this.isShowing(d) || deviceFiltered(this.printer, d)) continue;
      const s = store[d];
      n = Math.max(n, s.t.length);
      for (let i = 0; i < s.temperatures.length; i++) maxT = Math.max(maxT, s.temperatures[i], s.targets[i]);
    }
    maxT = Math.max(50, Math.ceil((maxT + 5) / 50) * 50);
    g.font = `${fs * 0.8}px sans-serif`;
    const textColor = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#fff";
    g.fillStyle = textColor; g.strokeStyle = textColor; g.globalAlpha = 1; g.lineWidth = 1;
    const gridAlpha = 0.25;
    const nh = Math.min(5, Math.max(2, Math.floor(gh / (fs * 1.6))));
    for (let i = 0; i <= nh; i++) {
      const y = gy + gh - (gh * i) / nh, v = Math.round((maxT * i) / nh);
      g.globalAlpha = gridAlpha; g.beginPath(); g.moveTo(gx, y); g.lineTo(gx + gw, y); g.stroke(); g.globalAlpha = 1;
      g.textAlign = "right"; g.textBaseline = "middle"; g.fillText(String(v), gx - 4, y);
    }
    const span = 1200 * 1000, now = Date.now();
    g.textAlign = "center"; g.textBaseline = "top";
    for (let m = 0; m <= 20; m += 5) {
      const x = gx + gw - (gw * m * 60000) / span;
      g.globalAlpha = gridAlpha; g.beginPath(); g.moveTo(x, gy); g.lineTo(x, gy + gh); g.stroke(); g.globalAlpha = 1;
      const t = new Date(now - m * 60000);
      g.fillText(`${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`, Math.max(gx + fs, Math.min(x, W - fs)), gy + gh + 2);
    }
    const xOf = (ts) => gx + gw - ((now - ts) / span) * gw, yOf = (v) => gy + gh - (v / maxT) * gh;
    const showPower = Settings.get("show_heater_power");
    for (const d in store) {
      if (!this.isShowing(d) || deviceFiltered(this.printer, d)) continue;
      const s = store[d], col = deviceColor(this.printer, d);
      if (showPower && this.printer.hasPower(d) && s.powers) {
        // heater power as a faint line on a 0..100% scale of the graph height
        g.beginPath(); g.setLineDash([]);
        let st = false;
        for (let i = 0; i < s.powers.length; i++) {
          if (now - s.t[i] > span) continue;
          const x = xOf(s.t[i]), y = gy + gh - (s.powers[i] || 0) * gh;
          if (!st) { g.moveTo(x, y); st = true; } else g.lineTo(x, y);
        }
        g.globalAlpha = 0.4; g.strokeStyle = col; g.lineWidth = 1; g.stroke(); g.globalAlpha = 1;
      }
      const line = (arr, dash, fill) => {
        g.beginPath(); g.setLineDash(dash ? [fs * 0.3, fs * 0.3] : []);
        let started = false;
        for (let i = 0; i < arr.length; i++) {
          if (now - s.t[i] > span) continue;
          const x = xOf(s.t[i]), y = yOf(arr[i]);
          if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
        }
        g.strokeStyle = col; g.lineWidth = dash ? 1 : 2; g.stroke();
        if (fill && started) { g.lineTo(xOf(s.t[s.t.length - 1]), gy + gh); g.lineTo(xOf(s.t.find((t) => now - t <= span) || now), gy + gh); g.closePath(); g.globalAlpha = 0.25; g.fillStyle = col; g.fill(); g.globalAlpha = 1; }
      };
      line(s.temperatures, false, false);
      if (this.printer.hasTarget(d)) line(s.targets, true, false);
    }
    g.setLineDash([]);
  }
}

// ---------------------------------------------------------------- keypad (ks_includes/widgets/keypad.py)
function Keypad(onOk, onCancel, extra) {
  const entry = el("input", { class: "entry", type: "text", inputmode: "none", readonly: true, maxlength: "5" });
  const root = el("div", { class: "keypad" });
  const top = el("div", { class: "top" }, entry, Button("cancel", null, null, { onclick: () => onCancel() }));
  const pad = el("div", { class: "numpad" });
  for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "B", "0", "."]) {
    const b = k === "B" ? Button("backspace", null, "numpad_key") : Button(null, k, "numpad_key");
    b.addEventListener("click", () => {
      if (k === "B") entry.value = entry.value.slice(0, -1);
      else if (entry.value.length < 5) entry.value += k;
    });
    pad.append(b);
  }
  const val = () => { const v = parseFloat(entry.value); return isNaN(v) ? null : v; };
  const ok = Button("complete", null, "color1", {
    onclick: () => { const v = val(); if (v === null) screenApp.popup("Invalid temperature"); else { onOk(v); entry.value = ""; } },
  });
  const actions = el("div", { class: "actions" });
  if (extra) actions.append(Button(extra.icon, extra.label, "color2", { side: true, lines: 1, onclick: () => extra.cb(val() || 0) }));
  actions.append(ok);
  root.append(top, pad, actions);
  root.clear = () => (entry.value = "");
  return root;
}
