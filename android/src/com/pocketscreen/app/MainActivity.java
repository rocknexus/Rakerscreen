package com.pocketscreen.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.database.Cursor;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileOutputStream;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.graphics.Color;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Pattern;

/**
 * Full-screen kiosk WebView hosting the Rakerscreen UI (assets/web) plus a JS bridge
 * ("PSBridge") that provides a native WebSocket to Moonraker on 127.0.0.1.
 */
public class MainActivity extends Activity {
    private WebView web;
    private MiniWebSocket ws;
    private int generation = 0;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(orientationFor(
                getSharedPreferences("pocketscreen", MODE_PRIVATE).getString("orientation", "auto")));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        // The UI has its own on-screen keyboard; never let Android raise the system one by itself.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        web = new KioskWebView(this);
        web.setBackgroundColor(Color.rgb(0x13, 0x18, 0x1C));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // localStorage for settings
        s.setAllowFileAccess(true);             // load file:///android_asset
        s.setTextZoom(100);                     // ignore system font scaling; layout scales itself
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "PSBridge");
        setContentView(web);
        web.loadUrl("file:///android_asset/web/index.html");
        hideSystemUi();
        registerInstallReceiver();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // Hardware/gesture back behaves like KlipperScreen's back button.
            web.evaluateJavascript("window.screenApp && screenApp.back()", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        synchronized (this) { if (ws != null) ws.close(); ws = null; }
        if (installReceiver != null) { try { unregisterReceiver(installReceiver); } catch (Exception ignored) { } }
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /**
     * All typing goes through the UI's own keyboard (web/keyboard.js), which edits fields from JavaScript.
     * This WebView offers Android no text input connection and says it is not a text editor, so the
     * system keyboard has nothing to attach to and never opens, whatever a page does.
     */
    static final class KioskWebView extends WebView {
        KioskWebView(Context c) { super(c); }
        @Override public InputConnection onCreateInputConnection(EditorInfo outAttrs) { return null; }
        @Override public boolean onCheckIsTextEditor() { return false; }
    }

    static int orientationFor(String mode) {
        if (mode == null) return ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        switch (mode) {
            case "sensor": return ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR;
            case "landscape": return ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
            case "landscape_fixed": return ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
            case "landscape_reverse": return ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
            case "portrait": return ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
            case "portrait_fixed": return ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            case "portrait_reverse": return ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT;
            default: return ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED; // "auto": follow the system
        }
    }

    // ------------------------------------------------------------ self-update (GitHub releases)
    static final String ACTION_INSTALL_STATUS = "com.pocketscreen.app.INSTALL_STATUS";
    static final Pattern REPO = Pattern.compile("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$");
    static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.-]{1,253}$|^\\[[0-9A-Fa-f:]+\\]$");
    // any file name in Moonraker's logs folder, rotated ones too (klippy.log.2026-11-18, moonraker.log.1, crowsnest.log)
    static final Pattern LOGNAME = Pattern.compile("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$");
    static final Pattern CFGNAME =Pattern.compile("^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\\.cfg$");
    private BroadcastReceiver installReceiver;

    interface Progress { void at(long done); }

    static void copy(InputStream in, OutputStream out, long total, Progress progress) throws IOException {
        byte[] b = new byte[64 * 1024];
        long done = 0, lastPct = -1;
        int n;
        while ((n = in.read(b)) > 0) {
            out.write(b, 0, n);
            done += n;
            if (progress != null) {
                long pct = total > 0 ? done * 100 / total : done / (256 * 1024);
                if (pct != lastPct) { lastPct = pct; progress.at(done); }
            }
        }
    }

    static String describe(Exception e) {
        String m = e.getMessage();
        if (e instanceof java.net.UnknownHostException) return "No internet connection (" + m + ")";
        if (e instanceof java.net.SocketTimeoutException) return "GitHub did not answer in time";
        return m == null ? e.getClass().getSimpleName() : m;
    }

    void updateEvent(String fn, String arg) {
        js("window.__psupdate && __psupdate." + fn + "(" + JSONObject.quote(arg == null ? "" : arg) + ")");
    }

    @SuppressWarnings("deprecation")
    private void registerInstallReceiver() {
        installReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent intent) {
                int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT); // Android's "Update this app?" screen
                    if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(confirm); }
                    updateEvent("onStatus", "confirm");
                } else if (status == PackageInstaller.STATUS_SUCCESS) {
                    updateEvent("onStatus", "installed"); // normally never seen: Android restarts the app to update it
                } else {
                    String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                    if (status == PackageInstaller.STATUS_FAILURE_ABORTED) msg = "Update cancelled";
                    else if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE)
                        msg = "The update is signed with a different key than the installed app (" + msg + ")";
                    updateEvent("onError", msg == null ? "Install failed (status " + status + ")" : msg);
                }
            }
        };
        IntentFilter f = new IntentFilter(ACTION_INSTALL_STATUS);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(installReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(installReceiver, f);
    }

    private void js(final String script) {
        web.post(() -> web.evaluateJavascript(script, null));
    }

    // ------------------------------------------------------------ saving files to Downloads
    /** A file being written to Downloads/Rakerscreen. */
    static final class Saved { OutputStream out; String where; Uri uri; File file; }

    /** Android 10+: a new entry in the shared Downloads/Rakerscreen folder (MediaStore, no permission needed).
     *  Older Android: the app's own Downloads folder (Android/data/com.pocketscreen.app/files/Download/Rakerscreen). */
    Saved createDownload(String name) throws IOException {
        Saved s = new Saved();
        int dot = name.lastIndexOf('.');
        String mime = dot > 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase()) : null;
        // an unknown type, not text/plain: MediaStore would otherwise tack ".txt" onto names like klippy.log.2026-11-18
        if (mime == null) mime = "application/octet-stream";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Rakerscreen");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            s.uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (s.uri == null) throw new IOException("Couldn't create the file in Downloads");
            s.out = getContentResolver().openOutputStream(s.uri);
            if (s.out == null) throw new IOException("Couldn't open the file in Downloads");
            s.where = "Download/Rakerscreen/" + name;
        } else {
            File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Rakerscreen");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Couldn't create " + dir);
            s.file = new File(dir, name);
            s.out = new FileOutputStream(s.file);
            s.where = s.file.getAbsolutePath();
        }
        return s;
    }

    /** Close it; keep it (and report its real name: MediaStore adds " (1)" when the name is taken) or throw it away. */
    String finishDownload(Saved s, boolean keep) {
        try { if (s.out != null) s.out.close(); } catch (IOException ignored) { }
        if (s.uri != null) {
            if (!keep) { getContentResolver().delete(s.uri, null, null); return s.where; }
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContentResolver().update(s.uri, v, null, null);
            try (Cursor c = getContentResolver().query(s.uri, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) s.where = "Download/Rakerscreen/" + c.getString(0);
            } catch (Exception ignored) { }
        } else if (!keep && s.file != null) s.file.delete();
        return s.where;
    }

    void downloadEvent(int id, boolean ok, String msg, long bytes) {
        js("window.__psdl && __psdl(" + id + "," + (ok ? 1 : 0) + "," + JSONObject.quote(msg == null ? "" : msg) + "," + bytes + ")");
    }

    /** Methods callable from JavaScript as window.PSBridge.* */
    final class Bridge {
        @JavascriptInterface
        public void connect(String url, String apiKey) {
            final int gen;
            synchronized (MainActivity.this) {
                if (ws != null) ws.close();
                gen = ++generation;
                ws = new MiniWebSocket(new MiniWebSocket.Listener() {
                    private boolean current() { return gen == generation; }
                    @Override public void onOpen() { if (current()) js("window.__psws && __psws.onOpen()"); }
                    @Override public void onMessage(String text) {
                        if (current()) js("window.__psws && __psws.onMessage(" + JSONObject.quote(text) + ")");
                    }
                    @Override public void onClose(int code, String reason) {
                        if (current()) js("window.__psws && __psws.onClose(" + code + "," + JSONObject.quote(reason == null ? "" : reason) + ")");
                    }
                    @Override public void onError(String error) {
                        if (current()) js("window.__psws && __psws.onError(" + JSONObject.quote(error == null ? "" : error) + ")");
                    }
                });
                ws.connect(url, apiKey);
            }
        }

        @JavascriptInterface
        public void send(String text) {
            MiniWebSocket w;
            synchronized (MainActivity.this) { w = ws; }
            if (w != null) w.send(text);
        }

        @JavascriptInterface
        public void close() {
            synchronized (MainActivity.this) {
                generation++;
                if (ws != null) ws.close();
                ws = null;
            }
        }

        @JavascriptInterface
        public String battery() {
            try {
                Intent i = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                if (i == null) return "{\"percent\":-1}";
                int level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                int plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                int pct = (level < 0 || scale <= 0) ? -1 : Math.round(level * 100f / scale);
                return "{\"percent\":" + pct + ",\"plugged\":" + (plugged != 0) + "}";
            } catch (Exception e) {
                return "{\"percent\":-1}";
            }
        }

        /** Only what helps debugging: maker/model, Android version, app version. No IDs. */
        @JavascriptInterface
        public String deviceInfo() {
            try {
                JSONObject o = new JSONObject();
                o.put("manufacturer", Build.MANUFACTURER);
                o.put("model", Build.MODEL);
                o.put("release", Build.VERSION.RELEASE);
                o.put("sdk", Build.VERSION.SDK_INT);
                try { o.put("appVersion", getPackageManager().getPackageInfo(getPackageName(), 0).versionName); } catch (Exception ignored) { }
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        /** Opens the Android share sheet (email, Discord, Drive, clipboard apps...). */
        @JavascriptInterface
        public void shareText(final String subject, final String text) {
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                send.putExtra(Intent.EXTRA_SUBJECT, subject);
                send.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(send, subject));
            });
        }

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Rakerscreen report", text));
            });
        }

        /** DPMS stand-in: window backlight 0..1, or a negative value to return to the system level. */
        @JavascriptInterface
        public void setBrightness(final double value) {
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = value < 0
                        ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                        : (float) Math.max(0.0, Math.min(1.0, value));
                getWindow().setAttributes(lp);
            });
        }

        /** Forced screen orientation. Saved natively too, so the app opens in it before the UI loads. */
        @JavascriptInterface
        public void setOrientation(final String mode) {
            getSharedPreferences("pocketscreen", MODE_PRIVATE).edit().putString("orientation", mode).apply();
            runOnUiThread(() -> setRequestedOrientation(orientationFor(mode)));
        }

        /** The last tailBytes of a Moonraker log file (logs root only), to window.__pslog(id, httpCode, text).
         *  Done natively: a page loaded from file:// can't fetch from Moonraker (CORS), and this adds the API key. */
        @JavascriptInterface
        public void fetchLog(final int id, final String host, final int port, final String name, final String apiKey, final int tailBytes) {
            String bad = host == null || !HOST.matcher(host).matches() ? "host \"" + host + "\""
                    : port < 1 || port > 65535 ? "port " + port
                    : name == null || !LOGNAME.matcher(name).matches() ? "log name \"" + name + "\"" : null;
            if (bad != null) {
                js("window.__pslog && __pslog(" + id + ",0," + JSONObject.quote("Invalid log request: " + bad) + ")");
                return;
            }
            final int tail = Math.max(1024, Math.min(tailBytes, 2 * 1024 * 1024));
            new Thread(() -> {
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL("http://" + host + ":" + port + "/server/files/logs/" + name).openConnection();
                    c.setRequestProperty("Range", "bytes=-" + tail);
                    if (apiKey != null && !apiKey.isEmpty()) c.setRequestProperty("X-Api-Key", apiKey);
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(15000);
                    int code = c.getResponseCode();
                    if (code != 200 && code != 206) { js("window.__pslog && __pslog(" + id + "," + code + ",\"\")"); return; }
                    // keep only the tail even if the server ignored the Range header
                    byte[] ring = new byte[tail];
                    long total = 0;
                    try (InputStream in = c.getInputStream()) {
                        byte[] b = new byte[16384];
                        int n;
                        while ((n = in.read(b)) > 0) {
                            for (int i = 0; i < n; i++) ring[(int) ((total + i) % tail)] = b[i];
                            total += n;
                        }
                    }
                    int len = (int) Math.min(total, tail);
                    byte[] out = new byte[len];
                    long start = total - len;
                    for (int i = 0; i < len; i++) out[i] = ring[(int) ((start + i) % tail)];
                    js("window.__pslog && __pslog(" + id + "," + code + "," + JSONObject.quote(new String(out, "UTF-8")) + ")");
                } catch (Exception e) {
                    js("window.__pslog && __pslog(" + id + ",0," + JSONObject.quote(describe(e)) + ")");
                } finally { if (c != null) c.disconnect(); }
            }).start();
        }

        /** Heat Sync's view of a whole klippy log (current or rotated, any size): the file is streamed and only
         *  "Start printer at" / "Log rollover at" lines and the heater part of each "Stats" line are kept
         *  ("Stats 1234.5: extruder: target=200 temp=187.3 pwm=1.000 heater_bed: ..."), at most maxBytes of them
         *  (the newest). To window.__pslog(id, httpCode, text) like fetchLog. */
        @JavascriptInterface
        public void fetchLogHeat(final int id, final String host, final int port, final String name, final String apiKey, final int maxBytes) {
            String bad = host == null || !HOST.matcher(host).matches() ? "host \"" + host + "\""
                    : port < 1 || port > 65535 ? "port " + port
                    : name == null || !LOGNAME.matcher(name).matches() ? "log name \"" + name + "\"" : null;
            if (bad != null) {
                js("window.__pslog && __pslog(" + id + ",0," + JSONObject.quote("Invalid log request: " + bad) + ")");
                return;
            }
            final long cap = Math.max(64 * 1024, Math.min(maxBytes, 32 * 1024 * 1024));
            new Thread(() -> {
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL("http://" + host + ":" + port + "/server/files/logs/" + name).openConnection();
                    if (apiKey != null && !apiKey.isEmpty()) c.setRequestProperty("X-Api-Key", apiKey);
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(30000);
                    int code = c.getResponseCode();
                    if (code != 200) { js("window.__pslog && __pslog(" + id + "," + code + ",\"\")"); return; }
                    String all = HeatLogFilter.filter(new java.io.InputStreamReader(c.getInputStream(), "UTF-8"), cap);
                    js("window.__pslog && __pslog(" + id + "," + code + "," + JSONObject.quote(all) + ")");
                } catch (Exception e) {
                    js("window.__pslog && __pslog(" + id + ",0," + JSONObject.quote(e instanceof java.net.SocketTimeoutException ? "Moonraker stopped answering" : describe(e)) + ")");
                } finally { if (c != null) c.disconnect(); }
            }).start();
        }

        /** The whole log file `name` from Moonraker's logs folder, streamed into Downloads/Rakerscreen as `saveAs`.
         *  Reports to window.__psdl(id, ok, where-or-error, bytes). */
        @JavascriptInterface
        public void downloadLog(final int id, final String host, final int port, final String name, final String apiKey, final String saveAs) {
            String bad = host == null || !HOST.matcher(host).matches() ? "host \"" + host + "\""
                    : port < 1 || port > 65535 ? "port " + port
                    : name == null || !LOGNAME.matcher(name).matches() ? "log name \"" + name + "\""
                    : saveAs == null || !LOGNAME.matcher(saveAs).matches() ? "file name \"" + saveAs + "\"" : null;
            if (bad != null) { downloadEvent(id, false, "Invalid download: " + bad, 0); return; }
            new Thread(() -> {
                HttpURLConnection c = null;
                Saved s = null;
                try {
                    c = (HttpURLConnection) new URL("http://" + host + ":" + port + "/server/files/logs/" + name).openConnection();
                    if (apiKey != null && !apiKey.isEmpty()) c.setRequestProperty("X-Api-Key", apiKey);
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(30000);
                    int code = c.getResponseCode();
                    if (code != 200) { downloadEvent(id, false, "Moonraker answered HTTP " + code, 0); return; }
                    s = createDownload(saveAs);
                    long total = 0;
                    try (InputStream in = c.getInputStream()) {
                        byte[] b = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(b)) > 0) { s.out.write(b, 0, n); total += n; }
                    }
                    String where = finishDownload(s, true);
                    s = null;
                    downloadEvent(id, true, where, total);
                } catch (Exception e) {
                    if (s != null) finishDownload(s, false);
                    downloadEvent(id, false, e instanceof java.net.SocketTimeoutException ? "Moonraker stopped answering" : describe(e), 0);
                } finally { if (c != null) c.disconnect(); }
            }).start();
        }

        /** Text from the page (Rakerscreen's own log) saved as Downloads/Rakerscreen/`saveAs`; reports like downloadLog. */
        @JavascriptInterface
        public void saveText(final int id, final String saveAs, final String text) {
            if (saveAs == null || !LOGNAME.matcher(saveAs).matches()) { downloadEvent(id, false, "Invalid file name \"" + saveAs + "\"", 0); return; }
            new Thread(() -> {
                Saved s = null;
                try {
                    byte[] b = (text == null ? "" : text).getBytes("UTF-8");
                    s = createDownload(saveAs);
                    s.out.write(b);
                    String where = finishDownload(s, true);
                    s = null;
                    downloadEvent(id, true, where, b.length);
                } catch (Exception e) {
                    if (s != null) finishDownload(s, false);
                    downloadEvent(id, false, describe(e), 0);
                }
            }).start();
        }

        /** Read (upload == null) or write a file in Moonraker's config folder (next to printer.cfg),
         *  to window.__pscfg(id, httpCode, text). Only plain *.cfg names, at most 1 MB. */
        @JavascriptInterface
        public void configFile(final int id, final String host, final int port, final String name, final String apiKey, final String upload) {
            String bad = host == null || !HOST.matcher(host).matches() ? "host \"" + host + "\""
                    : port < 1 || port > 65535 ? "port " + port
                    : name == null || !CFGNAME.matcher(name).matches() ? "file name \"" + name + "\""
                    : upload != null && upload.length() > 1024 * 1024 ? "file too big" : null;
            if (bad != null) {
                js("window.__pscfg && __pscfg(" + id + ",0," + JSONObject.quote("Invalid config request: " + bad) + ")");
                return;
            }
            new Thread(() -> {
                HttpURLConnection c = null;
                try {
                    String base = "http://" + host + ":" + port;
                    c = (HttpURLConnection) new URL(upload == null ? base + "/server/files/config/" + name : base + "/server/files/upload").openConnection();
                    if (apiKey != null && !apiKey.isEmpty()) c.setRequestProperty("X-Api-Key", apiKey);
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(15000);
                    if (upload != null) {
                        String boundary = "----Rakerscreen" + System.nanoTime();
                        String crlf = "\r\n";
                        String head = "--" + boundary + crlf
                                + "Content-Disposition: form-data; name=\"root\"" + crlf + crlf + "config" + crlf
                                + "--" + boundary + crlf
                                + "Content-Disposition: form-data; name=\"file\"; filename=\"" + name + "\"" + crlf
                                + "Content-Type: text/plain" + crlf + crlf;
                        byte[] body = (head + upload + crlf + "--" + boundary + "--" + crlf).getBytes("UTF-8");
                        c.setDoOutput(true);
                        c.setRequestMethod("POST");
                        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                        c.setFixedLengthStreamingMode(body.length);
                        try (OutputStream out = c.getOutputStream()) { out.write(body); }
                    }
                    int code = c.getResponseCode();
                    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    if (in != null) try (InputStream s = in) {
                        byte[] b = new byte[16384];
                        int n;
                        while ((n = s.read(b)) > 0 && buf.size() < 2 * 1024 * 1024) buf.write(b, 0, n);
                    }
                    js("window.__pscfg && __pscfg(" + id + "," + code + "," + JSONObject.quote(buf.toString("UTF-8")) + ")");
                } catch (Exception e) {
                    js("window.__pscfg && __pscfg(" + id + ",0," + JSONObject.quote(describe(e)) + ")");
                } finally { if (c != null) c.disconnect(); }
            }).start();
        }

        /** Latest GitHub release of owner/repo, as GitHub's JSON, to window.__psupdate.onCheck (null: none yet). */
        @JavascriptInterface
        public void checkUpdate(final String repo) {
            if (repo == null || !REPO.matcher(repo).matches()) { updateEvent("onError", "Invalid repository name"); return; }
            new Thread(() -> {
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL("https://api.github.com/repos/" + repo + "/releases/latest").openConnection();
                    c.setRequestProperty("Accept", "application/vnd.github+json");
                    c.setRequestProperty("User-Agent", "Rakerscreen-updater");
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(15000);
                    int code = c.getResponseCode();
                    if (code == 404) { js("window.__psupdate && __psupdate.onCheck(null)"); return; }
                    if (code != 200) throw new IOException("GitHub answered HTTP " + code);
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    try (InputStream in = c.getInputStream()) { copy(in, buf, -1, null); }
                    js("window.__psupdate && __psupdate.onCheck(" + JSONObject.quote(buf.toString("UTF-8")) + ")");
                } catch (Exception e) {
                    updateEvent("onError", describe(e));
                } finally { if (c != null) c.disconnect(); }
            }).start();
        }

        /** Download a release APK of owner/repo and hand it to Android's package installer. */
        @JavascriptInterface
        public void installUpdate(final String repo, final String url) {
            if (repo == null || !REPO.matcher(repo).matches() || url == null
                    || !url.startsWith("https://github.com/" + repo + "/releases/download/") || !url.endsWith(".apk")) {
                updateEvent("onError", "Not a release download of " + repo);
                return;
            }
            if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
                // one-time Android permission: "Install unknown apps" for Rakerscreen
                runOnUiThread(() -> {
                    try {
                        startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getPackageName())));
                    } catch (Exception ignored) { }
                });
                updateEvent("onStatus", "permission");
                return;
            }
            new Thread(() -> {
                HttpURLConnection c = null;
                PackageInstaller.Session session = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection(); // follows GitHub's redirect to its file host
                    c.setRequestProperty("User-Agent", "Rakerscreen-updater");
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(30000);
                    if (c.getResponseCode() != 200) throw new IOException("Download failed: HTTP " + c.getResponseCode());
                    final long total = c.getContentLengthLong();
                    PackageInstaller pi = getPackageManager().getPackageInstaller();
                    PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    p.setAppPackageName(getPackageName());
                    // Android 12+: once Rakerscreen installed itself, later updates may go through without a prompt
                    if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                    int id = pi.createSession(p);
                    session = pi.openSession(id);
                    try (InputStream in = c.getInputStream(); OutputStream out = session.openWrite("base.apk", 0, total)) {
                        copy(in, out, total, (done) -> updateEvent("onProgress", String.valueOf(total > 0 ? Math.round(done * 100.0 / total) : -1)));
                        session.fsync(out);
                    }
                    updateEvent("onStatus", "installing");
                    Intent status = new Intent(ACTION_INSTALL_STATUS).setPackage(getPackageName());
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    session.commit(PendingIntent.getBroadcast(MainActivity.this, id, status, flags).getIntentSender());
                    session.close();
                    session = null;
                } catch (Exception e) {
                    if (session != null) session.abandon();
                    updateEvent("onError", describe(e));
                } finally { if (c != null) c.disconnect(); }
            }).start();
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(MainActivity.this::finishAndRemoveTask);
        }
    }
}
