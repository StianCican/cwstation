# P1-006 v1: CLI read-only monitor

User approved a terminal display following the proposed read-only station monitor.
Status: implemented. DSH renderer delivered and handed off; Codex reviewed, corrected
responsive/diagnostic layout and implemented session/input orchestration. Linux and
Windows native builds succeeded. No tests or real-device runs in this task.
No daemon/public device-contract changes. Existing simulate/read JSON preserved.
New monitor uses one owned serial session, periodic reads, manual reconnect, stale
snapshots, recent events and optional CI-V diagnostics. Real serial requires explicit
port and keying-off confirmation; simulate is a separate explicit option.

Protection: no Git; cp -a baseline apps/docs/examples/MEMORY/AGENTS/tsconfig/dist at
`/mnt/d/AI/project-backups/cwstation/20261010-005731-terminal-monitor/`.

## DSH delegation: renderer only

DSH exclusively owns NEW `apps/rig-monitor-view.ts`; Codex owns all other files.
Implement a pure render function, no I/O or hardware. Read only this task and tsconfig
as needed. No tests, npm install, build, real ports, credentials or other file writes.
Keep final response short and exit handing back this file. Minimize deliberation.

Export interfaces:

```ts
export interface MonitorEvent { time: number; message: string }
export interface MonitorSnapshot { frequencyHz: number; mode: string; filter: number; time: number }
export interface MonitorState {
  source: "simulation" | "serial";
  port: string;
  baud: number;
  status: "disconnected" | "connecting" | "ready" | "reading" | "fault" | "closing";
  snapshot: MonitorSnapshot | undefined;
  error: string | undefined;
  events: MonitorEvent[];
  traces: MonitorEvent[];
  diagnostics: boolean;
  polling: boolean;
  intervalMs: number;
}
export function renderMonitor(state: MonitorState, columns: number, rows: number,
  now?: number, color?: boolean): string;
```

ASCII English text; ASCII width-safe. Whole frame at most rows-1 lines, every visible
line at most columns-1 columns (strip ANSI when counting). No ANSI if color false.
Use restrained ANSI green/amber/red for status, cyan frequency, bold title. Render
unframed dense terminal workbench, heading CW STATION and IC-7300, explicit SIMULATION
or SERIAL READ ONLY label. Frequency e.g. 14.742.000 Hz prominent, mode USB, FIL2.
Wide view aligned columns, narrow view stacked. Responsive dimensions; short height
prioritize brand/status/frequency/controls. If width<24 or rows<8 show fitting compact
message instead. No fake TX/power/authorization indicators. Snapshot stale if status
fault/disconnected/closing/connecting or older than max(3000, intervalMs*3); mark STALE
and dim, keep values and age. Ready only means last valid replies. Show port/baud,
snapshot age, current error wrapped safely, recent events (bounded suffix), optional
raw trace suffix. Keys footer: [C] Connect [D] Disconnect [R] Refresh [P] Poll [G] Diag
[Q] Quit, wrapped in narrow views. Never interpolate untrusted text without stripping
terminal control chars; runtime trace/errors might contain ANSI. Export only requested
function/types; no dependencies. Task handoff goes to Codex for source review.

## Codex implementation

Own apps/rig-monitor.ts, apps/cwrig.ts, task/evidence/memory and rig README.
Use Node readline emitKeypressEvents + ANSI alternate screen; no new dependencies.
Reject non-TTY cleanly before opening ports. Single query at a time, poll without
overlap. Stop poll on fault, preserve stale last valid snapshot, no automatic
reconnect. Disconnect/quit abort opening/reads, await bounded native cleanup; retain
unknown-close ownership and block reconnect. Restore raw mode/cursor/screen/listeners
on exit. Implement strict CLI args. Build for delivery; no tests requested this turn.
