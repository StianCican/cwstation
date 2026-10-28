#include "fake_audio.h"

#include <algorithm>
#include <cstring>

namespace fake_audio {

namespace {

struct BuilderImpl {
  int marker = 0xB0;
};

struct CapturerImpl {
  int marker = 0xC0;
};

OH_AudioStreamBuilder* builderPtr = nullptr;
OH_AudioCapturer* capturerPtr = nullptr;
OH_AudioStream_State state = AUDIOSTREAM_STATE_INVALID;
OH_AudioCapturer_OnReadDataCallback readCallback = nullptr;
void* readUserData = nullptr;
OH_AudioCapturer_OnInterruptCallback interruptCallback = nullptr;
void* interruptUserData = nullptr;
OH_AudioCapturer_OnErrorCallback errorCallback = nullptr;
void* errorUserData = nullptr;

}  // namespace

Config config;
Counters counters;

bool hasCapturer() { return capturerPtr != nullptr; }

void reset() {
  config = Config{};
  counters = Counters{};
  // Callers must finish previous sessions; a leaked capturer would invalidate
  // the isolation of the next case.
  if (builderPtr != nullptr) {
    delete reinterpret_cast<BuilderImpl*>(builderPtr);
    builderPtr = nullptr;
  }
  if (capturerPtr != nullptr) {
    delete reinterpret_cast<CapturerImpl*>(capturerPtr);
    capturerPtr = nullptr;
  }
  state = AUDIOSTREAM_STATE_INVALID;
  readCallback = nullptr;
  readUserData = nullptr;
  interruptCallback = nullptr;
  interruptUserData = nullptr;
  errorCallback = nullptr;
  errorUserData = nullptr;
}

void emitBytes(const void* bytes, int32_t byteCount) {
  if (capturerPtr != nullptr && readCallback != nullptr) {
    readCallback(capturerPtr, readUserData, const_cast<void*>(bytes), byteCount);
  }
}

void emit(const std::int16_t* samples, std::size_t sampleCount) {
  emitBytes(samples, static_cast<int32_t>(sampleCount * sizeof(std::int16_t)));
}

void interrupt(OH_AudioInterrupt_Hint hint) {
  if (capturerPtr != nullptr && interruptCallback != nullptr) {
    interruptCallback(capturerPtr, interruptUserData, AUDIOSTREAM_INTERRUPT_FORCE, hint);
  }
}

}  // namespace fake_audio

using namespace fake_audio;

