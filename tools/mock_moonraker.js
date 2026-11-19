// Minimal Moonraker simulator for developing Rakerscreen without a printer.
// Serves ../web over HTTP and a JSON-RPC WebSocket at /websocket on the same port.
//   node tools/mock_moonraker.js [port] [--lan]   (default 7125; --lan: reachable from other devices)
// Adds a "Point" overlay (tools/annotate.js) for leaving notes on the screen; they land in tools/feedback/notes.json.
// No dependencies: implements just enough of RFC 6455 for text frames.
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || process.env.PORT || "7125", 10);
const WEB = path.join(__dirname, "..", "web");

// ------------------------------------------------------------------ simulated printer
const config = {
  printer: { kinematics: "cartesian", max_velocity: "300", max_accel: "3000", max_z_velocity: "15", square_corner_velocity: "5.0", minimum_cruise_ratio: "0.5" },
  extruder: { max_temp: "280", min_extrude_temp: "170", control: "pid", filament_diameter: "1.750" },
  heater_bed: { max_temp: "120", control: "pid" },
  stepper_z: { position_endstop: "0.5", endstop_pin: "probe:z_virtual_endstop" },
  probe: { z_offset: "1.850" },
  "temperature_sensor mcu": {},
  fan: {},
  "heater_fan hotend_fan": {},
  "fan_generic aux": {},
  "filament_switch_sensor runout": {},
  "neopixel chamber": { color_order: "GRBW", chain_count: "8" },
  "gcode_macro LOAD_FILAMENT": { gcode: "G1 E50 F{params.SPEED|default(300)}" },
  "gcode_macro UNLOAD_FILAMENT": { gcode: "G1 E-50 F{params.SPEED|default(300)}" },
  "gcode_macro PRINT_START": { description: "Start print", gcode: "M190 S{params.BED|default(60)}\nM109 S{params.EXTRUDER|default(200)}" },
  "gcode_macro CLEAN_NOZZLE": { gcode: "G28" },
  "gcode_macro _HIDDEN": { gcode: "M117" },
  bed_mesh: {}, virtual_sdcard: {}, pause_resume: {}, display_status: {}, exclude_object: {},
};
const objects = ["webhooks", "configfile", "gcode_move", "toolhead", "print_stats", "virtual_sdcard", "display_status", "pause_resume",
  "idle_timeout", "motion_report", "exclude_object", "manual_probe", "probe", "bed_mesh", "extruder", "heater_bed",
  "temperature_sensor mcu", "fan", "heater_fan hotend_fan", "fan_generic aux", "filament_switch_sensor runout", "neopixel chamber",
  "gcode_macro LOAD_FILAMENT", "gcode_macro UNLOAD_FILAMENT", "gcode_macro PRINT_START", "gcode_macro CLEAN_NOZZLE", "gcode_macro _HIDDEN"];
// extra macros so the macro grid can be exercised (count via MOCK_MACROS env, default 10)
const EXTRA_MACROS = ["PARK", "HEAT_SOAK", "BED_MESH_ADAPTIVE", "PURGE_LINE", "M600", "CHAMBER_LIGHTS_ON", "CHAMBER_LIGHTS_OFF",
  "TEST_SPEED", "PRINT_END", "CANCEL_PRINT_SAFE", "NOZZLE_WIPE", "FILAMENT_CHANGE_POSITION", "QUERY_SENSORS", "BEEP"]
  .slice(0, parseInt(process.env.MOCK_MACROS || "10", 10));
for (const m of EXTRA_MACROS) {
  config[`gcode_macro ${m}`] = m === "HEAT_SOAK"
    ? { description: "Wait for the chamber to warm up", gcode: "M190 S{params.BED|default(100)}\nG4 P{params.MINUTES|default(10)*60000}" }
    : { gcode: "M117 " + m };
  objects.push(`gcode_macro ${m}`);
}

