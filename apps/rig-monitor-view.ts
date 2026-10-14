/**
 * P1-006 renderer only: pure terminal frame builder for the read-only CW monitor.
 *
 * No I/O, no hardware, no dependencies. The returned frame never exceeds
 * `rows - 1` lines and never renders more than `columns - 1` visible columns
 * per line (ANSI sequences are stripped when counting). Untrusted text
 * (errors, event/trace messages, port/mode) is stripped of terminal control
 * characters before it is interpolated.
 */

import type {
  ContextReadFieldView,
  ContextReadSessionView,
} from "../packages/devices/src/civ-context-session.js";

export interface MonitorEvent { time: number; message: string }

export interface MonitorSnapshot {
  frequencyHz: number;
  mode: string;
  filter: number;
  time: number;
}

export interface MonitorState {
  source: "simulation" | "serial";
  port: string;
  baud: number;
  status: "disconnected" | "connecting" | "ready" | "stale" | "reading" | "fault" | "closing";
  snapshot: MonitorSnapshot | undefined;
  error: string | undefined;
  events: MonitorEvent[];
  traces: MonitorEvent[];
  diagnostics: boolean;
  polling: boolean;
  intervalMs: number;
  /**
   * Optional P2-011 SIM context view. Absent keeps the historical frame output
   * unchanged; when present it is only a display hook, not evidence of a real
   * rig read. The session view is authoritative for freshness; the renderer
   * may dim/annotate but never upgrade a field to fresh.
   */
  context?: ContextReadSessionView;
}

interface Segment { text: string; code?: string }
type Line = Segment[];

const RESET = "\u001b[0m";
const BOLD = "1";
const DIM = "2";
const RED = "31";
const GREEN = "32";
const AMBER = "33";
const CYAN = "36";

const FOOTER_UNITS: readonly string[] = [
  "[C] Connect", "[D] Disconnect", "[R] Refresh",
  "[P] Poll", "[G] Diag", "[Q] Quit",
];

const MAX_SECTION_ITEMS = 50;
const clockFormatters = {
  beijing: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }),
  utc: new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }),
};

function clock(formatter: Intl.DateTimeFormat, timestamp: number): string {
  const parts = formatter.formatToParts(timestamp);
  const part = (name: string): string => parts.find((item) => item.type === name)?.value ?? "--";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function text(value: string, code?: string): Segment {
  return code === undefined ? { text: value } : { text: value, code };
}

function plain(value: string): Line {
  return [{ text: value }];
}

/** Remove ANSI/OSC escapes and non-printable bytes from untrusted text. */
function stripControl(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b./g, "")
    .replace(/[^\u0020-\u007e]/g, "?");
}

function widthOf(line: Line): number {
  let total = 0;
  for (const segment of line) total += segment.text.length;
  return total;
}

function clampLine(line: Line, limit: number): Line {
  if (limit <= 0) return [];
  const out: Line = [];
  let used = 0;
  for (const segment of line) {
    if (used >= limit) break;
    const room = limit - used;
    const value = segment.text.length <= room ? segment.text : segment.text.slice(0, room);
    if (value.length === 0) continue;
    out.push(segment.code === undefined ? { text: value } : { text: value, code: segment.code });
    used += value.length;
  }
  return out;
}

function renderLine(line: Line, color: boolean): string {
  let out = "";
  for (const segment of line) {
    if (color && segment.code !== undefined) out += `\u001b[${segment.code}m${segment.text}${RESET}`;
    else out += segment.text;
  }
  return out;
}

function statusCode(status: MonitorState["status"]): string {
  if (status === "ready") return GREEN;
  if (status === "fault") return RED;
  return AMBER;
}

