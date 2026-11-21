/* Rakerscreen screen controller: connection lifecycle, navigation stack, base panel (action bar +
   title bar), dialogs and popups. Mirrors KlipperScreen screen.py + panels/base_panel.py. */
"use strict";

const VERSION = "0.4.13-dev";

// Menus translated from KlipperScreen config/main_menu.conf, print_menu.conf, move_menu.conf.
// Only panels that Rakerscreen implements are listed.
const MENUS = {
  __main: [
    { key: "move", name: "Move", icon: "move", panel: "move" },
    { key: "temperature", name: "Temperature", icon: "heat-up", panel: "temperature", enable: (p) => p.temperature_devices > 0 || p.extruders > 0 },
    { key: "extrude", name: "Extrude", icon: "extrude", panel: "extrude", enable: (p) => p.extruders > 0 },
    { key: "more", name: "More", icon: "settings", submenu: "__main more" },
    { key: "print", name: "Print", icon: "printer", panel: "gcodes", enable: (p) => p.extruders > 0 },
    { key: "gcodes", name: "Gcodes", icon: "files", panel: "gcodes", enable: (p) => p.extruders === 0 },
    { key: "main_console", name: "Console", icon: "console", panel: "console" }, // beside Print (also under More)
  ],
  "__main more": [
    { key: "bedmesh", name: "Bed Mesh", icon: "bed-mesh", panel: "bed_mesh", enable: (p) => p.config_sections.includes("bed_mesh") },
    { key: "zoffset", name: "Z Calibrate", icon: "z-farther", panel: "zcalibrate" },
    { key: "limits", name: "Limits", icon: "gauge-redline", panel: "limits" },
    { key: "fan", name: "Fan", icon: "fan", panel: "fan", enable: (p) => p.fans > 0 },
    { key: "led", name: "Leds", icon: "light", panel: "led", enable: (p) => p.leds > 0 },
    { key: "macros", name: "Macros", icon: "custom-script", panel: "gcode_macros", enable: (p) => p.gcode_macros > 0 },
    { key: "camera", name: "Camera", icon: "camera", panel: "camera", enable: () => screenApp.webcams.length > 0 },
    { key: "console", name: "Console", icon: "console", panel: "console" },
    { key: "save", name: "Save Config", icon: "complete", method: "ks_confirm_save" },
    { key: "settings", name: "Rakerscreen", icon: "settings", panel: "settings" },
    { key: "notifications", name: "Notifications", icon: "notifications", panel: "notifications" },
    { key: "logs", name: "Logs", icon: "logs", panel: "logs" },
    { key: "system", name: "System", icon: "info", panel: "system", enable: () => screenApp.mr.connected },
    { key: "fine_tune", name: "Fine Tuning", icon: "fine-tune", panel: "fine_tune" },
  ],
  __print: [
    { key: "temperature", name: "Temperature", icon: "heat-up", panel: "temperature", enable: (p) => p.temperature_devices > 0 || p.extruders > 0 },
    { key: "fan", name: "Fan", icon: "fan", panel: "fan", enable: (p) => p.fans > 0 },
    { key: "move", name: "Move", icon: "move", panel: "move", enable: (p) => p.is_paused },
    { key: "extrude", name: "Extrude", icon: "extrude", panel: "extrude", enable: (p) => p.extruders > 0 },
    { key: "led", name: "Leds", icon: "light", panel: "led", enable: (p) => p.leds > 0 },
    { key: "macros", name: "Macros", icon: "custom-script", panel: "gcode_macros", enable: (p) => p.gcode_macros > 0 },
    { key: "notifications", name: "Notifications", icon: "notifications", panel: "notifications" },
    { key: "camera", name: "Camera", icon: "camera", panel: "camera", enable: () => screenApp.webcams.length > 0 },
    { key: "console", name: "Console", icon: "console", panel: "console" },
    { key: "limits", name: "Limits", icon: "gauge-redline", panel: "limits" },
    { key: "settings", name: "Rakerscreen", icon: "settings", panel: "settings" },
    { key: "system", name: "System", icon: "info", panel: "system", enable: () => screenApp.mr.connected },
    { key: "lock", name: "Lock", icon: "lock", method: "lock_screen" },
  ],
  "move homing": [
    { key: "homex", name: "Home X", icon: "home-x", method: "printer.gcode.script", params: { script: "G28 X" } },
    { key: "homey", name: "Home Y", icon: "home-y", method: "printer.gcode.script", params: { script: "G28 Y" } },
    { key: "homez", name: "Home Z", icon: "home-z", method: "printer.gcode.script", params: { script: "G28 Z" } },
    { key: "homeall", name: "Home All", icon: "home", method: "printer.gcode.script", params: { script: "G28" } },
    { key: "homexy", name: "Home XY", icon: "home", method: "printer.gcode.script", params: { script: "G28 X Y" } },
    { key: "qgl", name: "Quad Gantry Level", icon: "home-z", method: "printer.gcode.script", params: { script: "QUAD_GANTRY_LEVEL" }, enable: (p) => "QUAD_GANTRY_LEVEL" in p.available_commands },
    { key: "ztilt", name: "Z Tilt", icon: "z-tilt", method: "printer.gcode.script", params: { script: "Z_TILT_ADJUST" }, enable: (p) => "Z_TILT_ADJUST" in p.available_commands },
  ],
};
const MENU_TITLES = { __main: "Main Menu", "__main more": "More", __print: "Print Control", "move homing": "Homing" };