const S = {
  webhooks: { state: "ready", state_message: "Printer is ready" },
  configfile: { config, warnings: [], save_config_pending: false },
  gcode_move: { extrude_factor: 1, speed_factor: 1, speed: 1500, homing_origin: [0, 0, 0, 0], gcode_position: [0, 0, 0, 0], absolute_coordinates: true },
  toolhead: { homed_axes: "", extruder: "extruder", max_accel: 3000, max_velocity: 300, square_corner_velocity: 5, minimum_cruise_ratio: 0.5, position: [0, 0, 0, 0], axis_minimum: [0, 0, -2, 0], axis_maximum: [235, 235, 250, 0], print_time: 0, estimated_print_time: 0 },
  print_stats: { state: "standby", filename: "", print_duration: 0, total_duration: 0, filament_used: 0, message: "", info: { total_layer: null, current_layer: null } },
  virtual_sdcard: { progress: 0, is_active: false, file_position: 0 },
  display_status: { progress: 0, message: null },
  pause_resume: { is_paused: false },
  idle_timeout: { state: "Idle" },
  motion_report: { live_position: [0, 0, 0, 0], live_velocity: 0, live_extruder_velocity: 0 },
  exclude_object: { objects: [], excluded_objects: [], current_object: null },
  manual_probe: { is_active: false, z_position: null, z_position_lower: null, z_position_upper: null },
  probe: { last_z_result: 0 },
  bed_mesh: { profile_name: "", mesh_min: [0, 0], mesh_max: [0, 0], probed_matrix: [[]], profiles: {} },
  extruder: { temperature: 24.3, target: 0, power: 0, pressure_advance: 0.04, smooth_time: 0.04 },
  heater_bed: { temperature: 23.8, target: 0, power: 0 },
  "temperature_sensor mcu": { temperature: 38.2 },
  fan: { speed: 0 },
  "heater_fan hotend_fan": { speed: 0 },
  "fan_generic aux": { speed: 0 },
  "filament_switch_sensor runout": { enabled: true, filament_detected: true },
  "neopixel chamber": { color_data: [[0, 0, 0, 0]] },
};

const files = [
  { filename: "benchy.gcode", size: 3456789, modified: Date.now() / 1000 - 3600, estimated_time: 5400, filament_total: 4200, object_height: 48 },
  { filename: "calibration_cube.gcode", size: 456789, modified: Date.now() / 1000 - 86400, estimated_time: 1500, filament_total: 1100, object_height: 20 },
  { filename: "parts/bracket.gcode", size: 1456789, modified: Date.now() / 1000 - 7200, estimated_time: 3600, filament_total: 3000, object_height: 12 },
];
const thumbSvg = (label) => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" fill="#222"/><path d="M60 230 L150 70 L240 230 Z" fill="#ED6500"/><text x="150" y="275" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
const meta = (f) => ({
  filename: f.filename, size: f.size, modified: f.modified, estimated_time: f.estimated_time, filament_total: f.filament_total, object_height: f.object_height,
  gcode_start_byte: 1000, gcode_end_byte: f.size - 1000, slicer: "PrusaSlicer",
  thumbnails: [{ width: 32, height: 32, size: 100, relative_path: `.thumbs/${path.basename(f.filename, ".gcode")}-32x32.png` },
    { width: 300, height: 300, size: 4000, relative_path: `.thumbs/${path.basename(f.filename, ".gcode")}-300x300.png` }],
});

const tempStore = { extruder: { temperatures: [], targets: [], powers: [] }, heater_bed: { temperatures: [], targets: [], powers: [] }, "temperature_sensor mcu": { temperatures: [] } };
const gcodeStore = [{ message: "Klipper state: Ready", time: Date.now() / 1000 - 60, type: "response" }];

// ------------------------------------------------------------------ gcode handling
const clients = new Set();
function broadcast(method, params) { const m = JSON.stringify({ jsonrpc: "2.0", method, params }); for (const c of clients) c.send(m); }
function respond(text) { gcodeStore.push({ message: text, time: Date.now() / 1000, type: "response" }); broadcast("notify_gcode_response", [text]); }
const pending = {};
function set(obj, vals) { Object.assign(S[obj], vals); pending[obj] = Object.assign(pending[obj] || {}, vals); }

