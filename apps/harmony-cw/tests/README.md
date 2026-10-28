# capture_session host tests

Host-only failure-injection tests for the real
`entry/src/main/cpp/capture_session.cpp`. They do not run HarmonyOS audio,
N-API, ArkTS, a HAP, or a phone.

## Scope

Compiled unchanged:

- `entry/src/main/cpp/capture_session.cpp`
- `native/decoder_core.cpp`
- `third_party/multimon-ng/demod_morse.c`

Replaced only at the OH_Audio boundary by `fake_audio.cpp`; the stub headers
under `include/ohaudio/` mirror the API 26 declarations used by the session.
The executable therefore exercises the same bounded queue, worker, real
`CwDecoder`, tail synthesis and cleanup code as the HAP.

Covered cases:

1. Actual format mismatch releases the capturer/builder and permits a later
   correctly-formatted start.
2. `OH_AudioCapturer_Start` failure releases resources and permits a retry.
3. Deterministic 22050 Hz/mono/S16LE `CQ TEST` PCM reaches the same decoder;
   stop drains it, synthesizes the 0.5 s tail and yields exactly `CQ TEST \n`.
4. Stop followed by a fresh start decodes the vector again.
5. A failed `OH_AudioCapturer_Stop` rejects; it is not reported as a normal
   stopped state.
6. A failed `OH_AudioCapturer_Release` retains the capturer/callback userdata,
   ignores a late callback, and a later stop retry releases it so a new start
   is possible.

7. Superseded start rejects before creating resources; an old queued stop cannot tear down a newer generation.
8. A failed builder destruction retains ownership and blocks restart until explicit cleanup succeeds.
9. A successful stop/release retry clears the stale native error.

## Run

Prerequisite: the repository has `dist/packages/signal/src/index.js` (the
existing `native/tools/make_test_vector.mjs` dependency).

```bash
bash apps/harmony-cw/tests/run_tests.sh
ctest --test-dir apps/harmony-cw/tests/build --output-on-failure
```

The script writes the generated PCM and all build output under `build/`
(ignored). The deterministic vector is temporary test data, not shipped in the
HAP.

## Limits

- The fake has no device clock, buffer-size or thread semantics; format
  acceptance, permission, background lifecycle and real audio quality remain
  device evidence.
- N-API/ArkTS lifetime and UI behavior are not executed here.
- The stub headers are a test projection, not an SDK ABI check; the HAP build
  is the compile-level SDK evidence.