class ScreenApp {
  constructor() {
    this.mr = new Moonraker();
    this.printer = new Printer();
    this.stack = [];
    this.notifications = [];
    this.gcodeLog = [];
    this.webcams = [];
    this.serverInfo = null;
    this.printerName = "Printer";
    this.initialized = false;
    this.reconnectTimer = null;
    this.klippyRetry = null;
    this.vertical = false;
    this.screen = $("#screen");
    this.content = $("#content");
    this.reinitAt = 0;
    this.applyAppearance();
    this.applyOrientation();
    this.vk = new VirtualKeyboard(this); // in-app keyboard for every text field
    this.updater = new Updater(this);    // self-update from GitHub releases
    this.buildActionBar();
    this.initScreensaver();
    this.layout();
    window.addEventListener("resize", () => this.layout());
    setInterval(() => this.updateTime(), 1000);
    setInterval(() => this.printer.sampleTemps(), 1000);
    setInterval(() => this.updateBattery(), 60000);
    this.updateTime();
    this.updateBattery();

    this.mr.on("open", () => this.onConnected());
    this.mr.on("close", (info) => this.onDisconnected(info));
    this.mr.on("notify", (m, p) => this.onNotify(m, p));
    this.showPanel("splash_screen", null, null, { removeAll: true });
    this.splashText(`Connecting to ${this.mr.url()}`);
    this.mr.connect();
  }

  // ------------------------------------------------------------ layout (KlippyGtk.update_layout)
  layout() {
    const w = window.innerWidth, h = window.innerHeight;
    // The soft keyboard only changes the height. Re-laying out then would shrink every font and could
    // rebuild the panel under the field being typed in, so keep the current layout while typing.
    const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (typing && w === this.width && h < this.lastHeight) return;
    this.lastHeight = h;
    this.vertical = h > w;
    const ratio = this.vertical ? [30, 42] : [40, 27];
    let fs = Math.min(w / ratio[0], h / ratio[1]);
    let imgScale = fs * 2, side = 0.65;
    const type = Settings.get("font_size");
    if (type === "max") { fs *= 1.06; imgScale *= 0.7; side = 0.7; }
    else if (type === "extralarge") { fs *= 1.03; imgScale *= 0.7; side = 0.8; }
    else if (type === "large") { fs *= 1.025; imgScale *= 0.85; side = 0.8; }
    else if (type === "small") { fs *= 0.91; side = 0.55; }
    this.fontSize = fs;
    this.width = w;
    const root = document.documentElement.style;
    root.fontSize = fs + "px";
    root.setProperty("--img", (imgScale * 1.38) / fs + "em");
    root.setProperty("--img-side", (imgScale * side) / fs + "em");
    root.setProperty("--ab-w", Math.floor(w * 0.1) + "px");
    root.setProperty("--ab-h", Math.floor(h * 0.1) + "px");
    this.screen.classList.toggle("vertical", this.vertical);
    const cur = this.current();
    if (cur && cur.panel.relayout) cur.panel.relayout();
    if (cur) cur.panel._vertical = this.vertical;
    this.titlebarPopulated = false;
    this.populateTitlebar();
  }

  // ------------------------------------------------------------ appearance options
  applyAppearance() {
    document.documentElement.dataset.theme = THEMES.includes(Settings.get("theme")) ? Settings.get("theme") : "z-bolt";
    document.body.classList.toggle("wide-scroll", !!Settings.get("show_scroll_steppers"));
    document.body.classList.toggle("show-cursor", !!Settings.get("show_cursor"));
  }
  /** Forced orientation (Rakerscreen extra). The activity also restores it natively at launch. */
  applyOrientation() {
    if (window.PSBridge && PSBridge.setOrientation) PSBridge.setOrientation(String(Settings.get("orientation") || "auto"));
  }
  /** KlipperScreen reload_panels: panels built before this moment are rebuilt when next shown. */
  reloadPanels() { this.reinitAt = Date.now(); }

  // ------------------------------------------------------------ action bar
  buildActionBar() {
    const ab = $("#actionbar");
    this.ctl = {
      back: Button("back", null, null, { onclick: () => this.back() }),
      home: Button("main", null, null, { onclick: () => this.goBack(true) }),
      shortcut: Button("notifications", null, null, { onclick: () => this.shortcutClicked("side_shortcut_target") }),
      shortcut2: Button("notifications", null, null, { onclick: () => this.shortcutClicked("side_shortcut_2") }),
      estop: Button("emergency", null, null, { onclick: () => this.emergencyStop() }),
      shutdown: Button("shutdown", null, null, { onclick: () => this.showPanel("shutdown") }),
    };
    for (const k of ["back", "home", "shortcut", "shortcut2", "estop", "shutdown"]) ab.append(this.ctl[k]);
    // Back and the emergency stop stay when a panel puts its own buttons in the action bar
    this.ctl.back.classList.add("ab-keep");
    this.ctl.estop.classList.add("ab-keep");
    this.updateShortcuts();
  }
  /** A panel's own action bar buttons, until cleared with null. replace = true: they take the place of
      home and the shortcuts (Back and E-stop stay); false: they're added after home. */
  setPanelActions(buttons, replace = true) {
    const ab = $("#actionbar");
    if (this.panelActions) this.panelActions.remove();
    this.panelActions = null;
    const on = !!(buttons && buttons.length);
    ab.classList.toggle("panel-actions", on && replace);
    if (on) {
      buttons.forEach((b) => b.classList.add("ab-panel-btn"));
      this.panelActions = el("div", { class: "ab-panel" }, ...buttons);
      ab.insertBefore(this.panelActions, replace ? this.ctl.estop : this.ctl.shortcut);
    }
    this.updateActionBar();
  }
  /** side_shortcut_target (KlipperScreen) and side_shortcut_2 (Rakerscreen extra) */
  updateShortcuts() {
    for (const [btn, key] of [["shortcut", "side_shortcut_target"], ["shortcut2", "side_shortcut_2"]]) {
      const target = Settings.get(key);
      const def = SHORTCUT_TARGETS[target];
      this.ctl[btn].classList.toggle("hidden", !def);
      if (def) this.ctl[btn].setImage(def.icon);
    }
    this.updateActionBar();
  }
  shortcutAvailable(target) {
    const p = this.printer;
    if (target === "lock_screen" || target === "notifications") return true;
    if (!this.mr.connected || !this.initialized) return false;
    if (target === "gcode_macros") return p.macros.length > 0;
    if (target === "camera") return this.webcams.length > 0;
    if (target === "led") return p.leds.length > 0;
    if (target === "fan") return p.fans.length > 0;
    if (target === "extrude" || target === "temperature") return p.tools.length > 0 || p.tempDevices().length > 0;
    return true;
  }
  updateActionBar() {
    if (!this.ctl) return;
    const printing = this.printer.isPrinting();
    this.ctl.estop.classList.toggle("hidden", !printing);
    this.ctl.shutdown.classList.toggle("hidden", printing);
    const multi = this.stack.length > 1 || !!(this.current() && this.current().panel.canGoBack && this.current().panel.canGoBack());
    this.ctl.back.disabled = !multi;
    this.ctl.home.disabled = this.stack.length <= 1;
    for (const [btn, key] of [["shortcut", "side_shortcut_target"], ["shortcut2", "side_shortcut_2"]]) {
      const target = Settings.get(key);
      this.ctl[btn].disabled = !!(this.current() && this.current().name === target) || !this.shortcutAvailable(target);
    }
  }
  shortcutClicked(key) {
    const target = Settings.get(key);
    if (target === "notifications") this.notificationIcon(0);
    if (target === "lock_screen") { this.lock(); return; }
    this.showPanel(target);
  }
  /** base_panel.update_shortcut_icon: 0 reset, 1-2 active, 3 important */
  notificationIcon(level) {
    if (level > 0 && this._notifLevel >= level) return;
    this._notifLevel = level;
    const name = level >= 3 ? "notifications_important" : level > 0 ? "notifications_active" : "notifications";
    for (const [btn, key] of [["shortcut", "side_shortcut_target"], ["shortcut2", "side_shortcut_2"]]) {
      if (Settings.get(key) === "notifications") this.ctl[btn].setImage(name);
    }
  }

