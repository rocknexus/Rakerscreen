/* Rakerscreen input module: the one place text and number input comes from. Android's keyboard is
   never used (KlipperScreen likewise ships its own keyboard widget).

   Input.prompt({...})  dialog asking for text: title, value, layout, password, desc, validate, onSubmit
   Input.number({...})  dialog asking for a number: title, value, min, max, decimals, unit, onSubmit
   Input.open(field)    open the keyboard on an inline field now (instead of field.focus())
   Input.prepare(field) mark a field as in-app-keyboard only; el() does this for every input it makes,
                        and a DOM observer catches any field created another way

   Three layers keep Android's keyboard away: inputmode="none" on every field, the activity's
   SOFT_INPUT_STATE_ALWAYS_HIDDEN, and a WebView that offers Android no text input connection.

   The keyboard takes one half of the screen (right half in landscape, bottom half in portrait); the
   screen or dialog moves into the other half. Keys keep a fixed size and are centred, not stretched.

   Layouts (chosen by the field's data-kb):
     numeric       phone keypad 1 2 3 / 4 5 6 / 7 8 9 / . 0 ⌫, then Done (± when data-neg is set)
     numeric-list  the same plus a comma key (lists such as increments)
     text          QWERTY with a number row; #+= switches to symbols
     gcode         QWERTY with caps lock on, stays open after Send (console)
     none          no keyboard (fields that have their own keypad, like the temperature numpad)
*/
"use strict";

const VK_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

