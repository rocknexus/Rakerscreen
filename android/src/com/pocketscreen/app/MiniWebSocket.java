package com.pocketscreen.app;

import android.util.Base64;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/**
 * Minimal RFC 6455 WebSocket client (ws:// only, text frames) with no dependencies.
 *
 * Why native instead of the WebView's WebSocket: the UI is loaded from file:///android_asset, so a
 * browser WebSocket would send "Origin: null", which Moonraker rejects unless cors_domains is edited
 * in the Klip Pocket / Beam config. A native client sends no Origin header (Moonraker/Tornado then
 * skips the origin check) and can send X-Api-Key. The connection is a TCP socket to 127.0.0.1, so it
 * never leaves the phone.
 */
final class MiniWebSocket {
    interface Listener {
        void onOpen();
        void onMessage(String text);
        void onClose(int code, String reason);
        void onError(String error);
    }

    private final Listener listener;
    private final SecureRandom random = new SecureRandom();
    private final Object writeLock = new Object();
    private volatile Socket socket;
    private volatile OutputStream out;
    private volatile boolean closed;

    MiniWebSocket(Listener listener) { this.listener = listener; }

    void connect(final String url, final String apiKey) {
        Thread t = new Thread(() -> run(url, apiKey), "ps-websocket");
        t.setDaemon(true);
        t.start();
    }

    private void run(String url, String apiKey) {
        int code = 1006;
        String reason = "";
        try {
            URI uri = new URI(url);
            String host = uri.getHost();
            int port = uri.getPort() > 0 ? uri.getPort() : 80;
            String path = (uri.getRawPath() == null || uri.getRawPath().isEmpty()) ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();

            Socket s = new Socket();
            s.setTcpNoDelay(true);
            s.connect(new InetSocketAddress(host, port), 5000);
            // A server that accepts TCP but never answers the upgrade must not hang us forever
            // (auto-detect probes ports that may belong to other servers). Cleared after the handshake.
            s.setSoTimeout(5000);
            socket = s;
            if (closed) { s.close(); return; }
            out = s.getOutputStream();
            InputStream in = new BufferedInputStream(s.getInputStream());

            byte[] keyBytes = new byte[16];
            random.nextBytes(keyBytes);
            String key = Base64.encodeToString(keyBytes, Base64.NO_WRAP);
            StringBuilder req = new StringBuilder();
            req.append("GET ").append(path).append(" HTTP/1.1\r\n")
               .append("Host: ").append(host).append(':').append(port).append("\r\n")
               .append("Upgrade: websocket\r\n")
               .append("Connection: Upgrade\r\n")
               .append("Sec-WebSocket-Key: ").append(key).append("\r\n")
               .append("Sec-WebSocket-Version: 13\r\n")
               .append("User-Agent: PocketScreen\r\n");
            if (apiKey != null && !apiKey.isEmpty()) req.append("X-Api-Key: ").append(apiKey).append("\r\n");
            req.append("\r\n");
            synchronized (writeLock) { out.write(req.toString().getBytes(StandardCharsets.UTF_8)); out.flush(); }

            String status = readLine(in);
            if (status == null || !status.contains(" 101")) {
                throw new IOException("Handshake failed: " + status);
            }
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) { /* skip headers */ }
            s.setSoTimeout(0); // connected: Moonraker may stay quiet for long periods

            listener.onOpen();

            ByteArrayOutputStream message = new ByteArrayOutputStream();
            while (!closed) {
                int b0 = in.read();
                if (b0 < 0) break;
                int b1 = readByte(in);
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) len = ((long) readByte(in) << 8) | readByte(in);
                else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in); }
                byte[] mask = null;
                if (masked) { mask = new byte[4]; readFully(in, mask); }
                if (len > 64L * 1024 * 1024) throw new IOException("Frame too large");
                byte[] payload = new byte[(int) len];
                readFully(in, payload);
                if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

                if (opcode == 0x8) { // close
                    if (payload.length >= 2) {
                        code = ((payload[0] & 0xff) << 8) | (payload[1] & 0xff);
                        reason = new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8);
                    } else code = 1005;
                    sendFrame(0x8, new byte[0]);
                    break;
                } else if (opcode == 0x9) { // ping
                    sendFrame(0xA, payload);
                } else if (opcode == 0x1 || opcode == 0x0 || opcode == 0x2) {
                    message.write(payload);
                    if (fin) {
                        listener.onMessage(new String(message.toByteArray(), StandardCharsets.UTF_8));
                        message.reset();
                    }
                }
            }
        } catch (Exception e) {
            if (!closed) { reason = e.getMessage() == null ? e.toString() : e.getMessage(); listener.onError(reason); }
        } finally {
            closeSocket();
            if (!closed) listener.onClose(code, reason);
            closed = true;
        }
    }

    boolean send(String text) {
        try {
            sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (IOException e) {
            listener.onError(e.getMessage());
            closeSocket();
            return false;
        }
    }

    void close() {
        if (closed) return;
        closed = true;
        try { sendFrame(0x8, new byte[] {0x03, (byte) 0xE8}); } catch (Exception ignored) { }
        closeSocket();
    }

    private void sendFrame(int opcode, byte[] payload) throws IOException {
        OutputStream o = out;
        if (o == null) throw new IOException("not connected");
        ByteArrayOutputStream f = new ByteArrayOutputStream(payload.length + 14);
        f.write(0x80 | opcode);
        int len = payload.length;
        if (len < 126) f.write(0x80 | len);
        else if (len < 65536) { f.write(0x80 | 126); f.write((len >> 8) & 0xff); f.write(len & 0xff); }
        else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write((int) (((long) len >> (8 * i)) & 0xff)); }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        f.write(mask, 0, 4);
        byte[] masked = new byte[len];
        for (int i = 0; i < len; i++) masked[i] = (byte) (payload[i] ^ mask[i % 4]);
        f.write(masked, 0, len);
        synchronized (writeLock) { o.write(f.toByteArray()); o.flush(); }
    }

    private void closeSocket() {
        Socket s = socket;
        socket = null;
        out = null;
        if (s != null) try { s.close(); } catch (IOException ignored) { }
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new IOException("Connection closed");
        return b;
    }

    private static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new IOException("Connection closed");
            off += n;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        if (c < 0 && b.size() == 0) return null;
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
    }
}