  // ------------------------------------------------------------ screensaver + DPMS (widgets/screensaver.py)
  initScreensaver() {
    this.ss = $("#screensaver");
    const activity = (ev) => {
      if (this.ssShowing) { ev.stopPropagation(); ev.preventDefault(); this.closeScreensaver(); return; }
      this.resetScreensaver();
    };
    document.addEventListener("pointerdown", activity, true);
    document.addEventListener("keydown", activity, true);
    this.resetScreensaver();
  }
  blankingTime() {
    const key = this.printer.isPrinting() ? "screen_blanking_printing" : "screen_blanking";
    const v = Settings.get(key);
    return v === "off" ? 0 : parseInt(v) || 0;
  }
  resetScreensaver() {
    clearTimeout(this.ssTimer);
    const t = this.blankingTime();
    if (t > 0 && !this.ssShowing) this.ssTimer = setTimeout(() => this.showScreensaver(), t * 1000);
  }
  /** preview: show it now (Settings), whatever the timeout. */
  showScreensaver(preview) {
    if (this.ssShowing || (!preview && this.blankingTime() === 0)) return;
    this.ssShowing = true;
    $("#popup").classList.remove("show");
    this.ss.classList.add("show");
    // an animated saver (Rakerscreen extra) runs first; black screen and DPMS come after its time, if any
    const ran = Screensavers.start(this.ss, this, Settings.get("screensaver") || "blank");
    const blackout = () => {
      Screensavers.stop();
      // DPMS on Android: drop this window's backlight to minimum (needs no permission)
      if (Settings.get("use_dpms") && window.PSBridge && PSBridge.setBrightness) PSBridge.setBrightness(0);
    };
    clearTimeout(this.ssBlackTimer);
    const after = parseInt(Settings.get("screensaver_blackout")) || 0;
    if (ran === "blank") blackout();
    else if (after > 0) this.ssBlackTimer = setTimeout(blackout, after * 1000);
  }
  closeScreensaver() {
    if (!this.ssShowing || this.ssWaking) return;
    clearTimeout(this.ssBlackTimer);
    Screensavers.stop();
    if (window.PSBridge && PSBridge.setBrightness) PSBridge.setBrightness(-1);
    // screens take a moment to wake; swallow touches during the delay (screensaver_wake_delay)
    this.ssWaking = true;
    setTimeout(() => {
      this.ssWaking = false; this.ssShowing = false;
      this.ss.classList.remove("show");
      this.resetScreensaver();
    }, (parseInt(Settings.get("screensaver_wake_delay")) || 0) * 1000);
  }

  // ------------------------------------------------------------ lock screen (widgets/lockscreen.py)
  lock() {
    this.goBack(true);
    const box = $("#lock");
    box.innerHTML = "";
    box.onclick = () => this.showUnlock();
    box.classList.add("show");
  }
  showUnlock() {
    const box = $("#lock");
    box.onclick = null;
    const pass = Settings.get("lock_password") || "";
    if (!pass) { this.clearLock(); return; }
    const entry = el("input", { class: "entry", type: "password", placeholder: "Password", autocomplete: "off" });
    // shown inside the lock screen: the popup layer sits beneath it
    const err = el("div", { class: "unlock-error" });
    const tryUnlock = () => { if (entry.value === pass) this.clearLock(); else { err.textContent = "Unlock failed"; entry.value = ""; } };
    entry.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
    entry.addEventListener("input", () => { err.textContent = ""; });
    const unlock = el("div", { class: "unlock" }, entry, Button(null, "Unlock", "color3", { onclick: tryUnlock }), err);
    unlock.addEventListener("click", (e) => e.stopPropagation());
    box.append(unlock);
    Input.open(entry);
  }
  clearLock() { const box = $("#lock"); box.classList.remove("show"); box.innerHTML = ""; box.onclick = null; }
  emergencyStop() {
    if (Settings.get("confirm_estop")) this.confirmSendAction("Are you sure you want to run Emergency Stop?", "printer.emergency_stop", {});
    else this.mr.call("printer.emergency_stop").catch(() => {});
  }

