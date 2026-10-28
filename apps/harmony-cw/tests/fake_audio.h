// Fake OH_AudioCapturer boundary for the host concurrency tests.
// It is a deterministic test double, not the HarmonyOS audio service.
#ifndef CW_TESTS_FAKE_AUDIO_H_
#define CW_TESTS_FAKE_AUDIO_H_

#include <cstddef>
#include <cstdint>

#include <ohaudio/native_audiocapturer.h>
#include <ohaudio/native_audiostreambuilder.h>

namespace fake_audio {

struct Config {
  int32_t rate = 22050;
  int32_t channels = 1;
  OH_AudioStream_SampleFormat format = AUDIOSTREAM_SAMPLE_S16LE;
  OH_AudioStream_EncodingType encoding = AUDIOSTREAM_ENCODING_TYPE_RAW;
  OH_AudioStream_SourceType source = AUDIOSTREAM_SOURCE_TYPE_MIC;

  bool failBuilderCreate = false;
  bool failBuilderDestroy = false;
  bool failGenerate = false;
  bool failStart = false;
  bool failGetState = false;
  bool failStop = false;
  bool failRelease = false;
};

struct Counters {
  int builderCreate = 0;
  int builderDestroy = 0;
  int generate = 0;
  int start = 0;
  int stop = 0;
  int release = 0;
  int getState = 0;
};

extern Config config;
extern Counters counters;

// True while a generated capturer has not been released successfully.
bool hasCapturer();

void reset();

// Deliver one read callback exactly as the audio service would, with the
// userdata and capturer pointer registered by capture_session.cpp.
void emit(const std::int16_t* samples, std::size_t sampleCount);
void emitBytes(const void* bytes, int32_t byteCount);
void interrupt(OH_AudioInterrupt_Hint hint);

}  // namespace fake_audio

#endif  // CW_TESTS_FAKE_AUDIO_H_
