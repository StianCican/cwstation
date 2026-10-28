// Minimal host-test projection of ohaudio/native_audiocapturer.h (API 26).
// Signatures used by capture_session.cpp; implementations live in fake_audio.cpp.
#ifndef CW_TESTS_OHAUDIO_NATIVE_AUDIOCAPTURER_H_
#define CW_TESTS_OHAUDIO_NATIVE_AUDIOCAPTURER_H_

#include <ohaudio/native_audiostream_base.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*OH_AudioCapturer_OnReadDataCallback)(OH_AudioCapturer* capturer, void* userData,
                                                    void* audioData, int32_t audioDataSize);
typedef void (*OH_AudioCapturer_OnInterruptCallback)(OH_AudioCapturer* capturer, void* userData,
                                                     OH_AudioInterrupt_ForceType type,
                                                     OH_AudioInterrupt_Hint hint);
typedef void (*OH_AudioCapturer_OnErrorCallback)(OH_AudioCapturer* capturer, void* userData,
                                                 OH_AudioStream_Result error);

OH_AudioStream_Result OH_AudioCapturer_Release(OH_AudioCapturer* capturer);
OH_AudioStream_Result OH_AudioCapturer_Start(OH_AudioCapturer* capturer);
OH_AudioStream_Result OH_AudioCapturer_Stop(OH_AudioCapturer* capturer);
OH_AudioStream_Result OH_AudioCapturer_GetCurrentState(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_State* state);
OH_AudioStream_Result OH_AudioCapturer_GetSamplingRate(OH_AudioCapturer* capturer, int32_t* rate);
OH_AudioStream_Result OH_AudioCapturer_GetChannelCount(OH_AudioCapturer* capturer,
                                                       int32_t* channelCount);
OH_AudioStream_Result OH_AudioCapturer_GetSampleFormat(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_SampleFormat* format);
OH_AudioStream_Result OH_AudioCapturer_GetEncodingType(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_EncodingType* encoding);
OH_AudioStream_Result OH_AudioCapturer_GetCapturerInfo(OH_AudioCapturer* capturer,
                                                       OH_AudioStream_SourceType* source);

#ifdef __cplusplus
}
#endif

#endif  // CW_TESTS_OHAUDIO_NATIVE_AUDIOCAPTURER_H_