// KEY=value, or a G-code word like X10 / S255; must not match a longer key (Z vs Z_ADJUST)
function arg(line, key) { const m = line.match(new RegExp(`(?:^|\\s)${key}(?:=|(?=[-+\\d.]))"?([^\\s"]+)"?`, "i")); return m ? m[1] : undefined; }
function runGcode(script) {
  gcodeStore.push({ message: script, time: Date.now() / 1000, type: "command" });
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    const cmd = line.split(/\s+/)[0].toUpperCase();
    if (S.webhooks.state !== "ready" && cmd !== "FIRMWARE_RESTART" && cmd !== "RESTART") throw new Error("Printer is not ready");
    switch (cmd) {
      case "M104": case "M109": { const t = parseFloat(arg(line, "S") || "0"); set("extruder", { target: t }); break; }
      case "M140": case "M190": set("heater_bed", { target: parseFloat(arg(line, "S") || "0") }); break;
      case "SET_HEATER_TEMPERATURE": { const h = arg(line, "HEATER"); const t = parseFloat(arg(line, "TARGET") || "0"); if (h === "extruder") set("extruder", { target: t }); else if (h === "heater_bed") set("heater_bed", { target: t }); break; }
      case "M106": set("fan", { speed: Math.min(1, parseFloat(arg(line, "S") || "255") / 255) }); break;
      case "M107": set("fan", { speed: 0 }); break;
      case "SET_FAN_SPEED": { const f = arg(line, "FAN"); if (S[`fan_generic ${f}`]) set(`fan_generic ${f}`, { speed: parseFloat(arg(line, "SPEED") || "0") }); break; }
      case "G28": { const axes = (line.slice(3).match(/[XYZ]/gi) || ["x", "y", "z"]).map((a) => a.toLowerCase()); const h = new Set(S.toolhead.homed_axes.split("").concat(axes)); const homed = ["x", "y", "z"].filter((a) => h.has(a)).join(""); const p = [...S.gcode_move.gcode_position]; axes.forEach((a) => (p["xyz".indexOf(a)] = 0)); set("toolhead", { homed_axes: homed }); set("gcode_move", { gcode_position: p }); set("motion_report", { live_position: p }); respond(`// homed ${axes.join("")}`); break; }
      case "G0": case "G1": {
        const p = [...S.gcode_move.gcode_position];
        for (const [i, a] of ["X", "Y", "Z", "E"].entries()) {
          const v = arg(line, a);
          if (v === undefined) continue;
          if (a !== "E" && !S.toolhead.homed_axes.includes(a.toLowerCase())) throw new Error("Must home axis first");
          const n = S.gcode_move.absolute_coordinates && a !== "E" ? parseFloat(v) : p[i] + parseFloat(v);
          if (a !== "E" && (n < S.toolhead.axis_minimum[i] || n > S.toolhead.axis_maximum[i])) throw new Error(`Move out of range: ${p.slice(0, 3).map((q, j) => (j === i ? n : q).toFixed(3)).join(" ")}`);
          p[i] = n;
        }
        set("gcode_move", { gcode_position: p }); set("motion_report", { live_position: p }); break;
      }
      case "M18": case "M84": set("toolhead", { homed_axes: "" }); break;
      case "M220": set("gcode_move", { speed_factor: parseFloat(arg(line, "S") || "100") / 100 }); break;
      case "M221": set("gcode_move", { extrude_factor: parseFloat(arg(line, "S") || "100") / 100 }); break;
      case "SET_GCODE_OFFSET": { const o = [...S.gcode_move.homing_origin]; const z = arg(line, "Z"), za = arg(line, "Z_ADJUST"); if (z !== undefined) o[2] = parseFloat(z); if (za !== undefined) o[2] = Math.round((o[2] + parseFloat(za)) * 1000) / 1000; set("gcode_move", { homing_origin: o }); respond(`// gcode offset Z=${o[2].toFixed(3)}`); break; }
      case "SET_VELOCITY_LIMIT": { const m = { VELOCITY: "max_velocity", ACCEL: "max_accel", SQUARE_CORNER_VELOCITY: "square_corner_velocity", MINIMUM_CRUISE_RATIO: "minimum_cruise_ratio" }; for (const [k, f] of Object.entries(m)) { const v = arg(line, k); if (v !== undefined) set("toolhead", { [f]: parseFloat(v) }); } break; }
      case "PROBE_CALIBRATE": case "Z_ENDSTOP_CALIBRATE": set("manual_probe", { is_active: true, z_position: 5 }); respond("// Starting manual Z probe. Use TESTZ to adjust position."); break;
      case "TESTZ": set("manual_probe", { z_position: Math.round((S.manual_probe.z_position + parseFloat(arg(line, "Z") || "0")) * 1000) / 1000 }); break;
      case "ACCEPT": case "ABORT": set("manual_probe", { is_active: false }); respond(cmd === "ACCEPT" ? `// probe: z_offset: ${S.manual_probe.z_position}` : "// Manual probe aborted"); break;
      case "SET_LED": {
        const name = arg(line, "LED");
        const obj = `neopixel ${name}`;
        if (!S[obj]) throw new Error(`Unknown LED '${name}'`);
        const c = ["RED", "GREEN", "BLUE", "WHITE"].map((k) => parseFloat(arg(line, k) || "0"));
        set(obj, { color_data: [c] });
        break;
      }
      case "SET_FILAMENT_SENSOR": set("filament_switch_sensor runout", { enabled: arg(line, "ENABLE") === "1" }); break;
      case "SAVE_CONFIG": respond("// Saving config (simulated)"); restart(); break;
      case "FIRMWARE_RESTART": case "RESTART": restart(); break;
      case "G90": set("gcode_move", { absolute_coordinates: true }); break;
      case "G91": set("gcode_move", { absolute_coordinates: false }); break;
      case "T0": case "M83": case "M82": case "M117": case "": break;
      case "STATUS": respond("// Klipper state: Ready"); break;
      default:
        if (cmd.startsWith("PID_CALIBRATE") || config[`gcode_macro ${cmd}`]) { respond(`// ran ${line}`); break; }
        respond(`!! Unknown command:"${cmd}"`);
        throw new Error(`Unknown command:"${cmd}"`);
    }
  }
  return "ok";
}