class VirtualKeyboard {
  constructor(app) {
    this.app = app;
    this.target = null;
    this.layer = "letters"; // letters | symbols
    this.shift = false;     // next letter upper case
    this.caps = false;      // caps lock
    this.root = el("div", { id: "vk", class: "hidden" });
    document.body.append(this.root);
    // keep focus in the field while keys are pressed
    this.root.addEventListener("pointerdown", (e) => e.preventDefault());
    this.root.addEventListener("mousedown", (e) => e.preventDefault());
    document.addEventListener("focusin", (e) => this.onFocus(e.target));
    // a tap on a field opens the keyboard even when focus events are withheld (window not focused)
    document.addEventListener("click", (e) => { if (this.eligible(e.target)) this.onFocus(e.target); }, true);
    document.addEventListener("focusout", () => setTimeout(() => this.checkFocus(), 0));
    window.addEventListener("resize", () => { if (this.visible()) this.fit(); });
    // safety net: a field made without el() (innerHTML, a future panel) still never gets Android's keyboard
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const list = n.matches("input, textarea") ? [n] : n.querySelectorAll("input, textarea");
        for (const f of list) if (!f.dataset.kb) Input.prepare(f, {});
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  visible() { return !this.root.classList.contains("hidden"); }
  eligible(t) {
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && t.dataset.kb && t.dataset.kb !== "none" && !t.readOnly && !t.disabled;
  }
  onFocus(t) {
    if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.dataset.kb) Input.prepare(t, {});
    if (!this.eligible(t)) return;
    const changedField = t !== this.target;
    this.target = t;
    if (changedField) {
      this.startValue = t.value;
      const kb = t.dataset.kb;
      this.mode = kb.startsWith("numeric") ? "numeric" : "text";
      this.layer = "letters";
      this.shift = false;
      this.caps = kb === "gcode";
      // tapping a field puts the caret where it was tapped; programmatic focus puts it at the end
      if (document.activeElement === t && t.selectionStart === 0 && t.selectionEnd === 0 && t.value) {
        try { t.setSelectionRange(t.value.length, t.value.length); } catch (e) { /* not supported */ }
      }
    }
    this.render();
    this.show();
  }
  checkFocus() {
    const a = document.activeElement;
    if (this.eligible(a)) return; // moved to another field: onFocus handled it
    if (!document.hasFocus()) return; // the whole window lost focus (app switch): keep the keyboard
    // a tap elsewhere in an open dialog (its text, its background) keeps the field and keyboard;
    // the keyboard goes when the dialog closes (the field leaves the page)
    const t = this.target, dlg = t && t.closest("#dialog");
    if (dlg && dlg.classList.contains("show") && document.contains(t)) { try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); } return; }
    if (this.target) this.commit();
    this.hide();
  }
  show() {
    this.root.classList.remove("hidden");
    this.fit();
    document.body.classList.add("kb-open");
    // a field removed from the page (dialog closed, panel changed) fires no focusout: watch for it
    clearInterval(this.watch);
    this.watch = setInterval(() => { if (!this.target || !document.contains(this.target)) { this.hide(); } }, 250);
    // the screen has moved out from under the keyboard; keep the field in view
    requestAnimationFrame(() => { if (this.target) this.target.scrollIntoView({ block: "nearest", inline: "nearest" }); });
  }
  /** Size the keys for the half of the screen the keyboard has, and move the rest of the UI aside. */
  fit() {
    const land = window.innerWidth >= window.innerHeight;
    const W = land ? window.innerWidth / 2 : window.innerWidth;
    const H = land ? window.innerHeight : window.innerHeight / 2;
    const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const gap = Math.max(3, Math.round(fs * 0.3)), pad = 14;
    const rows = this.rows().length;
    const cols = this.mode === "numeric" ? 3 : 10;
    const fitW = (W - pad - gap * (cols - 1)) / cols, fitH = (H - pad - gap * (rows - 1)) / rows;
    let u, kh;
    if (this.mode === "numeric") { u = Math.min(fitW, fs * 5.5); kh = Math.min(fitH, fs * 3.2, u * 0.75); }
    else { u = Math.min(fitW, fs * 3.6); kh = Math.min(fitH, fs * 3, u * 1.25); }
    const s = this.root.style;
    s.setProperty("--vk-u", `${Math.floor(u)}px`);
    s.setProperty("--vk-kh", `${Math.floor(kh)}px`);
    s.setProperty("--vk-gap", `${gap}px`);
    const root = document.documentElement.style;
    root.setProperty("--kb-w", land ? `${Math.round(W)}px` : "0px");
    root.setProperty("--kb-h", land ? "0px" : `${Math.round(H)}px`);
  }
  hide() {
    clearInterval(this.watch);
    this.root.classList.add("hidden");
    const root = document.documentElement.style;
    root.setProperty("--kb-h", "0px");
    root.setProperty("--kb-w", "0px");
    document.body.classList.remove("kb-open");
    this.target = null;
  }
  /** fire "change" for programmatic edits (the browser only does that for real typing) */
  commit() {
    const t = this.target;
    if (t && t.value !== this.startValue) { this.startValue = t.value; t.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  close() { const t = this.target; this.commit(); this.hide(); if (t) t.blur(); }

  // ------------------------------------------------------------ editing at the caret
  insert(text) {
    const t = this.target;
    if (!t) return;
    const max = t.maxLength > 0 ? t.maxLength : Infinity;
    let s = t.selectionStart, e = t.selectionEnd;
    if (s === null || s === undefined) { s = e = t.value.length; }
    if (t.value.length - (e - s) + text.length > max) return;
    t.setRangeText(text, s, e, "end");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }
  backspace() {
    const t = this.target;
    if (!t) return;
    let s = t.selectionStart, e = t.selectionEnd;
    if (s === null || s === undefined) { s = e = t.value.length; }
    if (s === e) { if (s === 0) return; s -= 1; }
    t.setRangeText("", s, e, "end");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }
  /** ± : add or remove the minus sign in front of the number, keeping the caret where it was */
  toggleSign() {
    const t = this.target;
    if (!t) return;
    const neg = t.value.startsWith("-");
    const caret = t.selectionEnd ?? t.value.length;
    t.value = neg ? t.value.slice(1) : `-${t.value}`;
    const p = Math.max(0, caret + (neg ? -1 : 1));
    try { t.setSelectionRange(p, p); } catch (e) { /* not supported */ }
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }
  enter() {
    const t = this.target;
    if (!t) return;
    this.commit();
    const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    t.dispatchEvent(ev);
    // the console sends a command and stays ready for the next; every other field is done, unless the
    // handler rejected the value (preventDefault) and wants it corrected
    if (t.dataset.kb !== "gcode" && this.target === t && !ev.defaultPrevented) this.close();
  }

  // ------------------------------------------------------------ layouts: rows of [key, width in key units]
  rows() {
    const k1 = (keys) => keys.map((k) => [k, 1]);
    if (this.mode === "numeric") {
      const t = this.target;
      const action = [];
      if (t && t.dataset.neg) action.push(["NEG", 1]);
      if (t && t.dataset.kb === "numeric-list") action.push([",", 1]);
      action.push(["ENTER", 3 - action.length]);
      return [k1(["1", "2", "3"]), k1(["4", "5", "6"]), k1(["7", "8", "9"]), k1([".", "0", "BS"]), action];
    }
    const bottom = [[this.layer === "letters" ? "SYM" : "ABC", 1.5], [",", 1], ["SPACE", 4], [".", 1], ["ENTER", 2.5]];
    const history = this.target && this.target.dataset.kb === "gcode" ? [[["UP", 5], ["DOWN", 5]]] : [];
    if (this.layer === "symbols") {
      return [
        k1(VK_DIGITS),
        k1(["-", "_", "=", "+", "/", "\\", ":", ";", "(", ")"]),
        k1(["@", "#", "$", "%", "&", "*", "!", "?", "\"", "'"]),
        [...k1(["[", "]", "{", "}", "<", ">", "|", "~"]), ["BS", 1.5]],
        bottom,
        ...history,
      ];
    }
    const up = this.shift || this.caps;
    const L = (s) => k1(s.split("").map((c) => (up ? c.toUpperCase() : c)));
    const rows = [k1(VK_DIGITS), L("qwertyuiop"), L("asdfghjkl"), [["SHIFT", 1.5], ...L("zxcvbnm"), ["BS", 1.5]], bottom];
    return [...rows, ...history]; // console: ▲ ▼ step through earlier commands
  }
  label(k) {
    return {
      BS: "⌫", ENTER: this.target && this.target.dataset.kb === "gcode" ? "Send" : "Done", SPACE: "space",
      SHIFT: this.caps ? "⇪" : "⇧", SYM: "#+=", ABC: "ABC", NEG: "±", UP: "▲  previous", DOWN: "▼  next",
    }[k] ?? k;
  }
  press(k) {
    switch (k) {
      case "BS": this.backspace(); return;
      case "ENTER": this.enter(); return;
      case "NEG": this.toggleSign(); return;
      case "UP": case "DOWN": {
        const t = this.target;
        if (t) t.dispatchEvent(new KeyboardEvent("keydown", { key: k === "UP" ? "ArrowUp" : "ArrowDown", bubbles: true, cancelable: true }));
        return;
      }
      case "SPACE": this.insert(" "); break;
      case "SHIFT":
        // tap: next letter upper case; tap again: caps lock; again: off
        if (this.caps) { this.caps = false; this.shift = false; }
        else if (this.shift) { this.caps = true; this.shift = false; }
        else this.shift = true;
        this.render(); return;
      case "SYM": this.layer = "symbols"; this.render(); this.fit(); return;
      case "ABC": this.layer = "letters"; this.render(); this.fit(); return;
      default:
        this.insert(k);
        if (this.shift) { this.shift = false; this.render(); } // one-shot shift
    }
  }
  render() {
    this.root.innerHTML = "";
    this.root.classList.toggle("numeric", this.mode === "numeric");
    for (const row of this.rows()) {
      const r = el("div", { class: "vk-row" });
      for (const [k, u] of row) {
        const cls = ["vk-key"];
        if (["SHIFT", "BS", "SYM", "ABC", "NEG", "UP", "DOWN"].includes(k)) cls.push("vk-mod");
        if (k === "SHIFT" && (this.shift || this.caps)) cls.push("on");
        if (k === "SPACE") cls.push("vk-space");
        if (k === "ENTER") cls.push("vk-enter");
        const key = el("button", { class: cls.join(" "), "data-key": k }, this.label(k));
        key.style.setProperty("--u", String(u));
        // act on pointerdown for responsiveness; backspace repeats while held
        key.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          key.classList.add("down");
          this.press(k);
          if (k === "BS") {
            clearTimeout(this.rep); clearInterval(this.repI);
            this.rep = setTimeout(() => { this.repI = setInterval(() => this.backspace(), 60); }, 400);
          }
        });
        const up = () => { key.classList.remove("down"); clearTimeout(this.rep); clearInterval(this.repI); };
        key.addEventListener("pointerup", up);
        key.addEventListener("pointerleave", up);
        key.addEventListener("pointercancel", up);
        r.append(key);
      }
      this.root.append(r);
    }
  }
}

