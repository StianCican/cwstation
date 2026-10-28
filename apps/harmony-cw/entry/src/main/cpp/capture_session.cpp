#include "capture_session.h"
#include "decoder_core.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace {
void check(OH_AudioStream_Result r, const char* what) {
    if (r != AUDIOSTREAM_SUCCESS) throw std::runtime_error(std::string(what) + " (" + std::to_string(r) + ")");
}
}
CaptureSession::~CaptureSession() {
    // The N-API finalizer moves ownership to a cleanup thread, never joins on UI.
    try { stop(); } catch (...) {}
}
void CaptureSession::fault(const std::string& error) {
    std::lock_guard<std::mutex> lock(viewMutex);
    view.error = error;
}
void CaptureSession::start(uint64_t token) {
    std::lock_guard<std::mutex> lock(lifecycle);
    if (!desired || epoch != token) throw std::runtime_error("启动请求已取消");
    if (capturer || builder || worker.joinable()) throw std::runtime_error("采集资源仍占用，请先停止");
    { std::lock_guard<std::mutex> v(viewMutex); view = Snapshot{}; }
    { std::lock_guard<std::mutex> q(queueMutex); head = count = 0; closing = false; }
    audioFault = false;
    try {
        check(OH_AudioStreamBuilder_Create(&builder, AUDIOSTREAM_TYPE_CAPTURER), "创建采集器失败");
        check(OH_AudioStreamBuilder_SetSamplingRate(builder, 22050), "设置采样率失败");
        check(OH_AudioStreamBuilder_SetChannelCount(builder, 1), "设置声道失败");
        check(OH_AudioStreamBuilder_SetSampleFormat(builder, AUDIOSTREAM_SAMPLE_S16LE), "设置样本格式失败");
        check(OH_AudioStreamBuilder_SetEncodingType(builder, AUDIOSTREAM_ENCODING_TYPE_RAW), "设置编码失败");
        check(OH_AudioStreamBuilder_SetCapturerInfo(builder, AUDIOSTREAM_SOURCE_TYPE_MIC), "设置麦克风失败");
        check(OH_AudioStreamBuilder_SetCapturerReadDataCallback(builder, read, this), "设置采集回调失败");
        check(OH_AudioStreamBuilder_SetCapturerInterruptCallback(builder, interrupted, this), "设置中断回调失败");
        check(OH_AudioStreamBuilder_SetCapturerErrorCallback(builder, failed, this), "设置错误回调失败");
        check(OH_AudioStreamBuilder_GenerateCapturer(builder, &capturer), "麦克风不可用");
        check(OH_AudioStreamBuilder_Destroy(builder), "释放构造器失败"); builder = nullptr;
        int32_t rate = 0, channels = 0;
        OH_AudioStream_SampleFormat format;
        OH_AudioStream_EncodingType encoding;
        OH_AudioStream_SourceType source;
        check(OH_AudioCapturer_GetSamplingRate(capturer, &rate), "读取采样率失败");
        check(OH_AudioCapturer_GetChannelCount(capturer, &channels), "读取声道失败");
        check(OH_AudioCapturer_GetSampleFormat(capturer, &format), "读取样本格式失败");
        check(OH_AudioCapturer_GetEncodingType(capturer, &encoding), "读取编码失败");
        check(OH_AudioCapturer_GetCapturerInfo(capturer, &source), "读取音源失败");
        if (rate != 22050 || channels != 1 || format != AUDIOSTREAM_SAMPLE_S16LE ||
            encoding != AUDIOSTREAM_ENCODING_TYPE_RAW || source != AUDIOSTREAM_SOURCE_TYPE_MIC)
            throw std::runtime_error("设备不支持要求的 22050 Hz / 单声道 / S16LE / RAW 麦克风格式");
        { std::lock_guard<std::mutex> v(viewMutex); view.format = "MIC · 22050 Hz · 单声道 · S16LE · RAW"; }
        // Construction/initialization occurs before capture starts; the worker alone uses it afterwards.
        auto decoder = std::make_unique<cwstation::CwDecoder>();
        if (!decoder->valid()) throw std::runtime_error(decoder->error());
        worker = std::thread([this, d = std::move(decoder)]() mutable { work(std::move(d)); });
        accept = true;
        if (!desired || epoch != token) throw std::runtime_error("启动请求已取消");
        check(OH_AudioCapturer_Start(capturer), "启动采集失败");
        { std::lock_guard<std::mutex> v(viewMutex); view.running = true; }
    } catch (const std::exception& e) {
        std::string error = e.what();
        try { cleanup(); } catch (const std::exception& c) { error += std::string("；") + c.what(); }
        fault(error);
        throw std::runtime_error(error);
    }
}
void CaptureSession::read(OH_AudioCapturer*, void* opaque, void* bytes, int32_t size) {
    auto* self = static_cast<CaptureSession*>(opaque);
    if (!self->accept) return;
    if (!bytes || size <= 0 || size % 2) {
        self->audioFault = true; self->ready.notify_one(); return;
    }
    size_t n = static_cast<size_t>(size) / 2;
    // Copy only; no N-API, allocation, decoder, or capturer API on the audio thread.
    double sum = 0, peak = 0;
    const auto* src = static_cast<const unsigned char*>(bytes);
    std::lock_guard<std::mutex> lock(self->queueMutex);
    if (self->closing) return;
    const size_t available = Capacity - self->count;
    for (size_t i = 0; i < n; ++i) {
        int16_t sample;
        std::memcpy(&sample, src + 2 * i, 2);
        double value = static_cast<double>(sample) / 32768;
        sum += value * value; peak = std::max(peak, std::abs(value));
        if (i < available) {
            self->queue[(self->head + self->count) % Capacity] = sample;
            ++self->count;
        }
    }
    { std::lock_guard<std::mutex> v(self->viewMutex);
      self->view.level = std::sqrt(sum / n); self->view.peak = peak;
      self->view.droppedSamples += n > available ? n - available : 0; }
    self->ready.notify_one();
}
void CaptureSession::interrupted(OH_AudioCapturer*, void* opaque, OH_AudioInterrupt_ForceType, OH_AudioInterrupt_Hint hint) {
    if (hint == AUDIOSTREAM_INTERRUPT_HINT_RESUME || hint == AUDIOSTREAM_INTERRUPT_HINT_NONE) return;
    auto* self = static_cast<CaptureSession*>(opaque);
    self->audioFault = true; self->ready.notify_one();
}
void CaptureSession::failed(OH_AudioCapturer*, void* opaque, OH_AudioStream_Result) {
    auto* self = static_cast<CaptureSession*>(opaque);
    self->audioFault = true; self->ready.notify_one();
}
void CaptureSession::append(const std::string& text) {
    std::lock_guard<std::mutex> lock(viewMutex);
    view.text += text;
    if (view.text.size() > 65536) {
        size_t cut = view.text.size() - 65536;
        while (cut < view.text.size() && (static_cast<unsigned char>(view.text[cut]) & 0xc0) == 0x80) ++cut;
        view.text.erase(0, cut); ++view.truncated;
    }
}
void CaptureSession::work(std::unique_ptr<cwstation::CwDecoder> decoder) {
    try {
        std::array<int16_t, 2048> block;
        size_t previousTruncated = 0;
        for (;;) {
            size_t n;
            { std::unique_lock<std::mutex> q(queueMutex);
              ready.wait(q, [&] { return closing || count || audioFault; });
              if (audioFault) {
                  fault("音频已中断，请停止后重新开始");
                  audioFault = false;
                  // UI polling requests the same asynchronous stop; never call capturer APIs from callback.
              }
              if (!count && closing) break;
              n = std::min(count, block.size());
              for (size_t i = 0; i < n; ++i) block[i] = queue[(head + i) % Capacity];
              head = (head + n) % Capacity; count -= n;
            }
            if (n) { if (!decoder->feed(block.data(), n)) throw std::runtime_error(decoder->error());
                append(decoder->drain());
                const size_t lost = decoder->truncated_bytes();
                if (lost > previousTruncated) {
                    std::lock_guard<std::mutex> v(viewMutex); ++view.truncated;
                    previousTruncated = lost;
                } }
        }
        if (!decoder->finish()) throw std::runtime_error(decoder->error());
        append(decoder->drain());
    } catch (const std::exception& e) {
        accept = false; fault(std::string("解码异常：") + e.what());
    }
}
void CaptureSession::cleanup() {
    std::string error;
    if (capturer) {
        OH_AudioStream_State state;
        if (OH_AudioCapturer_GetCurrentState(capturer, &state) != AUDIOSTREAM_SUCCESS) error = "无法确认采集状态";
        else if (state == AUDIOSTREAM_STATE_RUNNING || state == AUDIOSTREAM_STATE_PAUSED) {
            if (OH_AudioCapturer_Stop(capturer) != AUDIOSTREAM_SUCCESS) error = "停止采集失败";
        }
        // Callback userdata stays alive until Release succeeds; retain the native object on failure.
        if (OH_AudioCapturer_Release(capturer) == AUDIOSTREAM_SUCCESS) capturer = nullptr;
        else error += " 释放采集器失败";
    }
    accept = false;
    { std::lock_guard<std::mutex> q(queueMutex); closing = true; }
    ready.notify_one();
    if (worker.joinable()) worker.join();
    if (builder) {
        if (OH_AudioStreamBuilder_Destroy(builder) == AUDIOSTREAM_SUCCESS) builder = nullptr;
        else error += " 释放构造器失败";
    }
    { std::lock_guard<std::mutex> v(viewMutex); view.running = capturer != nullptr; view.level = view.peak = 0;
      if (error.empty()) view.error.clear(); }
    if (!error.empty()) throw std::runtime_error(error);
}
bool CaptureSession::retainsResources() {
    std::lock_guard<std::mutex> lock(lifecycle);
    return capturer || builder || worker.joinable();
}
void CaptureSession::stop(uint64_t token) {
    std::lock_guard<std::mutex> lock(lifecycle);
    if (token && epoch != token) return;
    try { cleanup(); } catch (const std::exception& e) { fault(e.what()); throw; }
}
Snapshot CaptureSession::drain() {
    std::lock_guard<std::mutex> lock(viewMutex);
    Snapshot out = view; view.text.clear(); return out;
}
void CaptureSession::clear() {
    std::lock_guard<std::mutex> lock(viewMutex); view.text.clear(); view.truncated = 0;
}