function restart() {
  set("webhooks", { state: "startup", state_message: "Klipper restarting" });
  broadcast("notify_klippy_disconnected", []);
  setTimeout(() => {
    set("webhooks", { state: "ready", state_message: "Printer is ready" });
    set("print_stats", { state: "standby" });
    broadcast("notify_klippy_ready", []);
  }, 2500);
}

let printTimer = null;
function startPrint(filename) {
  const f = files.find((x) => x.filename === filename);
  if (!f) throw new Error(`File ${filename} not found`);
  set("print_stats", { state: "printing", filename, print_duration: 0, total_duration: 0, filament_used: 0, info: { total_layer: Math.round(f.object_height / 0.2), current_layer: 0 } });
  set("pause_resume", { is_paused: false });
  set("virtual_sdcard", { progress: 0, is_active: true, file_position: 1000 });
  set("extruder", { target: 210 }); set("heater_bed", { target: 60 }); set("fan", { speed: 1 });
  set("toolhead", { homed_axes: "xyz" });
  set("exclude_object", { objects: [{ name: "PART_1" }, { name: "PART_2" }] });
  clearInterval(printTimer);
  printTimer = setInterval(() => {
    const ps = S.print_stats;
    if (ps.state !== "printing" && ps.state !== "paused") { clearInterval(printTimer); return; }
    set("print_stats", { total_duration: ps.total_duration + 1 });
    if (ps.state === "paused") return;
    const speed = 30 * S.gcode_move.speed_factor; // 30x real time
    const dur = ps.print_duration + speed;
    const prog = Math.min(1, dur / f.estimated_time);
    const z = Math.round(prog * f.object_height * 100) / 100;
    const x = 110 + 40 * Math.sin(dur / 7), y = 110 + 40 * Math.cos(dur / 5);
    set("print_stats", { print_duration: dur, filament_used: prog * f.filament_total, info: { total_layer: Math.round(f.object_height / 0.2), current_layer: Math.ceil(z / 0.2) } });
    set("virtual_sdcard", { progress: prog, file_position: 1000 + prog * (f.size - 2000) });
    set("display_status", { progress: prog });
    set("gcode_move", { gcode_position: [x, y, z, prog * f.filament_total], speed: 6000 });
    set("motion_report", { live_position: [x, y, z, prog * f.filament_total], live_velocity: 120 + Math.random() * 30, live_extruder_velocity: 0.8 + Math.random() * 0.4 });
    if (prog >= 1) {
      set("print_stats", { state: "complete" }); set("virtual_sdcard", { is_active: false });
      set("extruder", { target: 0 }); set("heater_bed", { target: 0 }); set("fan", { speed: 0 });
      respond("// Done printing file");
      clearInterval(printTimer);
    }
  }, 1000);
}

