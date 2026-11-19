// Point-out overlay for reviewing Rakerscreen in a browser (dev only, never in the APK).
// The mock server injects this into index.html. Tap "Point", tap anything on screen, type a note.
// Notes go to tools/feedback/notes.json through the mock server; replies written there show up here.
(function () {
  "use strict";
  // opened from another device (phone on the same Wi-Fi): talk to the mock on this host, not the phone's 127.0.0.1
  if (!/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    try { if (Settings.get("moonraker_host") !== location.hostname) Settings.set("moonraker_host", location.hostname); } catch (e) { /* not loaded */ }
  }

  const css = `
  /* the app hides the mouse pointer (touchscreen default); keep it visible while reviewing */
  html body:not(.ann-x), html body:not(.ann-x) * { cursor: auto !important; }
  html body:not(.ann-x) .btn, html body:not(.ann-x) #ann-bar button, html body:not(.ann-x) .ann-pin { cursor: pointer !important; }
  html body:not(.ann-x) #ann-shield { cursor: crosshair !important; }
  #ann-bar { position: fixed; right: 10px; bottom: 10px; z-index: 2000; display: flex; gap: 6px; font: 15px/1.2 system-ui, sans-serif; }
  #ann-bar button { border: 0; border-radius: 22px; padding: 10px 14px; background: #e8a33d; color: #111; font: inherit; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,.5); cursor: pointer; }
  #ann-bar button.on { background: #ff5a36; color: #fff; }
  #ann-bar button.sec { background: #2c3440; color: #eee; }
  #ann-bar button[title] { cursor: grab; touch-action: none; padding: 10px 10px; }
  #ann-shield { position: fixed; inset: 0; z-index: 1990; cursor: crosshair; background: rgba(255,90,54,.07); outline: 3px dashed #ff5a36; outline-offset: -3px; }
  #ann-hint { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2001; background: #ff5a36; color: #fff; padding: 6px 12px; border-radius: 14px; font: 600 14px system-ui, sans-serif; pointer-events: none; }
  .ann-pin { position: fixed; z-index: 1995; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); background: #ff5a36; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,.6); cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .ann-pin span { transform: rotate(45deg); color: #fff; font: 700 13px system-ui, sans-serif; }
  .ann-pin.done { background: #2e9e5b; }
  .ann-pin.replied { background: #3b82f6; }
  .ann-hl { position: fixed; z-index: 1994; border: 2px solid #ff5a36; border-radius: 6px; pointer-events: none; box-shadow: 0 0 0 9999px rgba(0,0,0,.25); }
  #ann-box { position: fixed; z-index: 2002; left: 50%; top: 12px; transform: translateX(-50%); width: min(460px, calc(100vw - 24px)); background: #1d232b; color: #eee; border: 1px solid #445; border-radius: 10px; padding: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.6); font: 15px/1.35 system-ui, sans-serif; }
  #ann-box .what { font-size: 12px; color: #9aa; margin-bottom: 6px; word-break: break-word; }
  #ann-box textarea { width: 100%; box-sizing: border-box; min-height: 84px; resize: vertical; background: #0f1317; color: #fff; border: 1px solid #556; border-radius: 6px; padding: 8px; font: inherit; }
  #ann-box .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; flex-wrap: wrap; }
  #ann-box button { border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; background: #2c3440; color: #eee; }
  #ann-box button.go { background: #e8a33d; color: #111; }
  #ann-box button.del { background: #7a2630; color: #fff; margin-right: auto; }
  #ann-box .reply { margin-top: 8px; padding: 8px; background: #16314f; border-radius: 6px; white-space: pre-wrap; }
  #ann-box .note { white-space: pre-wrap; }
  #ann-list { max-height: 60vh; overflow: auto; }
  #ann-list .item { padding: 8px 0; border-bottom: 1px solid #334; cursor: pointer; }
  #ann-list .item b { color: #e8a33d; }
  #ann-list .item.done b { color: #2e9e5b; }
  `;
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

  const make = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k !== null && k !== undefined)); return n; };
  let notes = [], pointing = false, box = null, hl = null;
  const pins = make("div");
  document.body.append(pins);

  const panelName = () => { try { const c = screenApp.current(); return c ? c.name : "?"; } catch (e) { return "?"; } };
  const panelTitle = () => { try { const c = screenApp.current(); return (c && (c.title || (c.panel && c.panel.title))) || ""; } catch (e) { return ""; } };

  /** Short human description of what was tapped, for the note. */
  function describe(t) {
    const parts = [];
    const btn = t.closest(".btn");
    const text = (n) => (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (btn) parts.push(`button "${text(btn) || [...btn.querySelectorAll("img")].map((i) => (i.src.split("/").pop() || "").replace(".svg", "")).join(",") || "?"}"`);
    else if (text(t)) parts.push(`"${text(t)}"`);
    const area = t.closest("[id], .heater-tile, .sensor-banner, .togglerow, .keypad, .dialog, .macro-edit-bar");
    if (area) parts.push(`in ${area.id ? "#" + area.id : "." + [...area.classList].join(".")}`);
    parts.push(`<${t.tagName.toLowerCase()}${t.className && typeof t.className === "string" ? " class=" + t.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}>`);
    return parts.join(" ");
  }

  async function load() {
    try { const r = await fetch("/__notes", { cache: "no-store" }); notes = await r.json(); } catch (e) { /* mock not running */ }
    render();
  }
  async function save(note) {
    const r = await fetch("/__notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(note) });
    notes = await r.json(); render();
  }
  async function remove(id) {
    const r = await fetch(`/__notes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    notes = await r.json(); render();
  }

  function render() {
    pins.innerHTML = "";
    const here = panelName();
    for (const n of notes) {
      if (n.panel !== here) continue;
      const pin = make("div", { className: "ann-pin" + (n.status === "done" ? " done" : n.reply ? " replied" : ""), title: n.text }, make("span", { textContent: String(n.id) }));
      pin.style.left = `${n.xp * innerWidth}px`; pin.style.top = `${n.yp * innerHeight}px`;
      pin.addEventListener("click", (e) => { e.stopPropagation(); show(n); });
      pins.append(pin);
    }
    count.textContent = `Notes (${notes.filter((n) => n.status !== "done").length})`;
  }

  function closeBox() { if (box) box.remove(); box = null; if (hl) hl.remove(); hl = null; }
  function highlight(rect) {
    if (hl) hl.remove();
    if (!rect) return;
    hl = make("div", { className: "ann-hl" });
    Object.assign(hl.style, { left: `${rect.x - 3}px`, top: `${rect.y - 3}px`, width: `${rect.w + 6}px`, height: `${rect.h + 6}px` });
    document.body.append(hl);
  }

  /** Editor for a new note at x,y. */
  function compose(x, y, target) {
    closeBox();
    const r = (target.closest(".btn") || target).getBoundingClientRect();
    const rect = { x: r.x, y: r.y, w: r.width, h: r.height };
    highlight(rect);
    const what = describe(target);
    const ta = make("textarea", { placeholder: "What should change here?" });
    ta.dataset.kb = "none"; // the dev overlay uses the device's own keyboard, not the app's
    const submit = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      save({ panel: panelName(), title: panelTitle(), xp: x / innerWidth, yp: y / innerHeight, rect, what, text, viewport: [innerWidth, innerHeight] });
      closeBox();
    };
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); });
    box = make("div", { id: "ann-box" },
      make("div", { className: "what", textContent: `${panelName()} · ${what}` }), ta,
      make("div", { className: "row" }, make("button", { textContent: "Cancel", onclick: closeBox }), make("button", { className: "go", textContent: "Send note", onclick: submit })));
    document.body.append(box);
    setTimeout(() => ta.focus(), 30);
  }

  /** An existing note, with Claude's reply if there is one. */
  function show(n) {
    closeBox();
    highlight(n.rect);
    box = make("div", { id: "ann-box" },
      make("div", { className: "what", textContent: `#${n.id} · ${n.panel} · ${n.what}${n.status === "done" ? " · done" : ""}` }),
      make("div", { className: "note", textContent: n.text }),
      n.reply ? make("div", { className: "reply", textContent: `Claude: ${n.reply}` }) : null,
      make("div", { className: "row" },
        make("button", { className: "del", textContent: "Delete", onclick: () => { remove(n.id); closeBox(); } }),
        make("button", { textContent: "Close", onclick: closeBox })));
    document.body.append(box);
  }

  function list() {
    closeBox();
    const items = notes.length ? notes.map((n) => {
      const it = make("div", { className: "item" + (n.status === "done" ? " done" : "") },
        make("b", { textContent: `#${n.id} ${n.panel}` }), ` ${n.status === "done" ? "(done) " : n.reply ? "(replied) " : ""}${n.text}`);
      it.addEventListener("click", () => { try { if (n.panel !== panelName() && Panels[n.panel]) screenApp.showPanel(n.panel); } catch (e) { /* ignore */ } setTimeout(() => { render(); show(n); }, 150); });
      return it;
    }) : [make("div", { textContent: "No notes yet. Tap Point, then tap something on screen." })];
    box = make("div", { id: "ann-box" }, make("div", { id: "ann-list" }, ...items),
      make("div", { className: "row" }, make("button", { textContent: "Close", onclick: closeBox })));
    document.body.append(box);
  }

  // pointing mode: a shield catches the next tap so the app underneath doesn't react to it
  const shield = make("div", { id: "ann-shield" });
  const hint = make("div", { id: "ann-hint", textContent: "Tap what you want to point out" });
  shield.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    shield.remove(); hint.remove();
    const t = document.elementFromPoint(e.clientX, e.clientY) || document.body;
    setPointing(false);
    compose(e.clientX, e.clientY, t);
  });
  function setPointing(on) {
    pointing = on;
    point.classList.toggle("on", on);
    point.textContent = on ? "Cancel" : "📍 Point";
    if (on) { closeBox(); document.body.append(shield, hint); } else { shield.remove(); hint.remove(); }
  }
  const point = make("button", { textContent: "📍 Point", onclick: () => setPointing(!pointing) });
  const count = make("button", { className: "sec", textContent: "Notes (0)", onclick: list });
  const grip = make("button", { className: "sec", textContent: "⠿", title: "Drag to move" });
  const bar = make("div", { id: "ann-bar" }, grip, count, point);
  document.body.append(bar);
  // drag the grip to move the buttons out of the way; the spot is remembered
  try { const s = JSON.parse(localStorage.getItem("ann-bar-pos")); if (s) Object.assign(bar.style, { left: s.l + "px", top: s.t + "px", right: "auto", bottom: "auto" }); } catch (e) { /* none */ }
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const r = bar.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      const l = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx)), t = Math.max(0, Math.min(innerHeight - r.height, ev.clientY - dy));
      Object.assign(bar.style, { left: l + "px", top: t + "px", right: "auto", bottom: "auto" });
    };
    const up = () => {
      grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up);
      try { const b = bar.getBoundingClientRect(); localStorage.setItem("ann-bar-pos", JSON.stringify({ l: b.left, t: b.top })); } catch (e) { /* ignore */ }
    };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
  });

  // follow panel changes and window size; pick up replies
  let lastPanel = null;
  setInterval(() => { const p = panelName(); if (p !== lastPanel) { lastPanel = p; render(); } }, 400);
  addEventListener("resize", render);
  setInterval(load, 3000);
  load();
})();
