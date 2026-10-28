# Harmony CW decode bridge (host-verifiable part)

This directory contains only the host-verifiable C++ decoder bridge for the
Harmony CW receive checker. It does not contain Harmony UI, N-API bindings,
`OH_AudioCapturer`, permission handling, or device code. Those remain Codex's
scope.

## Design review outcome

Short DSH review of the revised task card and first review:

- No real S0 or S1 blocker remains for the host C bridge. The revised design
  closes the former S1 items at design level: level-0-only output capture with a
  bounded UTF-8 buffer and one active decoder (F1), native callback confined to a
  bounded queue with a single decode worker (F2), strict input format gate (F3),
  stop -> drain queue -> 0.5 s zeros -> deinit/join/drain (F4), temporary
  reproducible PCM compared against the patched CLI (F5), and SHA-locked vendored
  sources (F6).
- Residual S2 items, not host-bridge blockers: Native API lifetime details,
  target-device 22050 Hz support, permission/background behavior, and the GPL
  corresponding-source plan for an actually distributed HAP.
- Do not read this as a claim that the Harmony application is implemented or that
  the phone/microphone path is verified. Only the host bridge is implemented and
  tested here.

## Interface for the Native worker

`decoder_core.h` declares `cwstation::CwDecoder`:

- `CwDecoder()` — creates the only active instance. If another instance is
  active, `valid()` is false and `error()` explains why. No exception is used for
  this rejection.
- `feed(const int16_t* samples, size_t sample_count)` — 22050 Hz, mono, S16LE
  samples. `sample_count` is samples, not bytes. Returns false after `finish()`,
  for an invalid instance, or for a null pointer with a non-zero count.
- `finish(bool synthesize_tail = true)` — feeds 11025 zero samples (0.5 s) and
  calls `demod_morse.deinit`; idempotent. Use `false` only when the caller's PCM
  already contains the EOF tail.
- `drain()` — returns and clears pending text. Safe to call while the worker
  appends; decoded state is untouched.
- `clear()` — clears pending text and the truncation counter only; it does not
  reset decoder timing, thresholds, or the sample stream.
- `truncated()` / `truncated_bytes()` — 64 KiB text cap; oldest complete UTF-8
  fragments are dropped first and counted.
- Destructor — deinitializes if needed and releases the single-instance slot.

The bridge owns the `_verbprintf` shim. It captures level 0 only and never writes
stdout. The level-1 `morse_deinit` statistics are therefore not mixed into the
displayed text.

## Build and host verification

The vendored source is under `../third_party/multimon-ng`; do not replace it with
the external tree. Build output stays in `native/build` (ignored).

```bash
cmake -S apps/harmony-cw/native -B apps/harmony-cw/native/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCW_MULTIMON_CLI=/home/li0214/DSH/tools/multimon-ng-v00-02/build/multimon-ng
cmake --build apps/harmony-cw/native/build --parallel 2
ctest --test-dir apps/harmony-cw/native/build --output-on-failure
```

The CTest target generates a temporary 22050 Hz mono S16LE `CQ TEST` vector by
reading the existing `dist/packages/signal` build (it never writes `dist`). It
compares the bridge's complete stdout bytes with the patched CLI for:

- a tail already present in the file, and no tail;
- bridge-synthesized 0.5 s tail;
- fixed short chunks, one-sample chunks, and deterministic random chunks;
- second-instance rejection, re-creation after destruction, clear-not-reset, and
  finish/feed state.

The harness prints only decoded bytes on stdout; diagnostics go to stderr.

## Native API lifetime suggestions for Codex

These are implementation recommendations, not changes to the task document:

1. Make `stop` the single owner of the release sequence: mark state stopping,
   stop/release `OH_AudioCapturer`, let the worker drain the queue, feed the
   bridge tail, join, then resolve. Make it idempotent and awaitable; a second
   `stop` must join the same promise/state, not start a second teardown.
2. Do not rely on the N-API finalizer as the primary cleanup path. Expose an
   explicit async `dispose`/`stop` from ArkTS on page hide and ability destroy.
   The finalizer should only detach/flag cleanup or release an already-joined
   state; it must not block on a worker join from the GC thread.
3. Keep the native handle in a `shared_ptr`-like owned state referenced by the
   async work and by the JS object. Clear the JS-held reference only after the
   worker has joined; this avoids use-after-free when ArkTS drops the object
   during a pending async call.
4. Use an atomic lifecycle state machine (`created -> starting -> running ->
   stopping -> stopped/failed`) and reject `start` from invalid states. Publish
   `failed` with a concrete reason; never display a failed release as stopped.
5. Keep the audio callback limited to copying bounded PCM and updating
   peak/RMS/overflow counters. Do not call N-API, allocate unbounded memory, or
   log from the callback. Poll `drain()` from ArkTS on a timer, not from the
   callback.
6. Read back the actual capturer sample rate, channels, sample format, and
   encoding before feeding the decoder. If 22050/mono/S16LE/RAW does not match,
   release and surface an error; do not silently resample or fall back to another
   source.