// ------------------------------------------------------------------ physics tick
setInterval(() => {
  for (const h of ["extruder", "heater_bed"]) {
    const o = S[h], amb = 23.5, rate = h === "extruder" ? 0.08 : 0.03;
    let t = o.temperature;
    let power = 0;
    if (o.target > 0) { power = Math.max(0, Math.min(1, (o.target - t) / 10)); t += (o.target - t) * rate + (Math.random() - 0.5) * 0.3; }
    else t += (amb - t) * 0.02;
    set(h, { temperature: Math.round(t * 100) / 100, power: Math.round(power * 100) / 100 });
  }
  set("temperature_sensor mcu", { temperature: Math.round((38 + Math.random()) * 10) / 10 });
  set("heater_fan hotend_fan", { speed: S.extruder.temperature > 50 ? 1 : 0 });
  if (Object.keys(pending).length) {
    const out = JSON.parse(JSON.stringify(pending));
    for (const k of Object.keys(pending)) delete pending[k];
    broadcast("notify_status_update", [out, Date.now() / 1000]);
  }
}, 250);
setInterval(() => {
  for (const [k, s] of Object.entries(tempStore)) {
    s.temperatures.push(S[k].temperature);
    if (s.targets) s.targets.push(S[k].target);
    if (s.powers) s.powers.push(S[k].power);
    for (const a of Object.values(s)) if (a.length > 1200) a.shift();
  }
}, 1000);