extern "C" {

OH_AudioStream_Result OH_AudioStreamBuilder_Create(OH_AudioStreamBuilder** builder,
                                                   OH_AudioStream_Type type) {
  ++counters.builderCreate;
  if (builder == nullptr || type != AUDIOSTREAM_TYPE_CAPTURER) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  if (config.failBuilderCreate) {
    return AUDIOSTREAM_ERROR_SYSTEM;
  }
  builderPtr = reinterpret_cast<OH_AudioStreamBuilder*>(new BuilderImpl());
  *builder = builderPtr;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioStreamBuilder_Destroy(OH_AudioStreamBuilder* builder) {
  ++counters.builderDestroy;
  if (builder == nullptr || builder != builderPtr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  if (config.failBuilderDestroy) {
    return AUDIOSTREAM_ERROR_SYSTEM;
  }
  delete reinterpret_cast<BuilderImpl*>(builderPtr);
  builderPtr = nullptr;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetSamplingRate(OH_AudioStreamBuilder* builder,
                                                            int32_t) {
  return builder == builderPtr && builder != nullptr ? AUDIOSTREAM_SUCCESS
                                                     : AUDIOSTREAM_ERROR_INVALID_PARAM;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetChannelCount(OH_AudioStreamBuilder* builder,
                                                            int32_t) {
  return builder == builderPtr && builder != nullptr ? AUDIOSTREAM_SUCCESS
                                                     : AUDIOSTREAM_ERROR_INVALID_PARAM;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetSampleFormat(OH_AudioStreamBuilder* builder,
                                                            OH_AudioStream_SampleFormat) {
  return builder == builderPtr && builder != nullptr ? AUDIOSTREAM_SUCCESS
                                                     : AUDIOSTREAM_ERROR_INVALID_PARAM;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetEncodingType(OH_AudioStreamBuilder* builder,
                                                            OH_AudioStream_EncodingType) {
  return builder == builderPtr && builder != nullptr ? AUDIOSTREAM_SUCCESS
                                                     : AUDIOSTREAM_ERROR_INVALID_PARAM;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerInfo(OH_AudioStreamBuilder* builder,
                                                            OH_AudioStream_SourceType) {
  return builder == builderPtr && builder != nullptr ? AUDIOSTREAM_SUCCESS
                                                     : AUDIOSTREAM_ERROR_INVALID_PARAM;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerReadDataCallback(
    OH_AudioStreamBuilder* builder, OH_AudioCapturer_OnReadDataCallback callback, void* userData) {
  if (builder == nullptr || builder != builderPtr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  readCallback = callback;
  readUserData = userData;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerInterruptCallback(
    OH_AudioStreamBuilder* builder, OH_AudioCapturer_OnInterruptCallback callback, void* userData) {
  if (builder == nullptr || builder != builderPtr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  interruptCallback = callback;
  interruptUserData = userData;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerErrorCallback(
    OH_AudioStreamBuilder* builder, OH_AudioCapturer_OnErrorCallback callback, void* userData) {
  if (builder == nullptr || builder != builderPtr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  errorCallback = callback;
  errorUserData = userData;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioStreamBuilder_GenerateCapturer(OH_AudioStreamBuilder* builder,
                                                             OH_AudioCapturer** capturer) {
  ++counters.generate;
  if (builder == nullptr || builder != builderPtr || capturer == nullptr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  if (config.failGenerate) {
    return AUDIOSTREAM_ERROR_SYSTEM;
  }
  capturerPtr = reinterpret_cast<OH_AudioCapturer*>(new CapturerImpl());
  state = AUDIOSTREAM_STATE_PREPARED;
  *capturer = capturerPtr;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_Release(OH_AudioCapturer* capturer) {
  ++counters.release;
  if (capturer == nullptr || capturer != capturerPtr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  if (config.failRelease) {
    return AUDIOSTREAM_ERROR_SYSTEM;
  }
  delete reinterpret_cast<CapturerImpl*>(capturerPtr);
  capturerPtr = nullptr;
  state = AUDIOSTREAM_STATE_RELEASED;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_Start(OH_AudioCapturer* capturer) {
  ++counters.start;
  if (capturer == nullptr || capturer != capturerPtr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  if (config.failStart) {
    return AUDIOSTREAM_ERROR_SYSTEM;
  }
  state = AUDIOSTREAM_STATE_RUNNING;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_Stop(OH_AudioCapturer* capturer) {
  ++counters.stop;
  if (capturer == nullptr || capturer != capturerPtr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  if (config.failStop) {
    return AUDIOSTREAM_ERROR_SYSTEM;
  }
  state = AUDIOSTREAM_STATE_STOPPED;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_GetCurrentState(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_State* out) {
  ++counters.getState;
  if (capturer == nullptr || capturer != capturerPtr || out == nullptr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  if (config.failGetState) {
    return AUDIOSTREAM_ERROR_SYSTEM;
  }
  *out = state;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_GetSamplingRate(OH_AudioCapturer* capturer, int32_t* rate) {
  if (capturer == nullptr || capturer != capturerPtr || rate == nullptr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  *rate = config.rate;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_GetChannelCount(OH_AudioCapturer* capturer,
                                                       int32_t* channelCount) {
  if (capturer == nullptr || capturer != capturerPtr || channelCount == nullptr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  *channelCount = config.channels;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_GetSampleFormat(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_SampleFormat* format) {
  if (capturer == nullptr || capturer != capturerPtr || format == nullptr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  *format = config.format;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_GetEncodingType(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_EncodingType* encoding) {
  if (capturer == nullptr || capturer != capturerPtr || encoding == nullptr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  *encoding = config.encoding;
  return AUDIOSTREAM_SUCCESS;
}

OH_AudioStream_Result OH_AudioCapturer_GetCapturerInfo(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_SourceType* source) {
  if (capturer == nullptr || capturer != capturerPtr || source == nullptr) {
    return AUDIOSTREAM_ERROR_INVALID_PARAM;
  }
  *source = config.source;
  return AUDIOSTREAM_SUCCESS;
}

}  // extern "C"