function formatFrequency(hz: number): string {
  if (!Number.isFinite(hz) || hz < 0) return "---.---.---";
  return Math.round(hz).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const value = Math.max(0, ms);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${(value / 60_000).toFixed(1)}m`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}

function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "off";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Map a context view field to a short display value; unknown/absent is "--". */
function contextValue(field: ContextReadFieldView | undefined): string {
  if (field === undefined || field.reading === null) return "--";
  const reading = field.reading;
  switch (reading.kind) {
    case "txFrequency": return formatFrequency(reading.frequencyHz);
    case "txStatus": return reading.status;
    case "splitEnabled": return reading.enabled ? "ON" : "OFF";
    case "ritEnabled": return reading.enabled ? "ON" : "OFF";
    case "xitEnabled": return reading.enabled ? "ON" : "OFF";
    case "breakIn": return reading.mode;
    default: return "--";
  }
}

/** Fresh uses the decoded value; stale keeps it but marks STALE and dims. */
function contextSegment(field: ContextReadFieldView | undefined): Segment {
  if (field === undefined || field.reading === null) return text("--", DIM);
  const value = contextValue(field);
  if (field.quality === "fresh") return text(value, CYAN);
  return text(`${value} STALE`, DIM);
}

/** Two budget lines: TX FREQ + TX STATUS, then SPLIT/RIT/XIT/BK-IN. */
function contextLines(context: ContextReadSessionView): Line[] {
  const fields = context.fields;
  return [
    [
      text("SIM CONTEXT ", BOLD),
      text("TX FREQ ", DIM),
      contextSegment(fields.txFrequency),
      text("  TX STATUS ", DIM),
      contextSegment(fields.txStatus),
    ],
    [
      text("SPLIT ", DIM), contextSegment(fields.splitEnabled),
      text("  RIT ", DIM), contextSegment(fields.ritEnabled),
      text("  XIT ", DIM), contextSegment(fields.xitEnabled),
      text("  BK-IN ", DIM), contextSegment(fields.breakIn),
    ],
  ];
}

function wrapFixedUnits(units: readonly string[], limit: number): string[] {
  if (limit <= 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current.length === 0) { current = unit; continue; }
    if (current.length + 1 + unit.length <= limit) current += ` ${unit}`;
    else { lines.push(current); current = unit; }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function wrapText(value: string, limit: number): string[] {
  if (limit <= 0 || value.length === 0) return [];
  const words = value.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    let rest = word;
    if (current.length === 0) {
      while (rest.length > limit) { lines.push(rest.slice(0, limit)); rest = rest.slice(limit); }
      current = rest;
      continue;
    }
    if (current.length + 1 + rest.length <= limit) { current += ` ${rest}`; continue; }
    lines.push(current);
    while (rest.length > limit) { lines.push(rest.slice(0, limit)); rest = rest.slice(limit); }
    current = rest;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function pushSection(frame: Line[], label: string, items: readonly string[], budget: number): number {
  if (budget <= 0 || items.length === 0) return 0;
  const last = items[items.length - 1];
  if (last === undefined) return 0;
  if (budget === 1) { frame.push(plain(last)); return 1; }
  frame.push([text(label, BOLD)]);
  const take = items.slice(-(budget - 1));
  for (const item of take) frame.push(plain(item));
  return take.length + 1;
}

/**
 * Render one read-only monitor frame. Returns the frame text joined by "\n"
 * with no trailing newline; `color` controls ANSI output (default off).
 */
export function renderMonitor(state: MonitorState, columns: number, rows: number,
  now?: number, color?: boolean): string {
  const cols = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const rowCount = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  const limit = Math.max(0, cols - 1);
  const maxLines = Math.max(0, rowCount - 1);
  const useColor = color === true;
  if (limit === 0 || maxLines === 0) return "";

  // Too small for the workbench: emit the longest compact message that fits.
  if (cols < 24 || rowCount < 8) {
    const compact: Line[] = [
      [text("CW STATION", BOLD)],
      plain("terminal too small"),
      plain("need width >= 24"),
      plain("need height >= 8"),
    ];
    const out: string[] = [];
    for (const line of compact.slice(0, maxLines)) out.push(renderLine(clampLine(line, limit), useColor));
    return out.join("\n");
  }

  const timestamp = now !== undefined && Number.isFinite(now) ? now : Date.now();
  const snapshot = state.snapshot;
  const staleAfter = Math.max(3000, state.intervalMs * 3);
  const staleByStatus = state.status === "fault" || state.status === "disconnected"
    || state.status === "closing" || state.status === "connecting";
  const ageMs = snapshot === undefined ? 0 : Math.max(0, timestamp - snapshot.time);
  const stale = staleByStatus || (snapshot !== undefined && ageMs > staleAfter);
  const wide = limit >= 56;

  const sourceLabel = state.source === "simulation" ? "SIMULATION" : "SERIAL READ ONLY";
  const statusUpper = state.status.toUpperCase();
  const port = stripControl(state.port).trim();
  const portLabel = port.length > 0 ? port : "(none)";
  const baud = Number.isFinite(state.baud) ? String(Math.round(state.baud)) : "?";
  const frequency = snapshot === undefined ? "---.---.---" : formatFrequency(snapshot.frequencyHz);
  const mode = snapshot === undefined ? "---" : (stripControl(snapshot.mode).trim().slice(0, 12) || "---");
  const filter = snapshot === undefined ? "-" : String(snapshot.filter);
  const valueCode = stale ? DIM : CYAN;

  const frame: Line[] = [];
  const beijing = clock(clockFormatters.beijing, timestamp);
  const utc = clock(clockFormatters.utc, timestamp);

  // Brand heading: CW STATION + model, with the explicit source label on wide views.
  const brand: Line = [text("CW STATION", BOLD), text("  |  IC-7300")];
  if (wide) {
    const gap = limit - widthOf(brand) - sourceLabel.length;
    if (gap > 0) brand.push({ text: " ".repeat(gap) });
    if (gap >= 0) brand.push(text(sourceLabel));
  }
  frame.push(clampLine(brand, limit));
  if (wide) {
    frame.push(plain(`BEIJING ${beijing}   UTC ${utc}`));
  } else if (maxLines >= 10) {
    frame.push(plain(`BEIJING ${beijing.slice(5)}`));
    frame.push(plain(`UTC     ${utc.slice(5)}`));
  } else {
    frame.push(plain(`BJ ${beijing.slice(11)} UTC${utc.slice(11)}`));
  }

  // Status: never implies TX/power/authorization; ready only means last valid replies.
  const statusLine: Line = [text(`STATUS ${statusUpper}`, statusCode(state.status))];
  if (stale) statusLine.push(text("  STALE", DIM));
  if (wide) {
    statusLine.push(text(`   POLL ${state.polling ? "ON" : "OFF"} ${formatInterval(state.intervalMs)}`));
    statusLine.push(text(`   DIAG ${state.diagnostics ? "ON" : "OFF"}`));
  } else {
    frame.push(plain(sourceLabel));
    if (state.polling) statusLine.push(text("  POLL"));
  }
  frame.push(clampLine(statusLine, limit));

  // Frequency, mode and filter (prominent; dimmed when the snapshot is stale).
  if (wide) {
    frame.push(clampLine([
      text("FREQ "),
      text(`${frequency} Hz`, valueCode),
      text(`   MODE ${mode}   FIL${filter}`),
    ], limit));
  } else {
    frame.push(clampLine([
      text(`${frequency} Hz`, valueCode),
    ], limit));
    frame.push(plain(`MODE ${mode}  FIL${filter}`));
  }

  let footerLines = wrapFixedUnits(FOOTER_UNITS, limit);
  const topCount = frame.length;
  if (footerLines.length > maxLines - topCount) {
    footerLines = wrapFixedUnits(["[C] [D] [R] [P] [G] [Q]"], limit);
  }
  const footerTake = Math.min(footerLines.length, Math.max(0, maxLines - topCount));
  let remaining = maxLines - topCount - footerTake;

  // Snapshot provenance: port, baud and age (optional when height is short).
  if (remaining > 0) {
    const info: Line = [];
    if (wide) {
      info.push(text(`PORT ${portLabel}   BAUD ${baud}`));
      if (snapshot !== undefined) info.push(text(`   AGE ${formatAge(ageMs)}`));
    } else {
      if (snapshot !== undefined) info.push(text(`AGE ${formatAge(ageMs)}  `));
      info.push(text(`${portLabel}@${baud}`));
    }
    frame.push(clampLine(info, limit));
    remaining -= 1;
  }

  // Optional SIM context view (P2-011), after PORT and before ERROR: at most
  // two lines within the remaining budget. Absent context keeps old output.
  if (remaining > 0 && state.context !== undefined) {
    const take = contextLines(state.context).slice(0, Math.min(2, remaining));
    for (const line of take) frame.push(clampLine(line, limit));
    remaining -= take.length;
  }

  // Current error, wrapped to the visible width.
  const errorText = state.error === undefined ? "" : stripControl(state.error).trim();
  if (remaining > 0 && errorText.length > 0) {
    const wrapped = wrapText(`ERROR ${errorText}`, limit);
    const take = wrapped.slice(0, remaining);
    for (const line of take) frame.push(plain(line));
    remaining -= take.length;
  }

  // Recent events, bounded to a suffix.
  if (remaining > 0 && state.events.length > 0) {
    const items = state.events.slice(-MAX_SECTION_ITEMS).map((event) => {
      const age = formatAge(Math.max(0, timestamp - event.time)).padEnd(7);
      return `${age} ${stripControl(event.message)}`;
    });
    const budget = state.diagnostics && state.traces.length > 0 ? Math.min(4, Math.floor(remaining / 2)) : Math.min(8, remaining);
    remaining -= pushSection(frame, "EVENTS", items, budget);
  }

  // Optional raw trace suffix, only while diagnostics are enabled.
  if (remaining > 0 && state.diagnostics && state.traces.length > 0) {
    const items = state.traces.slice(-MAX_SECTION_ITEMS).map((trace) => {
      const age = formatAge(Math.max(0, timestamp - trace.time)).padEnd(7);
      return `${age} ${stripControl(trace.message)}`;
    });
    remaining -= pushSection(frame, "TRACE", items, remaining);
  }

  for (const footer of footerLines.slice(0, footerTake)) frame.push(plain(footer));

  const out: string[] = [];
  for (const line of frame.slice(0, maxLines)) out.push(renderLine(clampLine(line, limit), useColor));
  return out.join("\n");
}