// ------------------------------------------------------------------ JSON-RPC
function pick(req) {
  const out = {};
  for (const [obj, fields] of Object.entries(req || {})) {
    if (!S[obj]) continue;
    out[obj] = fields && fields.length ? Object.fromEntries(fields.filter((f) => f in S[obj]).map((f) => [f, S[obj][f]])) : { ...S[obj] };
  }
  return JSON.parse(JSON.stringify(out));
}
const ready = () => S.webhooks.state === "ready";
const rpc = {
  "server.connection.identify": () => ({ connection_id: 1 }),
  "server.info": () => ({ klippy_connected: true, klippy_state: S.webhooks.state, components: ["webcam", "history"], failed_components: [], registered_directories: ["gcodes", "config"], warnings: [], websocket_count: clients.size, moonraker_version: "v0.9.3-mock", missing_klippy_requirements: [], api_version: [1, 5, 0], api_version_string: "1.5.0" }),
  "printer.info": () => ({ state: S.webhooks.state, state_message: S.webhooks.state_message, hostname: "klip-pocket", software_version: "v0.13.0-mock", cpu_info: "Android", klipper_path: "/data", python_path: "/data", log_file: "/data/klippy.log", config_file: "/data/printer.cfg" }),
  "printer.objects.list": () => ({ objects }),
  "printer.objects.query": (p) => ({ eventtime: Date.now() / 1000, status: pick(p.objects) }),
  "printer.objects.subscribe": (p) => ({ eventtime: Date.now() / 1000, status: pick(p.objects) }),
  "printer.gcode.help": () => ({ G28: "Home", PROBE_CALIBRATE: "Calibrate probe", Z_ENDSTOP_CALIBRATE: "Calibrate endstop", Z_OFFSET_APPLY_PROBE: "Apply", Z_OFFSET_APPLY_ENDSTOP: "Apply", SAVE_CONFIG: "Save", LOAD_FILAMENT: "Load", UNLOAD_FILAMENT: "Unload", PID_CALIBRATE: "PID" }),
  "printer.gcode.script": (p) => { if (!ready() && !/RESTART/i.test(p.script)) throw new Error("Klippy not ready"); return runGcode(p.script); },
  "printer.emergency_stop": () => { set("webhooks", { state: "shutdown", state_message: "Shutdown due to webhooks request" }); set("print_stats", { state: "error", message: "Emergency stop" }); clearInterval(printTimer); broadcast("notify_klippy_shutdown", []); return "ok"; },
  "printer.restart": () => { restart(); return "ok"; },
  "printer.firmware_restart": () => { restart(); return "ok"; },
  "printer.print.start": (p) => { startPrint(p.filename); return "ok"; },
  "printer.print.pause": () => { set("print_stats", { state: "paused" }); set("pause_resume", { is_paused: true }); respond("// action:paused"); return "ok"; },
  "printer.print.resume": () => { set("print_stats", { state: "printing" }); set("pause_resume", { is_paused: false }); respond("// action:resumed"); return "ok"; },
  "printer.print.cancel": () => { setTimeout(() => { set("print_stats", { state: "cancelled" }); set("virtual_sdcard", { is_active: false }); set("extruder", { target: 0 }); set("heater_bed", { target: 0 }); respond("// action:cancel"); }, 1500); return "ok"; },
  "server.temperature_store": () => JSON.parse(JSON.stringify(tempStore)),
  "server.gcode_store": (p) => ({ gcode_store: gcodeStore.slice(-(p.count || 100)) }),
  "server.webcams.list": () => ({ webcams: [] }),
  "server.files.get_directory": (p) => {
    const base = (p.path || "gcodes").replace(/^gcodes\/?/, "");
    const inDir = files.filter((f) => (base ? f.filename.startsWith(base + "/") : true));
    const dirs = new Set(), out = [];
    for (const f of inDir) {
      const rest = base ? f.filename.slice(base.length + 1) : f.filename;
      if (rest.includes("/")) dirs.add(rest.split("/")[0]);
      else out.push({ filename: rest, size: f.size, modified: f.modified, permissions: "rw", ...(p.extended ? meta(f) : {}), filename_full: f.filename });
    }
    out.forEach((o) => { o.filename = o.filename.split("/").pop(); });
    return { dirs: [...dirs].map((d) => ({ dirname: d, modified: Date.now() / 1000, size: 4096, permissions: "rw" })), files: out, disk_usage: { total: 64e9, used: 20e9, free: 44e9 }, root_info: { name: "gcodes", permissions: "rw" } };
  },
  "server.files.metadata": (p) => { const f = files.find((x) => x.filename === p.filename); if (!f) throw new Error("Metadata not available"); return meta(f); },
  "server.files.delete_file": (p) => { const fn = p.path.replace(/^gcodes\//, ""); const i = files.findIndex((f) => f.filename === fn); if (i >= 0) files.splice(i, 1); broadcast("notify_filelist_changed", [{ action: "delete_file", item: { path: fn, root: "gcodes" } }]); return { item: { path: fn, root: "gcodes" }, action: "delete_file" }; },
  "server.history.get_job": () => { throw new Error("not found"); },
  "machine.system_info": () => ({ system_info: { cpu_info: { cpu_count: 8, model: "Mock ARM", total_memory: 4000000 }, distribution: { name: "Android (mock)", version: "14" } } }),
  "server.restart": () => "ok",
};

// ------------------------------------------------------------------ WebSocket + HTTP
function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0), frag = [];
  const client = {
    send(text) {
      const data = Buffer.from(text);
      let hdr;
      if (data.length < 126) hdr = Buffer.from([0x81, data.length]);
      else if (data.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 126; hdr.writeUInt16BE(data.length, 2); }
      else { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(data.length), 2); }
      if (!socket.destroyed) socket.write(Buffer.concat([hdr, data]));
    },
  };
  clients.add(client);
  console.log(`[ws] client connected (${clients.size}) origin=${req.headers.origin || "-"}`);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mlen = masked ? 4 : 0;
      if (buf.length < off + mlen + len) return;
      const mask = masked ? buf.slice(off, off + 4) : null;
      const payload = Buffer.from(buf.slice(off + mlen, off + mlen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.slice(off + mlen + len);
      if (op === 0x8) { socket.end(); return; }
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0x1 || op === 0x0) { frag.push(payload); if (fin) { handle(client, Buffer.concat(frag).toString()); frag = []; } }
    }
  });
  const drop = () => { if (clients.delete(client)) console.log(`[ws] client disconnected (${clients.size})`); };
  socket.on("close", drop); socket.on("error", drop);
}
function handle(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  const fn = rpc[msg.method];
  let reply;
  if (!fn) reply = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  else {
    try { reply = { jsonrpc: "2.0", id: msg.id, result: fn(msg.params || {}) }; }
    catch (e) { reply = { jsonrpc: "2.0", id: msg.id, error: { code: 400, message: e.message } }; }
  }
  if (msg.method !== "printer.objects.query") console.log(`[rpc] ${msg.method} ${msg.params && msg.params.script ? JSON.stringify(msg.params.script) : ""}${reply.error ? " -> " + reply.error.message : ""}`);
  client.send(JSON.stringify(reply));
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
// ---- point-out notes (tools/annotate.js): stored in tools/feedback/notes.json, one array of notes
const NOTES = path.join(__dirname, "feedback", "notes.json");
const readNotes = () => { try { return JSON.parse(fs.readFileSync(NOTES, "utf8")); } catch (e) { return []; } };
const writeNotes = (list) => { fs.mkdirSync(path.dirname(NOTES), { recursive: true }); fs.writeFileSync(NOTES, JSON.stringify(list, null, 2)); };
function notesApi(req, res) {
  const send = (list) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(list)); };
  if (req.method === "GET") { send(readNotes()); return; }
  if (req.method === "DELETE") {
    const id = Number(new URL(req.url, "http://x").searchParams.get("id"));
    const list = readNotes().filter((n) => n.id !== id);
    writeNotes(list); console.log(`[note] #${id} deleted`); send(list); return;
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on("end", () => {
      let n; try { n = JSON.parse(body); } catch (e) { res.writeHead(400); res.end(); return; }
      const list = readNotes();
      n.id = list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
      n.time = new Date().toISOString();
      n.status = "open";
      list.push(n); writeNotes(list);
      console.log(`[note] #${n.id} ${n.panel}: ${n.what} -> ${JSON.stringify(n.text)}`);
      send(list);
    });
    return;
  }
  res.writeHead(405); res.end();
}

