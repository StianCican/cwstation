// Minimal host-test projection of ohaudio/native_audiostreambuilder.h (API 26).
// Signatures used by capture_session.cpp; implementations live in fake_audio.cpp.
#ifndef CW_TESTS_OHAUDIO_NATIVE_AUDIOSTREAMBUILDER_H_
#define CW_TESTS_OHAUDIO_NATIVE_AUDIOSTREAMBUILDER_H_

#include <ohaudio/native_audiocapturer.h>

#ifdef __cplusplus
extern "C" {
#endif

OH_AudioStream_Result OH_AudioStreamBuilder_Create(OH_AudioStreamBuilder** builder,
                                                   OH_AudioStream_Type type);
OH_AudioStream_Result OH_AudioStreamBuilder_Destroy(OH_AudioStreamBuilder* builder);
OH_AudioStream_Result OH_AudioStreamBuilder_SetSamplingRate(OH_AudioStreamBuilder* builder,
                                                            int32_t rate);
OH_AudioStream_Result OH_AudioStreamBuilder_SetChannelCount(OH_AudioStreamBuilder* builder,
                                                            int32_t channelCount);
OH_AudioStream_Result OH_AudioStreamBuilder_SetSampleFormat(OH_AudioStreamBuilder* builder,
                                                            OH_AudioStream_SampleFormat format);
OH_AudioStream_Result OH_AudioStreamBuilder_SetEncodingType(OH_AudioStreamBuilder* builder,
                                                            OH_AudioStream_EncodingType encoding);
OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerInfo(OH_AudioStreamBuilder* builder,
                                                            OH_AudioStream_SourceType source);
OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerReadDataCallback(
    OH_AudioStreamBuilder* builder, OH_AudioCapturer_OnReadDataCallback callback, void* userData);
OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerInterruptCallback(
    OH_AudioStreamBuilder* builder, OH_AudioCapturer_OnInterruptCallback callback, void* userData);
OH_AudioStream_Result OH_AudioStreamBuilder_SetCapturerErrorCallback(
    OH_AudioStreamBuilder* builder, OH_AudioCapturer_OnErrorCallback callback, void* userData);
OH_AudioStream_Result OH_AudioStreamBuilder_GenerateCapturer(OH_AudioStreamBuilder* builder,
                                                             OH_AudioCapturer** capturer);

#ifdef __cplusplus
}
#endif

#endif  // CW_TESTS_OHAUDIO_NATIVE_AUDIOSTREAMBUILDER_H_