  // ------------------------------------------------------------ title bar
  setTitle(title) {
    const t = $("#titlebar");
    t.classList.remove("message_popup_error");
    const printer = this.printerName !== "Printer" ? this.printerName : "";
    $("#title_label").textContent = title ? `${printer} ${title}`.trim() : printer;
  }
  populateTitlebar() {
    if (this.titlebarPopulated || !this.initialized) return;
    const box = $("#title_items");
    box.innerHTML = "";
    this.tbLabels = {};
    const nlimit = Math.round(Math.log10(this.width) * 5 - 10.5);
    let n = 0;
    const tools = this.printer.tools;
    const current = this.printer.stat("toolhead", "extruder");
    const devs = [];
    if (tools.length > nlimit - 1) { if (current) devs.push(current); }
    else devs.push(...tools);
    devs.push(...this.printer.heaters);
    for (const d of devs) {
      if (n >= nlimit) break;
      const lbl = el("span", {}, "");
      const item = el("div", { class: "tb_item", onclick: () => this.showPanel("temperature", null, d) }, icon(deviceIcon(this.printer, d)), lbl);
      box.append(item);
      this.tbLabels[d] = lbl;
      n++;
    }
    this.titlebarPopulated = true;
    this.updateTitlebarTemps();
  }
  updateTitlebarTemps() {
    if (!this.tbLabels) return;
    for (const [d, lbl] of Object.entries(this.tbLabels)) {
      const t = this.printer.stat(d, "temperature");
      if (typeof t === "number") lbl.textContent = `${padNumber(t, 3)}°`;
    }
  }
  updateTime() {
    const now = new Date();
    const s = Settings.get("24htime")
      ? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
      : now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
    $("#title_time").textContent = s;
  }
  updateBattery() {
    let info = null;
    try { if (window.PSBridge && PSBridge.battery) info = JSON.parse(PSBridge.battery()); } catch (e) { info = null; }
    const box = $("#title_battery");
    if (!info || info.percent < 0) { box.classList.add("hidden"); return; }
    const p = info.percent;
    const name = info.plugged ? "battery-charging" : p > 75 ? "battery-100" : p > 50 ? "battery-75" : p > 25 ? "battery-50" : p > 10 ? "battery-25" : "battery-0";
    box.querySelector("span").textContent = `${padNumber(p, 3)}%`;
    setIcon(box.querySelector("img"), name);
    box.classList.remove("hidden");
  }

  // ------------------------------------------------------------ navigation
  current() { return this.stack[this.stack.length - 1]; }
  showPanel(name, title, extra, opts = {}) {
    const Cls = Panels[name];
    if (!Cls) { this.popup(`Panel "${name}" is not available in Rakerscreen`, 2); return; }
    if (opts.removeAll) { while (this.stack.length) this._pop(true); }
    const existing = this.stack.findIndex((s) => s.name === name && !opts.items);
    if (existing >= 0 && !opts.items) {
      while (this.stack.length - 1 > existing) this._pop(true);
      const cur = this.current();
      if (extra !== undefined && cur.panel.setExtra) cur.panel.setExtra(extra);
      this._attach(cur);
      return;
    }
    const cur = this.current();
    if (cur) this._detach(cur);
    let panel;
    try { panel = new Cls(this, title, extra, opts); }
    catch (e) { console.error(e); this.popup(`Unable to load panel ${name}\n${e.message}`); if (cur) this._attach(cur); return; }
    panel._created = Date.now();
    const entry = { name, panel, title, extra, opts };
    this.stack.push(entry);
    this._attach(entry);
  }
  _attach(entry) {
    // rebuild panels created before an option that changes their contents (reload_panels)
    if (entry.panel._created < this.reinitAt) {
      try {
        const fresh = new Panels[entry.name](this, entry.title, entry.extra, entry.opts);
        fresh._created = Date.now();
        entry.panel = fresh;
      } catch (e) { console.error(e); }
    }
    this.content.innerHTML = "";
    this.content.append(entry.panel.el);
    // a panel lower in the stack may have been built for the other orientation
    const p = entry.panel;
    if (p._vertical !== undefined && p._vertical !== this.vertical && p.relayout) p.relayout();
    p._vertical = this.vertical;
    this.setTitle(entry.panel.title);
    if (entry.panel.activate) entry.panel.activate();
    this.updateActionBar();
  }
  _detach(entry) { if (entry.panel.deactivate) entry.panel.deactivate(); entry.panel.el.remove(); }
  _pop(silent) { const e = this.stack.pop(); if (e) this._detach(e); return e; }
  back() {
    // hardware back: wake the screensaver; never navigate underneath the lock screen
    if (this.ssShowing) { this.closeScreensaver(); return; }
    if ($("#lock").classList.contains("show")) return;
    this.resetScreensaver(); // a key press is activity too
    const cur = this.current();
    if (cur && cur.panel.back && cur.panel.back()) { this.updateActionBar(); return; }
    this.goBack(false);
  }
  goBack(home) {
    if (this.stack.length <= 1) return;
    if (home) { while (this.stack.length > 1) this._pop(); }
    else this._pop();
    this._attach(this.current());
  }
  goToSubmenu(key) {
    if (key === "" ) key = this.printer.isPrinting() ? "__print" : "__main";
    this.showPanel("menu", MENU_TITLES[key] || key, null, { items: MENUS[key] });
  }
  menuItemClicked(item) {
    if (item.panel) this.showPanel(item.panel, item.name === "Rakerscreen" ? null : item.name);
    else if (item.method === "ks_confirm_save") this.confirmSave();
    else if (item.method === "lock_screen") this.lock();
    else if (item.method) this.sendAction(item.method, item.params || {});
    else if (item.submenu) this.showPanel("menu", item.name, null, { items: MENUS[item.submenu] });
  }