// ---- fake klippy.log / moonraker.log for the Logs panel
const STARTED = Date.now();
function fakeLog(kind) {
  const lines = [];
  const at = (s) => new Date(STARTED + s * 1000);
  if (kind === "klippy") {
    lines.push("Starting Klippy...", "Args: ['/home/pi/klipper/klippy/klippy.py', '/home/pi/printer_data/config/printer.cfg']", "Git version: 'v0.12.0-420-gmock'");
    lines.push("===== Config file =====", "[printer]", "kinematics = cartesian", "max_velocity = 300", "max_accel = 3000", "=======================");
    lines.push("Loaded MCU 'mcu' 112 commands (v0.12.0 / gcc: (15:10.3-2021.07-4) 10.3.1)", "MCU 'mcu' config: ADC_MAX=4095 BUS_PINS_i2c1=PB6,PB7 CLOCK_FREQ=72000000");
    for (let i = 0; i < 400; i++) lines.push(`Stats ${(i * 5.0).toFixed(1)}: gcodein=0  mcu: mcu_awake=0.003 mcu_task_avg=0.000010 bytes_write=${1200 + i * 31} bytes_read=${5400 + i * 87} freq=72000431 heater_bed: target=0 temp=23.8 pwm=0.000 sysload=0.12 cputime=${(i * 0.04).toFixed(3)} memavail=812344`);
    lines.splice(200, 0, "Unknown command:\"M105\"", "!! Must home axis first: 10.000 0.000 0.000 [0.000]", "Starting heater checks for extruder");
    lines.push("WARNING: Extruder below minimum temp", "webhooks client 2849712: New connection");
  } else {
    lines.push(`${at(0).toISOString()} [server.py:main()] Starting Moonraker on (0.0.0.0, 7125), Hostname: mock`, "[confighelper.py] Configuration loaded");
    for (let i = 0; i < 300; i++) lines.push(`${at(i * 7).toISOString().replace("T", " ").slice(0, 19)},${String(i % 1000).padStart(3, "0")} [websockets.py:open()] Websocket Opened: ID: ${1000 + i}, Proxied: False, User Agent: Rakerscreen`);
    lines.splice(120, 0, "[klippy_connection.py] WARNING: Klippy connection timed out, retrying", "[update_manager.py] ERROR: Unable to refresh: network unreachable");
  }
  return lines.join("\n") + "\n";
}