// ---------------------------------------------------------------- Input: the app's entry point for typing
const NON_TEXT_INPUTS = ["range", "checkbox", "radio", "button", "submit", "reset", "hidden", "color", "file", "image"];

const Input = {
  /** Mark a field as in-app keyboard only. inputmode="none" stops the WebView raising Android's keyboard
      while the field still takes focus, a caret and selection. data-kb picks the layout. */
  prepare(e, attrs = {}) {
    if (e.tagName === "INPUT" && NON_TEXT_INPUTS.includes(e.type)) return;
    if (!e.dataset.kb) {
      const im = attrs.inputmode || e.getAttribute("inputmode");
      e.dataset.kb = im === "none" ? "none" : im === "decimal" || im === "numeric" || e.type === "number" ? "numeric" : "text";
    }
    if (e.dataset.kb === "text-num") e.dataset.kb = "text"; // the QWERTY has a number row now
    if (e.type === "number") { e.type = "text"; e.dataset.kb = "numeric"; } // number inputs have no caret API
    e.setAttribute("inputmode", "none");
    e.setAttribute("autocomplete", "off");
    e.setAttribute("autocorrect", "off");
    e.setAttribute("autocapitalize", "off");
    e.setAttribute("spellcheck", "false");
  },

  /** Open the in-app keyboard on a field now (use instead of field.focus()). */
  open(field, selectAll) {
    if (!field) return;
    try { field.focus({ preventScroll: true }); } catch (e) { field.focus(); }
    if (window.screenApp && screenApp.vk) screenApp.vk.onFocus(field);
    if (selectAll) { try { field.setSelectionRange(0, field.value.length); } catch (e) { /* not supported */ } }
  },

  /**
   * Ask for text in a dialog with the in-app keyboard open.
   *   title, value, placeholder, desc   what is shown
   *   layout   "text" | "numeric" | "numeric-list" | "gcode"
   *   negative numeric layouts: show the ± key
   *   password hide what is typed
   *   validate(value) -> error text, or nothing when the value is fine; the dialog stays open on error
   *   onSubmit(value)  runs after OK / Enter with a valid value
   *   buttons  extra dialog buttons [{ name, style, cb }] shown between OK and Cancel
   * Returns a function that closes the dialog.
   */
  prompt(o) {
    const app = window.screenApp;
    const entry = el("input", {
      class: "entry input-entry", type: o.password ? "password" : "text", "data-kb": o.layout || "text",
      "data-neg": o.negative ? "1" : null, placeholder: o.placeholder || "", maxlength: o.maxLength ? String(o.maxLength) : null,
    });
    entry.value = o.value === undefined || o.value === null ? "" : String(o.value);
    const err = el("div", { class: "desc input-error" });
    const body = el("div", { class: "input-body" }, entry, o.desc ? el("div", { class: "desc" }, o.desc) : null, err);
    let close = () => {};
    const submit = () => {
      const v = entry.value;
      const problem = o.validate ? o.validate(v) : null;
      if (problem) {
        err.textContent = problem;
        entry.classList.add("invalid");
        setTimeout(() => Input.open(entry, true), 0);
        return false;
      }
      if (o.keepOpen) {
        // apply and stay: the field stays selected for the next value, and the keyboard stays up
        if (o.onSubmit) o.onSubmit(v);
        err.textContent = o.keepOpen === true ? "Set ✓" : o.keepOpen;
        err.classList.add("input-ok");
        setTimeout(() => Input.open(entry, true), 0);
        return false;
      }
      close();
      if (o.onSubmit) o.onSubmit(v);
      return true;
    };
    entry.addEventListener("input", () => { err.textContent = ""; err.classList.remove("input-ok"); entry.classList.remove("invalid"); });
    entry.addEventListener("keydown", (e) => { if (e.key === "Enter" && !submit()) e.preventDefault(); });
    close = app.dialog(o.title || "", [
      { name: o.ok || "OK", style: "dialog-default", handler: submit },
      ...(o.buttons || []),
      { name: o.keepOpen ? "Close" : "Cancel", style: "dialog-error", cb: o.onCancel },
    ], body);
    setTimeout(() => Input.open(entry, o.selectAll !== false), 30);
    return close;
  },

  /**
   * Ask for a number in a dialog with the in-app number keypad.
   *   title, value, unit, desc
   *   min, max   allowed range (either may be left out); ± is offered when negatives are allowed
   *   decimals   most decimal places allowed (0 = whole numbers; default any)
   *   onSubmit(number)
   */
  number(o) {
    const fmt = (n) => String(Math.round(n * 1000) / 1000);
    const range = [o.min !== undefined ? `min ${fmt(o.min)}` : null, o.max !== undefined ? `max ${fmt(o.max)}` : null].filter(Boolean).join(", ");
    const unit = o.unit ? ` ${o.unit}` : "";
    const desc = [o.desc, range ? `Range: ${range}${unit}` : null].filter(Boolean).join("\n");
    return Input.prompt({
      title: o.title, value: o.value, layout: "numeric", negative: o.min === undefined || o.min < 0,
      desc, ok: o.ok, buttons: o.buttons, onCancel: o.onCancel, keepOpen: o.keepOpen,
      validate: (s) => {
        const t = s.trim().replace(",", ".");
        if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return "Enter a number";
        const n = parseFloat(t);
        if (o.decimals === 0 && !Number.isInteger(n)) return "Whole numbers only";
        if (o.decimals && (t.split(".")[1] || "").length > o.decimals) return `At most ${o.decimals} decimal places`;
        if ((o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) return `Out of range (${range}${unit})`;
        return null;
      },
      onSubmit: (s) => o.onSubmit(parseFloat(s.trim().replace(",", "."))),
    });
  },
};
