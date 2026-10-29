# Vendored multimon-ng source projection

This directory is the locked C source projection used by the Harmony CW decode
bridge. It is not a second decoder: it is the exact patched `demod_morse`
implementation from the pinned upstream commit.

## Upstream and patch

- Upstream: <https://github.com/EliasOenal/multimon-ng>
- Pinned commit: `b5f7d71c5e9b5a76093ba55c515968dc40f92804` (CMake version 1.6.2)
- Patch: `patches/multimon-ng/multimon-threshold-hysteresis.patch`
- Patch SHA256: `e665984dd6d7e226bdfa9d64793ee8549a2fd8a407ee253683a2f8edfa6160dd`
- Current projection (2026-10-29): clean files from the pinned upstream commit
  plus the canonical patch above, independently applied and compared byte-for-byte
  with the mobile files. Local evidence: `.local-backups/harmony-tone-20261029-021422/projection-check`.
- `/home/li0214/DSH/tools/multimon-ng-v00-02` is the historical desktop working
  tree and remains unchanged at the earlier threshold-only patch. It is not the
  source of the new phone projection. No installed desktop binary was replaced.

## File SHA256

| File | SHA256 |
|---|---|
| `demod_morse.c` | `510957572eefcd3ec3d135345403aaff49e5b8c1c6dbf7d59014b82a44d198e5` |
| `multimon.h` | `8cf590abf25fb73e96d99e2fbe265000ae622c492264f40f300cdba5817e72fe` |
| `cJSON.h` | `0578cc29132912edbc88f83207a8fc76e5db3db0605497e909a9384ef3cc474b` |
| `COPYING` | `8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643` |
| `LICENSES/cJSON-MIT.txt` | `dd721b6bdc010b5a50b8fa549db8d72bd4d19aa17b3ccb37b69e6ffcee90adf0` |

`demod_morse.c` and `multimon.h` are projected byte-for-byte from the pinned
upstream commit plus the canonical patch. `cJSON.h` is required by `multimon.h`; no cJSON implementation is
compiled because the Morse path does not call cJSON. Do not hand-edit these
files; regenerate from the pinned commit plus patch if the source changes.

## Build contract

- Compile only `demod_morse.c` into the bridge; no `unixinput.c`, CLI `main`,
  FFmpeg, SDL, X11, or other demodulators.
- Definitions: `MAX_VERBOSE_LEVEL=3`, `NO_X11`.
- Tone frontend: the phone CMake defines `CW_TARGET_TONE_HZ=600` (host legacy
  tests may use `0`). The macro is compile-time only; `0` preserves the old
  rectifier input path, and no runtime parameter is exposed.
- `demod_morse` is the public descriptor (`float_samples=false`,
  `samplerate=22050`, `overlap=0`); `buffer_t.length` is in samples.
- `_verbprintf` is supplied by the bridge; only level 0 is captured. The level-1
  statistics from `morse_deinit` never enter the decoded text.

## Licensing

- multimon-ng is GPL-2.0-or-later; the full license text is `COPYING`. The
  upstream file headers are preserved.
- `demod_morse.c` states it was placed in the public domain by its author; it is
  distributed here as part of the GPL-2.0-or-later multimon-ng source.
- cJSON is MIT; see `LICENSES/cJSON-MIT.txt`.
- Any distribution of a HAP containing this projection must provide the
  corresponding source and resolve the application's own license first.
