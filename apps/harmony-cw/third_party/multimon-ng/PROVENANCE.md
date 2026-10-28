# Vendored multimon-ng source projection

This directory is the locked C source projection used by the Harmony CW decode
bridge. It is not a second decoder: it is the exact patched `demod_morse`
implementation from the pinned upstream commit.

## Upstream and patch

- Upstream: <https://github.com/EliasOenal/multimon-ng>
- Pinned commit: `b5f7d71c5e9b5a76093ba55c515968dc40f92804` (CMake version 1.6.2)
- Patch: `patches/multimon-ng/multimon-threshold-hysteresis.patch`
- Patch SHA256: `6cf69c5b34e76bb07e627a837f470ce6ad1f810fb7888a4b803e02ff3b8b1f66`
- Locked external tree used for this projection:
  `/home/li0214/DSH/tools/multimon-ng-v00-02`
- The external tree HEAD was verified as the pinned commit, and
  `git apply --check --reverse` succeeded there. A clean extraction of
  `git show HEAD:demod_morse.c` and `git show HEAD:multimon.h` plus the patch
  was compared byte-for-byte with the working tree; both files matched.

## File SHA256

| File | SHA256 |
|---|---|
| `demod_morse.c` | `3032e76f7e310108ef309d78c6bc349eb1703a5f799e0ede45d4a0c6e8ac5e2f` |
| `multimon.h` | `4a1ec1be3f85a6076a098ebd23232465f4a991e8a86a2429a7b04f43a79d4493` |
| `cJSON.h` | `0578cc29132912edbc88f83207a8fc76e5db3db0605497e909a9384ef3cc474b` |
| `COPYING` | `8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643` |
| `LICENSES/cJSON-MIT.txt` | `dd721b6bdc010b5a50b8fa549db8d72bd4d19aa17b3ccb37b69e6ffcee90adf0` |

`demod_morse.c` and `multimon.h` are vendored byte-for-byte from the patched
external tree. `cJSON.h` is required by `multimon.h`; no cJSON implementation is
compiled because the Morse path does not call cJSON. Do not hand-edit these
files; regenerate from the pinned commit plus patch if the source changes.

## Build contract

- Compile only `demod_morse.c` into the bridge; no `unixinput.c`, CLI `main`,
  FFmpeg, SDL, X11, or other demodulators.
- Definitions: `MAX_VERBOSE_LEVEL=3`, `NO_X11`.
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
