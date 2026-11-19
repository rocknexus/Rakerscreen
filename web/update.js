/* Rakerscreen self-update from GitHub releases.

   A release is a GitHub release in UPDATE_REPO whose tag is the version ("v0.2.8") with the APK
   attached. The app asks GitHub for the latest release (at startup, every 6 hours, or when asked),
   compares it with VERSION and offers the update. Installing downloads the APK natively and hands it
   to Android's package installer, which shows its own "Update this app?" screen; Android then closes
   Rakerscreen, replaces it and it is opened again. Klipper keeps running in Klip Pocket meanwhile.

   Updates only install over an APK signed with the same key (pocketscreen-debug.keystore). */
"use strict";

const UPDATE_REPO = "rocknexus/Rakerscreen";
const UPDATE_EVERY_MS = 6 * 3600 * 1000;

/** -1 / 0 / 1 comparing "0.2.10" style versions (a leading v is ignored) */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, "").split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

class Updater {
  constructor(app) {
    this.app = app;
    this.state = "idle";   // idle | checking | none | current | available | downloading | installing | error
    this.latest = null;    // { version, name, notes, url, size, page }
    this.error = null;
    this.lastCheck = 0;
    this.progress = null;
    this.listeners = new Set();
    window.__psupdate = {
      onCheck: (json) => this.onCheck(json),
      onError: (msg) => this.onError(msg),
      onProgress: (pct) => this.onProgress(Number(pct)),
      onStatus: (s) => this.onStatus(s),
    };
    setTimeout(() => this.auto(), 20000); // after the printer connection has settled
    setInterval(() => this.auto(), UPDATE_EVERY_MS);
  }
  native() { return !!(window.PSBridge && PSBridge.checkUpdate && PSBridge.installUpdate); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(); } catch (e) { /* panel gone */ } } }
  setState(s) { this.state = s; this.changed(); }
  busy() { return ["checking", "downloading", "installing"].includes(this.state); }

  auto() {
    if (!Settings.get("auto_update") || this.busy()) return;
    this.check(false);
  }
  check(manual) {
    if (this.busy()) return;
    this.manual = manual;
    this.error = null;
    this.setState("checking");
    if (this.native()) { PSBridge.checkUpdate(UPDATE_REPO); return; }
    // browser (development): GitHub's API allows cross-origin reads
    fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.status === 404 ? null : r.ok ? r.text() : Promise.reject(new Error(`GitHub answered HTTP ${r.status}`))))
      .then((t) => this.onCheck(t))
      .catch((e) => this.onError(e.message || String(e)));
  }
  onCheck(json) {
    this.lastCheck = Date.now();
    let rel = null;
    try { rel = json ? JSON.parse(json) : null; } catch (e) { this.onError("GitHub sent an unreadable answer"); return; }
    if (!rel || rel.draft || !rel.tag_name) {
      this.latest = null;
      this.setState("none");
      if (this.manual) this.app.popup("No releases published yet", 1);
      return;
    }
    const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    this.latest = {
      version: rel.tag_name.replace(/^v/i, ""), name: rel.name || rel.tag_name, notes: (rel.body || "").trim(),
      url: asset ? asset.browser_download_url : null, size: asset ? asset.size : 0, page: rel.html_url,
    };
    const newer = compareVersions(this.latest.version, VERSION) > 0;
    this.setState(newer ? "available" : "current");
    if (!newer) { if (this.manual) this.app.popup(`Rakerscreen ${VERSION} is up to date`, 1); return; }
    if (!this.latest.url) { if (this.manual) this.app.popup(`v${this.latest.version} has no APK attached yet`, 2); return; }
    // automatic checks never interrupt a print, and respect "Skip this version"
    let printing = false;
    try { printing = this.app.printer.isPrinting(); } catch (e) { /* not connected */ }
    if (this.manual) this.offer();
    else if (Settings.get("update_skip") !== this.latest.version && !printing) this.offerWhenFree();
  }
  /** Background offer: never replace a dialog, lock screen or keyboard the user is in; wait until they're gone. */
  offerWhenFree() {
    clearTimeout(this.offerTimer);
    const busy = document.querySelector("#dialog")?.classList.contains("show")
      || document.querySelector("#lock")?.classList.contains("show")
      || (this.app.vk && this.app.vk.visible());
    if (busy) { this.offerTimer = setTimeout(() => this.offerWhenFree(), 3000); return; }
    this.offer();
  }
  onError(msg) {
    const wasInstalling = ["downloading", "installing"].includes(this.state);
    this.error = msg;
    this.setState("error");
    if (this.progressClose) { this.progressClose(); this.progressClose = null; }
    // a failed background check stays quiet (often just no internet); anything the user started is reported
    if (this.manual || wasInstalling) this.app.popup(`Update: ${msg}`, 2);
  }

  offer() {
    clearTimeout(this.offerTimer);
    const l = this.latest;
    const notes = l.notes ? `\n\n${l.notes.length > 500 ? l.notes.slice(0, 500) + "…" : l.notes}` : "";
    const size = l.size ? `\n\nDownload: ${formatSize(l.size)}` : "";
    this.app.dialog(`Update available: v${l.version}`, [
      { name: "Update", style: "dialog-default", cb: () => this.install() },
      { name: "Later", style: "dialog-info" },
      { name: "Skip this version", style: "dialog-error", cb: () => { Settings.set("update_skip", l.version); this.app.popup(`v${l.version} skipped. Settings → Updates still installs it`, 1); } },
    ], `You have Rakerscreen ${VERSION}.${notes}${size}\n\nKlipper keeps running while Rakerscreen updates.`);
  }
  install() {
    const l = this.latest;
    if (!l || !l.url) { this.check(true); return; }
    if (!this.native()) { window.open(l.page, "_blank"); return; } // browser: show the release page
    this.manual = true;
    this.progressText = el("div", {}, `Downloading v${l.version}…`);
    this.progressClose = this.app.dialog("Updating Rakerscreen", [{ name: "Hide", style: "dialog-info" }], this.progressText,
      () => { this.progressClose = null; });
    this.setState("downloading");
    PSBridge.installUpdate(UPDATE_REPO, l.url);
  }
  say(text) { if (this.progressText) this.progressText.textContent = text; }
  onProgress(pct) {
    this.progress = pct;
    this.say(pct >= 0 ? `Downloading v${this.latest.version}… ${pct}%` : `Downloading v${this.latest.version}…`);
    this.changed();
  }
  onStatus(s) {
    if (s === "permission") {
      this.setState("available");
      if (this.progressClose) { this.progressClose(); this.progressClose = null; }
      this.app.dialog("Allow updates", [
        { name: "Update", style: "dialog-default", cb: () => this.install() },
        { name: "Cancel", style: "dialog-error" },
      ], "Android needs permission once.\n\nIn the screen that opened, turn on \"Allow from this source\" for Rakerscreen, come back, then tap Update.");
    } else if (s === "installing") {
      this.setState("installing");
      this.say("Installing…");
    } else if (s === "confirm") {
      this.setState("installing");
      this.say("Tap Update on Android's screen.\n\nRakerscreen then closes and is replaced. If it doesn't reopen by itself, open it again.");
    } else if (s === "installed") {
      this.setState("current");
      this.say("Updated.");
    }
  }

  /** one line for the Updates page */
  statusText() {
    const l = this.latest;
    switch (this.state) {
      case "checking": return "Checking GitHub…";
      case "none": return "No releases published yet";
      case "current": return `Up to date (latest: v${l ? l.version : VERSION})`;
      case "available": return `v${l.version} available${l.url ? "" : " (no APK attached yet)"}`;
      case "downloading": return `Downloading v${l.version}… ${this.progress >= 0 ? `${this.progress}%` : ""}`;
      case "installing": return "Installing…";
      case "error": return `Check failed: ${this.error}`;
      default: return "Not checked yet";
    }
  }
}
