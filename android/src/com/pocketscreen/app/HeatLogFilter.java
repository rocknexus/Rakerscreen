package com.pocketscreen.app;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.util.ArrayDeque;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Cuts a klippy log (any size, read as a stream) down to what Heat Sync reads: "Start printer at" and
 *  "Log rollover at" lines, and the heater part of each "Stats" line
 *  ("Stats 1234.5: extruder: target=200 temp=187.3 pwm=1.000 heater_bed: target=60 temp=59.8 pwm=0.231").
 *  While every heater is off, one line every 30 s is kept, plus the first one (where a heat-up ends) and the
 *  last one (just before the next heat-up starts). At most cap characters are returned: the newest.
 *  Plain Java, no Android, so it can be checked on a desktop. */
final class HeatLogFilter {
    // one heater in a Stats line: "extruder: target=200 temp=187.3 pwm=1.000"
    static final Pattern HEATER_STAT = Pattern.compile("\\S+: target=(-?[\\d.]+) temp=-?[\\d.]+ pwm=[\\d.]+");

    private final ArrayDeque<String> keep = new ArrayDeque<>();
    private final long cap;
    private long size;

    private HeatLogFilter(long cap) { this.cap = cap; }

    private void emit(String s) {
        keep.addLast(s);
        size += s.length() + 1;
        while (size > cap && !keep.isEmpty()) size -= keep.removeFirst().length() + 1;
    }

    static String filter(Reader reader, long cap) throws IOException {
        HeatLogFilter f = new HeatLogFilter(cap);
        try (BufferedReader in = new BufferedReader(reader, 1 << 16)) {
            String line, idle = null;
            boolean wasActive = false;
            double idleKeptAt = -1e9;
            StringBuilder sb = new StringBuilder(160);
            while ((line = in.readLine()) != null) {
                if (line.startsWith("Stats ")) {
                    int colon = line.indexOf(':');
                    if (colon < 7) continue;
                    double t;
                    try { t = Double.parseDouble(line.substring(6, colon)); } catch (NumberFormatException e) { continue; }
                    Matcher m = HEATER_STAT.matcher(line);
                    sb.setLength(0);
                    boolean active = false;
                    while (m.find()) {
                        sb.append(' ').append(m.group());
                        try { if (Double.parseDouble(m.group(1)) != 0) active = true; } catch (NumberFormatException e) { active = true; }
                    }
                    if (sb.length() == 0) continue;
                    String out = line.substring(0, colon + 1) + sb;
                    if (!active) {
                        if (wasActive || t - idleKeptAt >= 30 || t < idleKeptAt) { f.emit(out); idleKeptAt = t; idle = null; }
                        else idle = out;
                    } else {
                        if (idle != null) { f.emit(idle); idle = null; }
                        f.emit(out);
                    }
                    wasActive = active;
                } else if (line.startsWith("Start printer at") || line.contains("Log rollover at")) {
                    if (idle != null) { f.emit(idle); idle = null; }
                    f.emit(line);
                    idleKeptAt = -1e9;
                    wasActive = false;
                }
            }
            if (idle != null) f.emit(idle);
        }
        StringBuilder all = new StringBuilder((int) Math.min(f.size + 16, Integer.MAX_VALUE - 16));
        for (String l : f.keep) all.append(l).append('\n');
        return all.toString();
    }

    /** Desktop check: java HeatLogFilter klippy.log [capBytes] prints the filtered text. */
    public static void main(String[] args) throws IOException {
        long cap = args.length > 1 ? Long.parseLong(args[1]) : 12L * 1024 * 1024;
        System.out.print(filter(new java.io.InputStreamReader(new java.io.FileInputStream(args[0]), "UTF-8"), cap));
    }
}
