# P1-006 CLI terminal monitor delivery

Date: 2026-10-10. Scope: standalone read-only terminal UI, not daemon integration.

## Implementation

- `cwrig monitor --simulate` or explicit serial port/keying-off flags. Existing
  `simulate` and `read` retain JSON output; monitor requires interactive stdin/stdout.
- Single owned transport/session; frequency/mode reads do not overlap. Default
  read-completion interval1000ms, adjustable250..60000ms. Fault stops polling,
  preserves stale snapshot, and requires manual reconnect. Unknown close blocks
  reconnect; unknown cleanup during opening requires quitting/restarting.
- Frequency grouping, mode/filter, source/status, age/provenance, recent events,
  optional raw byte diagnostics. Stale is based on state or age greater than
  max(3000ms, 3*interval). No inferred TX/power/authorization fields.
- C connect, D disconnect, R refresh, P poll, G diagnostics, Q/Ctrl-C quit.
  Abort during opening/reading, bounded native cleanup, terminal cursor/raw mode and
  alternate screen restoration. SIGTERM and input EOF also request cleanup.
- ASCII English labels, color optional via NO_COLOR; responsive width/height,
  compact layout below24x8. Untrusted terminal metadata stripped of escape sequences.
- Native serial transport is unchanged from P1-005 and permits only03/04 requests.
  A separate UI owns the port; there is no shared daemon state service yet.

## Collaboration and review

DSH global headless executed renderer-only numbered task and exited0, handing back
`apps/rig-monitor-view.ts`. It did not build/test/access hardware. Codex reviewed
the pure renderer and corrected narrow status/frequency stacking, compact controls,
and diagnostic budget (original event section used all available rows). Codex owns
`apps/rig-monitor.ts`, CLI dispatch/args, documentation and final delivery.

## Build and startup

Actual commands, both exit0:

```bash
npm run build
'/mnt/d/Program Files/nodejs/node.exe' node_modules/typescript/bin/tsc -p tsconfig.json
```

No tests were added or run in this turn; no real-device monitor was run. Previous
P1-005 test results do not constitute monitor runtime acceptance.

Windows simulated terminal was launched for the user using Start-Process cmd.exe
with `examples/rig/monitor-demo.cmd`; startup request succeeded (PID51308).
This is a user-facing offline launch, not a real-device test. No visual screenshot
or automated interaction acceptance was performed. Quit withQ orCtrl-C.

Final built artifact SHA-256:

```text
864b13f9443a9bd6e1bdd0a680c00cc67ae37b7b14a9ce9a0c53e571e02ad2c9 dist/apps/cwrig.js
c018d6f24e3b3239cf20b9e7e0b7b4c09874001ac47377b207c932c755730a6b dist/apps/rig-monitor.js
e793ba5db67fd6836940ab8701d05950596e94f58daf55d7b3f06f7e9973956c dist/apps/rig-monitor-view.js
```

## Protection

No Git. Before edits/build cp -a preserved apps/docs/examples/MEMORY/AGENTS/tsconfig/
dist at `/mnt/d/AI/project-backups/cwstation/20261010-005731-terminal-monitor/`.
Changed existing files: apps/cwrig.ts, examples/rig/README.md, MEMORY.md.
Added files: apps/rig-monitor.ts, apps/rig-monitor-view.ts, examples/rig/monitor-demo.cmd,
this evidence and task. Compared with backup; no device/core/daemon/dependency
or existing test edits. dist contains delivery build outputs with its prior baseline
in the backup. Real serial is used only when the user selects the explicit command.

## Display correction: 2026-10-10

User observed green/amber alternation and requested Beijing/UTC clocks.
Codex directly corrected this small display-only change: preserveREADY during
routine reads, use changed-line rendering instead of clearing every250ms, and
add Intl clocks fixed toAsia/Shanghai andUTC. Wide displays show full dates;
narrow displays shorten the clock labels/date presentation. Initial startup
still clears the alternate screen once. Device transport/query behavior unchanged.

Before edits/build cp -a protected apps/dist/MEMORY/rig README/this evidence in
`/mnt/d/AI/project-backups/cwstation/20261010-010716-monitor-clock/`.
Source diffs checked against baseline. Linux and native Windows build only;
no tests or real-device verification requested/run. Existing processes need
restart to load the changed compiled files; the offline demo launch is renewed.
The artifact hashes above belong to the original delivery, not this update.

## Reconnect polling correction: 2026-10-11

User confirmed manual frequency/mode tracking and Q/restart passed. USB reconnect
with C opened successfully but stayed POLL OFF: readings became STALE and only R
updated them. Source cause: fault() sets polling=false, connect() never reset it.
Corrected new explicit sessions to restore polling=true before the initial read;
failed reads still call fault and disable it. No automatic reconnect or device
write changes. P pauses the current session; a new explicit connection polls again.

Before edits/build cp -a backup:
`/mnt/d/AI/project-backups/cwstation/20261011-003027-reconnect-poll/`.
Targets: apps/rig-monitor.ts, MEMORY, rig README and this evidence; dist rebuilt.
Source diff checked. `npm run build` and Windows native Node running
`node_modules/typescript/bin/tsc -p tsconfig.json` both exited0.
No tests or live USB manipulation run by Codex for this correction. Updated runtime
requires Q and bash rig.sh restart; live acceptance of the fix remains pending.