  // ------------------------------------------------------------ actions / dialogs / popups
  sendAction(method, params, btn) {
    if (btn) btn.busy(true);
    return this.mr.call(method, params || {}).catch((e) => this.popup(e.message || String(e))).finally(() => btn && btn.busy(false));
  }
  dialog(title, buttons, body, onClose) {
    const d = $("#dialog");
    d.innerHTML = "";
    const close = () => { d.classList.remove("show"); d.innerHTML = ""; if (onClose) onClose(); };
    const bodyEl = el("div", { class: "dialog-body" });
    if (typeof body === "string") bodyEl.textContent = body; else if (body) bodyEl.append(body);
    const bar = el("div", { class: "dialog-buttons" });
    for (const b of buttons || []) {
      // b.handler (Input.prompt's OK) decides itself whether the dialog closes; b.cb runs after closing
      bar.append(Button(null, b.name, b.style || "dialog-default", { onclick: () => { if (b.handler) { b.handler(); return; } close(); if (b.cb) b.cb(); } }));
    }
    const box = el("div", { class: "dialog" }, el("div", { class: "dialog-title" }, title || ""), bodyEl, buttons && buttons.length ? bar : null);
    if (!buttons || !buttons.length) box.addEventListener("click", close);
    d.append(box);
    d.classList.add("show");
    return close;
  }
  confirmSendAction(text, method, params) {
    this.dialog("Confirm", [
      { name: "Accept", style: "dialog-default", cb: () => this.sendAction(method, params) },
      { name: "Cancel", style: "dialog-error" },
    ], text);
  }
  /** Edit one increment set; onSaved runs after a valid save (panels using it are rebuilt). */
  editIncrements(key, onSaved) {
    const set = INCREMENT_SETS[key];
    const save = (values) => {
      Settings.set(`inc_${key}`, values); // null = defaults (getIncrements falls back)
      this.reloadPanels();
      if (onSaved) onSaved();
    };
    Input.prompt({
      title: set.name, layout: "numeric-list", value: getIncrements(key).join(", "), ok: "Save", selectAll: false,
      desc: `Values in ${set.unit}, separated by commas. Up to ${set.max}${set.decimals ? "" : ", whole numbers"}. Default: ${set.def.join(", ")}`,
      validate: (v) => parseIncrements(key, v).error, // the dialog stays open with what was typed
      onSubmit: (v) => { const r = parseIncrements(key, v); save(r.values); this.popup(`${set.name}: ${r.values.join(", ")} ${set.unit}`, 1); },
      buttons: [{ name: "Default", style: "dialog-warning", cb: () => { save(null); this.popup(`${set.name}: back to ${set.def.join(", ")}`, 1); } }],
    });
  }
  confirmSave() {
    this.confirmSendAction("Save configuration?\n\nKlipper will reboot", "printer.gcode.script", { script: "SAVE_CONFIG" });
  }
  popup(message, level = 3) {
    AppLog.add(level >= 3 ? "popup" : "info", [String(message).replace(/\s+/g, " ")]);
    const p = $("#popup");
    clearTimeout(this.popupTimer);
    const cls = level === 1 ? "message_popup_echo" : level === 2 ? "message_popup_warning" : "message_popup_error";
    p.innerHTML = "";
    p.append(el("div", { class: `message_popup ${cls}`, onclick: () => p.classList.remove("show") }, String(message)));
    p.classList.add("show");
    // autoclose_popups: "Close messages after a timeout"
    if (Settings.get("autoclose_popups")) this.popupTimer = setTimeout(() => p.classList.remove("show"), 10000);
    if (level >= 3) ErrorLog.add("ui", message);
    this.logNotification(String(message), level);
  }
  logNotification(message, level) {
    this.notifications.push({ time: new Date(), message, level });
    if (this.notifications.length > 200) this.notifications.shift();
    if (this.current() && this.current().name !== "notifications") this.notificationIcon(level >= 3 ? 3 : 1);
    const cur = this.current();
    if (cur && cur.name === "notifications" && cur.panel.refresh) cur.panel.refresh();
  }

