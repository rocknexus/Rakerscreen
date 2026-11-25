/* Input stacking. While our last command is still out (Klipper answers a move as soon as it's queued, but not a
   heat-up wait or a homing until they're done), taps are held here and merged as they come in, then sent as one
   script the moment the answer comes. Moves aren't held until the toolhead stops: Klipper's look-ahead joins
   queued jogs, so tapping fast keeps it moving until the taps stop.
     move     jogs add up per axis (opposite taps cancel out)
     extrude  extrusions at the same speed add up
     zadj     Z offset steps add up
     set      a value (temperature, fan, speed factor, ...) keeps only the latest, in the place of the first
     raw      anything else, kept as is and in order (moves and steps don't merge across it)
   A wait started elsewhere (a macro, the printer's own screen) holds our first command in Klipper, so the rest stack. */
"use strict";

class InputStack {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.out = 0; // scripts sent and not finished yet
    this.chip = el("div", { id: "inputstack" });
    document.body.append(this.chip);
  }
  get p() { return this.app.printer; }
  /** Our last command hasn't been answered yet. */
  busy() { return this.out > 0; }
  /** Add an input. item: {type, ...}; btn flashes to show the tap was taken. */
  add(item, btn) {
    if (btn && item.type !== "raw") { btn.classList.remove("stacked"); void btn.offsetWidth; btn.classList.add("stacked"); }
    this.merge(item);
    this.flush();
    this.render();
  }
  merge(item) {
    const L = this.items;
    if (item.type === "set") {
      for (let i = L.length - 1; i >= 0; i--) if (item.drops && item.drops.includes(L[i].type)) L.splice(i, 1);
      const same = L.find((x) => x.type === "set" && x.key === item.key);
      if (same) Object.assign(same, item); else L.push(item);
      return;
    }
    // moves, extrusions and Z steps merge with the last one of their kind unless a raw command is in between
    let last = null;
    for (let i = L.length - 1; i >= 0; i--) { if (L[i].type === "set") continue; last = L[i]; break; }
    if (last && last.type === item.type) {
      if (item.type === "move") {
        for (const [a, d] of Object.entries(item.axes)) {
          last.axes[a] = Math.round(((last.axes[a] || 0) + d) * 1e4) / 1e4;
          if (Math.abs(last.axes[a]) < 1e-6) delete last.axes[a];
        }
        last.f = Math.min(last.f, item.f);
        if (Object.values(last.axes).every((d) => Math.abs(d) < 1e-6)) L.splice(L.indexOf(last), 1);
        return;
      }
      if (item.type === "extrude" && last.f === item.f && last.pre === item.pre) {
        last.e = Math.round((last.e + item.e) * 1e4) / 1e4;
        if (Math.abs(last.e) < 1e-6) L.splice(L.indexOf(last), 1);
        return;
      }
      if (item.type === "zadj") {
        last.dz = Math.round((last.dz + item.dz) * 1e4) / 1e4;
        if (Math.abs(last.dz) < 1e-6) L.splice(L.indexOf(last), 1);
        return;
      }
    }
    L.push(item);
  }
  /** The G-code for one item, worked out when it's sent (so it uses the printer's mode then). */
  script(x) {
    const n = (v) => String(Math.round(v * 1e4) / 1e4);
    if (x.type === "move") {
      const abs = this.p.stat("gcode_move", "absolute_coordinates");
      const parts = Object.entries(x.axes).filter(([, d]) => Math.abs(d) > 1e-6).map(([a, d]) => `${a.toUpperCase()}${n(d)}`);
      return `G91\nG0 ${parts.join(" ")} F${Math.round(x.f)}${abs ? "\nG90" : ""}`;
    }
    if (x.type === "extrude") return `M83\n${x.pre || ""}G1 E${n(x.e)} F${Math.round(x.f)}`;
    if (x.type === "zadj") return `SET_GCODE_OFFSET Z_ADJUST=${n(x.dz)} MOVE=1`;
    return x.script;
  }
  label(x) {
    const s = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 1000) / 1000)}`;
    if (x.type === "move") return Object.entries(x.axes).map(([a, d]) => `${a.toUpperCase()}${s(d)}`).join(" ");
    if (x.type === "extrude") return `E${s(x.e)}`;
    if (x.type === "zadj") return `Z offset ${s(x.dz)}`;
    return x.label || x.script.split(/\s/)[0];
  }
  flush(force) {
    if (!this.items.length || (!force && this.busy())) return;
    const batch = this.items.splice(0);
    const script = batch.map((x) => this.script(x)).join("\n");
    // raw commands (Home, macros, ...) show busy on their button until Klipper has run them, as before
    const btns = batch.map((x) => x.btn).filter(Boolean);
    btns.forEach((b) => b.busy(true));
    this.out++;
    this.render();
    this.app.mr.gcode(script)
      .catch((e) => this.app.popup(e.message || String(e)))
      .finally(() => { this.out--; btns.forEach((b) => b.busy(false)); this.flush(); this.render(); });
  }
  clear() { this.items = []; this.render(); }
  render() {
    for (const e of this.app.stack || []) if (e.panel.onInputs) e.panel.onInputs();
    const c = this.chip;
    c.innerHTML = "";
    if (!this.items.length) { c.classList.remove("show"); return; }
    c.classList.add("show");
    c.append(
      el("span", { class: "is-text" }, `Waiting for Klipper: ${this.items.map((x) => this.label(x)).join(" · ")}`),
      Button(null, "Send now", "color3", { lines: 1, onclick: () => this.flush(true) }),
      Button(null, "Clear", "color2", { lines: 1, onclick: () => this.clear() }));
  }
}