// ---- live reload: any change under web/ (or the overlay) bumps the version; open pages reload themselves
let webVersion = Date.now();
let bumpTimer = null;
const bump = () => { clearTimeout(bumpTimer); bumpTimer = setTimeout(() => { webVersion = Date.now(); console.log("[reload] web files changed"); }, 300); };
try { fs.watch(WEB, { recursive: true }, bump); } catch (e) { console.log("live reload off: " + e.message); }
try { fs.watch(path.join(__dirname, "annotate.js"), bump); } catch (e) { /* ignore */ }

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/__notes") { notesApi(req, res); return; }
  const logFile = url.match(/^\/server\/files\/logs\/(klippy|moonraker)\.log$/);
  if (logFile) {
    // made-up log text, with Range support like Moonraker's file handler
    const buf = Buffer.from(fakeLog(logFile[1]));
    const m = (req.headers.range || "").match(/^bytes=-(\d+)$/);
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range, X-Api-Key", "Content-Type": "text/plain; charset=utf-8" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (m && Number(m[1]) < buf.length) {
      const start = buf.length - Number(m[1]);
      res.writeHead(206, { ...cors, "Content-Range": `bytes ${start}-${buf.length - 1}/${buf.length}` });
      res.end(buf.subarray(start));
    } else { res.writeHead(200, cors); res.end(buf); }
    return;
  }
  if (url === "/__version") { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end(String(webVersion)); return; }
  if (url === "/__annotate.js") {
    fs.readFile(path.join(__dirname, "annotate.js"), (err, data) => { res.writeHead(err ? 404 : 200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); res.end(data || ""); });
    return;
  }
  const thumb = url.match(/^\/server\/files\/gcodes\/(?:.*\/)?\.thumbs\/(.+)-\d+x\d+\.png$/);
  if (thumb) { res.writeHead(200, { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" }); res.end(thumbSvg(thumb[1])); return; }
  const file = path.join(WEB, url === "/" ? "index.html" : url);
  if (!file.startsWith(WEB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    // the point-out overlay rides along with the page here only, never in the APK
    if (path.basename(file) === "index.html") data = Buffer.from(String(data).replace("</body>", '<script src="/__annotate.js"></script>\n</body>'));
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});
server.on("upgrade", (req, socket) => { if (req.url.startsWith("/websocket")) wsAccept(req, socket); else socket.destroy(); });
// --lan also listens on the network, so a phone on the same Wi-Fi can open it
const LAN = process.argv.includes("--lan");
server.listen(PORT, LAN ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Mock Moonraker on http://127.0.0.1:${PORT}  (UI at /, websocket at /websocket)`);
  if (LAN) for (const list of Object.values(require("os").networkInterfaces())) for (const a of list || []) {
    if (a.family === "IPv4" && !a.internal) console.log(`  on the network: http://${a.address}:${PORT}/`);
  }
});