  // ------------------------------------------------------------ connection lifecycle (screen.py)
  splashText(text) {
    const s = this.stack.find((e) => e.name === "splash_screen");
    if (s) s.panel.setText(text);
  }
  /** Show the splash screen with a status text. If the splash is already the root and the user has
      opened something on top of it (e.g. settings while it retries), only update its text, unless
      `force` (user pressed Connect) asks to bring it to the front. */
  /** User-initiated (re)connect: cancel the pending auto-retry so the two don't race. */
  connectNow() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.klippyRetry);
    this.mr.portOverride = null;
    this.toSplash(`Connecting to ${this.mr.url()}`, true);
    this.mr.connect();
  }
  toSplash(text, force = false) {
    const splashIsRoot = this.stack.length && this.stack[0].name === "splash_screen";
    if (!splashIsRoot) this.showPanel("splash_screen", null, null, { removeAll: true });
    else if (force && this.current().name !== "splash_screen") this.goBack(true);
    this.splashText(text);
    this.updateActionBar();
  }
  /* Ports Moonraker is commonly found on: the configured one, Moonraker's default, Beam's web
     server (proxies /websocket in some builds), and a second-instance default. */
  candidatePorts() {
    return [...new Set([String(Settings.get("moonraker_port")), "7125", "8888", "7126", "80"])];
  }
  onDisconnected(info) {
    this.initialized = false;
    clearTimeout(this.klippyRetry);
    const tried = this.mr.port();
    // Android's message carries the random local port and timeout ("from /127.0.0.1 (port 39664) after
    // 5000ms"), which made every retry a "new" error and defeated the log's repeat-collapsing.
    const reason = String((info && info.reason) || "")
      .replace(/\s*from \/[\w.:]+ \(port \d+\)/g, "").replace(/\s*after \d+ms/g, "").replace(/isConnected failed: /, "").trim();
    ErrorLog.add("conn", `${tried}: ${info && info.was ? "lost" : "failed"}${reason ? " - " + reason : ""}`);
    this.portsTried = this.portsTried || {};
    this.portsTried[tried] = info && info.was ? "lost" : "refused";
    let next = "";
    if (!(info && info.was) && Settings.get("auto_port")) {
      const c = this.candidatePorts();
      const i = (c.indexOf(tried) + 1) % c.length;
      this.mr.portOverride = c[i] === String(Settings.get("moonraker_port")) ? null : c[i];
      next = `\n\nTrying port ${this.mr.port()} next (auto-detect)`;
    }
    this.toSplash(`Moonraker: ${info && info.was ? "connection lost" : "can't connect"}\n\n${Settings.get("moonraker_host")}:${tried}${reason ? "\n" + reason : ""}${next}\n\nIs Klip Pocket running?`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.mr.connect(), 3000);
  }

  // ------------------------------------------------------------ lean error report
  buildReport() {
    let dev = {};
    try { if (window.PSBridge && PSBridge.deviceInfo) dev = JSON.parse(PSBridge.deviceInfo()); } catch (e) { dev = {}; }
    const chrome = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "?";
    const t = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toTimeString().slice(0, 8)}`; };
    const si = this.serverInfo || {};
    const lines = [
      `Rakerscreen ${VERSION}${dev.appVersion ? " (apk " + dev.appVersion + ")" : ""} report ${t(Date.now())}`,
      `Device: ${dev.manufacturer ? dev.manufacturer + " " + dev.model + ", Android " + dev.release + " (SDK " + dev.sdk + ")" : "browser"}, WebView ${chrome}`,
      `Endpoint: ${this.mr.url()} via ${this.mr.native ? "native" : "browser"} ws, api key ${Settings.get("moonraker_api_key") ? "set" : "none"}, auto-port ${Settings.get("auto_port") ? "on" : "off"}`,
      `Ports tried: ${Object.entries(this.portsTried || {}).map(([p, r]) => `${p}=${r}`).join(", ") || "-"}`,
      `Moonraker: ${this.mr.connected ? "connected " + (si.moonraker_version || "") : "disconnected"} | Klippy: ${si.klippy_state || this.printer.state}${this.printer.stat("webhooks", "state_message") && this.printer.state !== "ready" ? " - " + this.printer.stat("webhooks", "state_message") : ""}`,
      `Printer: ${this.initialized ? `${this.printer.tools.length} extruder(s), ${this.printer.heaters.length} heater(s), print ${this.printer.stat("print_stats", "state") || "-"}` : "not initialized"}`,
      `Screen: ${window.innerWidth}x${window.innerHeight} ${this.vertical ? "portrait" : "landscape"}, panel ${(this.current() || {}).name || "-"}`,
    ];
    if ((si.warnings || []).length) lines.push(`Moonraker warnings: ${si.warnings.map((w) => w.slice(0, 120)).join(" | ")}`);
    if ((si.failed_components || []).length) lines.push(`Failed components: ${si.failed_components.join(", ")}`);
    lines.push("", ErrorLog.entries.length ? "Errors (oldest first):" : "Errors: none");
    for (const e of ErrorLog.entries) lines.push(`${t(e.t1)}${e.n > 1 ? ` x${e.n}` : ""}${e.n > 1 && e.t1 - e.t0 > 1000 ? ` since ${t(e.t0)}` : ""} [${e.cat}] ${e.msg}`);
    return lines.join("\n");
  }
  shareReport() {
    const text = this.buildReport();
    const body = el("div", { style: { textAlign: "left", fontFamily: "monospace", fontSize: ".75em", whiteSpace: "pre-wrap", width: "100%" } }, text);
    const copy = () => {
      if (window.PSBridge && PSBridge.copyText) { PSBridge.copyText(text); this.popup("Report copied", 1); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => this.popup("Report copied", 1), () => this.popup("Copy failed"));
    };
    const buttons = [];
    if (window.PSBridge && PSBridge.shareText) buttons.push({ name: "Share", style: "dialog-default", cb: () => PSBridge.shareText("Rakerscreen error report", text) });
    buttons.push({ name: "Copy", style: "dialog-info", cb: copy });
    buttons.push({ name: "Clear log", style: "dialog-warning", cb: () => { ErrorLog.clear(); this.portsTried = {}; this.popup("Error log cleared", 1); } });
    buttons.push({ name: "Close", style: "dialog-error" });
    this.dialog("Error Report", buttons, body);
  }
  async onConnected() {
    clearTimeout(this.reconnectTimer);
    if (this.mr.portOverride) {
      // auto-detect found Moonraker on another port: remember it
      Settings.set("moonraker_port", this.mr.portOverride);
      this.mr.portOverride = null;
    }
    (this.portsTried = this.portsTried || {})[this.mr.port()] = "ok";
    try {
      const ident = { client_name: "Rakerscreen", version: VERSION, type: "display", url: "https://github.com/KlipperScreen/KlipperScreen" };
      const key = Settings.get("moonraker_api_key");
      if (key) ident.api_key = key;
      await this.mr.call("server.connection.identify", ident).catch(() => {});
    } catch (e) { /* identify is optional */ }
    await this.initKlipper();
  }
  /** Single-flight wrapper: the retry timer, notify_klippy_ready and the Retry button can all ask for
      an init; running two at once double-subscribed and built the dashboard twice. Errors retry. */
  initKlipper() {
    if (this._initRun) return this._initRun;
    this._initRun = this._initKlipper().catch((e) => {
      if (!this.mr.connected) return; // connection dropped mid-init: onDisconnected already explains it
      console.error(e);
      ErrorLog.add("init", e.message || e);
      this.toSplash(`Error initializing: ${e.message || e}\n\nRetrying...`);
      clearTimeout(this.klippyRetry);
      if (this.mr.connected) this.klippyRetry = setTimeout(() => this.initKlipper(), 5000);
    }).finally(() => { this._initRun = null; });
    return this._initRun;
  }
  async _initKlipper() {
    clearTimeout(this.klippyRetry);
    this.serverInfo = await this.mr.call("server.info");
    if (!this.serverInfo.klippy_connected || this.serverInfo.klippy_state !== "ready") {
      let msg = `Moonraker: connected\n\nKlipper: ${this.serverInfo.klippy_state}`;
      try {
        const info = await this.mr.call("printer.info");
        if (info.state_message) msg += `\n\n${info.state_message}`;
      } catch (e) { /* klippy not connected */ }
      this.printer.state = this.serverInfo.klippy_state || "disconnected";
      this.toSplash(msg);
      this.klippyRetry = setTimeout(() => this.initKlipper(), 3000);
      return;
    }
    const info = await this.mr.call("printer.info");
    this.printerName = info.hostname && info.hostname !== "localhost" ? info.hostname : "Printer";
    const list = await this.mr.call("printer.objects.list");
    const cfg = await this.mr.call("printer.objects.query", { objects: { configfile: ["config"] } });
    this.printer.reset();
    this.printer.reinit(list.objects, cfg.status.configfile.config);
    try { this.printer.availableCommands = await this.mr.call("printer.gcode.help"); } catch (e) { this.printer.availableCommands = {}; }
    try { this.webcams = (await this.mr.call("server.webcams.list")).webcams || []; } catch (e) { this.webcams = []; }
    await this.loadTempStore();
    await this.loadGcodeStore();
    const sub = await this.mr.call("printer.objects.subscribe", { objects: this.subscriptionObjects() });
    this.initialized = false;
    this.printer.state = "startup";
    this.printer.update(sub.status);
    this.initialized = true;
    this.titlebarPopulated = false;
    this.populateTitlebar();
    this.onPrinterState(this.printer.state, "startup", true);
  }
  subscriptionObjects() {
    const o = {
      bed_mesh: ["profile_name", "mesh_max", "mesh_min", "probed_matrix", "profiles"],
      quad_gantry_level: ["applied"],
      z_tilt: ["applied"],
      configfile: ["config", "warnings", "save_config_pending"],
      display_status: ["progress", "message"],
      fan: ["speed"],
      gcode_move: ["extrude_factor", "gcode_position", "homing_origin", "speed_factor", "speed", "absolute_coordinates"],
      idle_timeout: ["state"],
      pause_resume: ["is_paused"],
      print_stats: ["print_duration", "total_duration", "filament_used", "filename", "state", "message", "info"],
      toolhead: ["homed_axes", "axis_minimum", "axis_maximum","estimated_print_time", "print_time", "position", "extruder", "max_accel", "minimum_cruise_ratio", "max_velocity", "square_corner_velocity"],
      virtual_sdcard: ["file_position", "is_active", "progress"],
      webhooks: ["state", "state_message"],
      motion_report: ["live_position", "live_velocity", "live_extruder_velocity"],
      exclude_object: ["current_object", "objects", "excluded_objects"],
      manual_probe: ["is_active", "z_position", "z_position_lower", "z_position_upper"],
      probe: ["last_z_result"],
    };
    const p = this.printer;
    for (const e of p.tools) o[e] = ["target", "temperature", "pressure_advance", "smooth_time", "power"];
    for (const h of p.heaters) o[h] = ["target", "temperature", "power"];
    for (const t of p.sensors) o[t] = ["temperature"];
    for (const f of p.tempFans) o[f] = ["target", "temperature", "speed"];
    for (const f of p.fans) o[f] = ["speed"];
    for (const f of p.filamentSensors) o[f] = ["enabled", "filament_detected"];
    for (const pin of p.outputPins) o[pin] = ["value"];
    for (const led of p.leds) o[led] = ["color_data"];
    for (const k of Object.keys(o)) if (!p.objects.includes(k)) delete o[k];
    return o;
  }
  async loadTempStore() {
    try {
      const ts = await this.mr.call("server.temperature_store", { include_monitors: false });
      const now = Date.now();
      for (const [dev, s] of Object.entries(ts)) {
        const n = (s.temperatures || []).length;
        this.printer.tempStore[dev] = {
          t: Array.from({ length: n }, (_, i) => now - (n - i) * 1000),
          temperatures: s.temperatures || [],
          targets: s.targets || new Array(n).fill(0),
          powers: s.powers || new Array(n).fill(0),
        };
      }
    } catch (e) { /* optional */ }
  }
  async loadGcodeStore() {
    try {
      const gs = await this.mr.call("server.gcode_store", { count: 100 });
      this.gcodeLog = (gs.gcode_store || []).map((g) => ({ time: new Date(g.time * 1000), message: g.message, type: g.type }));
    } catch (e) { this.gcodeLog = []; }
  }

  onPrinterState(state, old, initial) {
    this.updateActionBar();
    this.resetScreensaver(); // blanking time differs while printing
    if (!this.initialized) return;
    if (state === "printing" || state === "paused") {
      if (state === "printing" && old !== "paused") this.closeScreensaver(); // new print wakes the screen
      if (!this.stack.some((e) => e.name === "job_status")) this.showPanel("job_status", null, null, { removeAll: true });
      // auto_open_extrude: "Auto-open Extrude On Pause" (screen.state_paused)
      if (state === "paused" && old === "printing" && !initial && Settings.get("auto_open_extrude") && this.printer.tools.length) this.showPanel("extrude");
    } else if (state === "ready") {
      const cur = this.current();
      if (initial || !cur || cur.name === "splash_screen") this.stateReady();
    } else if (["startup", "shutdown", "error", "disconnected"].includes(state)) {
      const msg = this.printer.stat("webhooks", "state_message") || "";
      if (state === "shutdown" || state === "error") ErrorLog.add("klippy", `${state}: ${msg.split("\n")[0]}`);
      this.toSplash(`Klipper: ${state}\n\n${msg}`);
      if (state === "shutdown" || state === "error") {
        clearTimeout(this.klippyRetry);
      }
    }
  }
  stateReady() {
    this.showPanel("main_menu", null, null, { removeAll: true, items: MENUS.__main });
  }

  onNotify(method, params) {
    switch (method) {
      case "notify_status_update": {
        const data = params[0] || {};
        this.printer.update(data);
        this.updateTitlebarTemps();
        if (data.toolhead && data.toolhead.extruder) { this.titlebarPopulated = false; this.populateTitlebar(); }
        for (const e of this.stack) if (e.panel.update) { try { e.panel.update(data); } catch (err) { console.error(err); } }
        break;
      }
      case "notify_gcode_response": {
        const text = params[0] || "";
        this.gcodeLog.push({ time: new Date(), message: text, type: "response" });
        if (this.gcodeLog.length > 500) this.gcodeLog.shift();
        if (text.startsWith("!! ")) this.popup(text.slice(3), 3);
        else if (text.startsWith("echo: ") && !text.startsWith("echo: action:")) this.logNotification(text.slice(6), 1);
        if (text.startsWith("// action:")) this.processAction(text.slice(10).trim());
        for (const e of this.stack) if (e.panel.onGcodeResponse) e.panel.onGcodeResponse(text);
        break;
      }
      case "notify_klippy_ready":
        this.initKlipper();
        break;
      case "notify_klippy_shutdown":
        this.printer.update({ webhooks: { state: "shutdown" } });
        this.mr.call("printer.info").then((i) => {
          ErrorLog.add("klippy", `shutdown: ${(i.state_message || "").split("\n")[0]}`);
          this.toSplash(`Klipper: shutdown\n\n${i.state_message || ""}`);
        }).catch(() => {});
        break;
      case "notify_klippy_disconnected":
        this.initialized = false;
        this.printer.state = "disconnected";
        this.toSplash("Klipper: disconnected\n\nWaiting for Klipper...");
        this.klippyRetry = setTimeout(() => this.initKlipper(), 2000);
        break;
      case "notify_filelist_changed":
      case "notify_metadata_update":
        for (const e of this.stack) if (e.panel.onFilesChanged) e.panel.onFilesChanged(method, params[0]);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ heater helpers (MoonrakerApi.set_*_temp)
  setTargetTemp(dev, temp) {
    const max = parseFloat(this.printer.configSection(dev).max_temp || "9999");
    temp = Math.round(temp);
    if (temp > max) { this.popup(`Can't set above the maximum: ${max}`); return false; }
    temp = Math.max(temp, 0);
    const name = devName(dev);
    let script;
    if (dev.startsWith("extruder")) script = `M104 T${this.printer.toolNumber(dev)} S${temp}`;
    else if (dev === "heater_bed") script = `M140 S${temp}`;
    else if (dev.startsWith("heater_generic ")) script = `SET_HEATER_TEMPERATURE HEATER="${name}" TARGET=${temp}`;
    else if (dev.startsWith("temperature_fan ")) script = `SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN="${name}" TARGET=${temp}`;
    else { this.popup(`Unknown Heater ${dev}`); return false; }
    this.mr.gcode(script).catch((e) => this.popup(e.message));
    return true;
  }

  // ------------------------------------------------------------ "// action:" lines (screen.py process_action)
  processAction(action) {
    if (action.startsWith("prompt")) {
      if (action.startsWith("prompt_begin")) { if (this.prompt) this.prompt.end(); this.prompt = new MacroPrompt(this); }
      if (this.prompt) this.prompt.decode(action);
    } else if (action.startsWith("ks_show")) {
      // ks_show <panel> [title="…"]
      const m = action.slice(7).trim().match(/^(\S+)(?:\s+(\w+)\s*=\s*(.+))?$/);
      if (!m) return;
      const [, panel, key, raw] = m;
      if (!Panels[panel]) { this.popup(`Unknown panel: ${panel}`); return; }
      const title = key === "title" && raw ? raw.trim().replace(/^(['"])(.*)\1$/, "$2") : null;
      this.showPanel(panel, title);
    }
  }
}

/** Klipper macro prompts (RESPOND type=command msg="action:prompt_…"), ks_includes/widgets/prompts.py. */
class MacroPrompt {
  constructor(app) { this.app = app; this.header = ""; this.text = ""; this.body = []; this.footer = []; this.groups = []; this.closeFn = null; this.root = null; }
  decode(data) {
    if (data.startsWith("prompt_begin")) { this.header = data.slice(12).trim(); this.text = ""; this.body = []; this.footer = []; return; }
    if (data.startsWith("prompt_text")) { this.text = data.slice(11).trim(); return; }
    if (data.startsWith("prompt_button_group_start")) { this.groups.push([]); return; }
    if (data.startsWith("prompt_button_group_end")) { const g = this.groups.pop(); if (g) this.body.push({ group: g }); return; }
    if (data.startsWith("prompt_button ") || data.startsWith("prompt_footer_button ")) {
      const footer = data.startsWith("prompt_footer_button ");
      const params = data.slice(footer ? 21 : 14).split("|").map((s) => s.trim());
      if (params.length > 3) return;
      const b = { name: params[0], gcode: params[1] || params[0], style: `dialog-${params[2] || "default"}` };
      if (footer) this.footer.push(b);
      else if (this.groups.length) this.groups[this.groups.length - 1].push(b);
      else this.body.push(b);
      return;
    }
    if (data === "prompt_show") { if (!this.root) this.show(); return; }
    if (data === "prompt_end") this.end();
  }
  send(gcode) { this.app.mr.gcode(gcode).catch((e) => this.app.popup(e.message)); }
  show() {
    const btn = (b) => Button(null, b.name, b.style, { onclick: () => this.send(b.gcode) });
    const root = el("div", { class: "macro-prompt" });
    const x = Button("cancel", null, "color2 prompt-close", { side: true, onclick: () => this.close() });
    root.append(x);
    if (this.text) root.append(el("div", { class: "prompt-text" }, this.text));
    for (const item of this.body) {
      if (item.group) root.append(el("div", { class: "prompt-group", style: { gridTemplateColumns: `repeat(${Math.min(4, item.group.length)}, 1fr)` } }, ...item.group.map(btn)));
      else root.append(btn(item));
    }
    this.root = root;
    // footer buttons send their G-code and leave the prompt open: the macro ends it with prompt_end
    // (a dialog without buttons closes on any tap, so a prompt without footer buttons gets a Close one)
    const footer = this.footer.length ? this.footer.map((b) => ({ name: b.name, style: b.style, handler: () => this.send(b.gcode) }))
      : [{ name: "Close", style: "dialog-error", handler: () => this.close() }];
    this.closeFn = this.app.dialog(this.header || "Prompt", footer, root,
      () => { if (this.app.prompt === this) this.app.prompt = null; this.root = null; });
  }
  /** The user closed it: tell Klipper, which answers with prompt_end. */
  close() { this.send('RESPOND type="command" msg="action:prompt_end"'); this.end(); }
  end() {
    if (this.root && this.root.isConnected && this.closeFn) this.closeFn();
    this.root = null;
    if (this.app.prompt === this) this.app.prompt = null;
  }
}

window.addEventListener("DOMContentLoaded", () => { window.screenApp = new ScreenApp(); });
