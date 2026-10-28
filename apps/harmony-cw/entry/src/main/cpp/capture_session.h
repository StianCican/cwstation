#pragma once
#include <atomic>
#include <array>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <ohaudio/native_audiocapturer.h>
#include <ohaudio/native_audiostreambuilder.h>

namespace cwstation { class CwDecoder; }
struct Snapshot {
    std::string text, error, format;
    bool running = false;
    double level = 0, peak = 0;
    uint64_t droppedSamples = 0, truncated = 0;
};
class CaptureSession {
public:
    ~CaptureSession();
    uint64_t requestStart() { desired = true; return ++epoch; }
    uint64_t requestStop() { desired = false; return ++epoch; }
    void start(uint64_t token);
    void stop(uint64_t token = 0);
    bool retainsResources();
    Snapshot drain();
    void clear();
    std::atomic<bool> desired{false};
    std::atomic<uint64_t> epoch{0};
private:
    static constexpr size_t Capacity = 22050 * 2;
    static void read(OH_AudioCapturer*, void*, void*, int32_t);
    static void interrupted(OH_AudioCapturer*, void*, OH_AudioInterrupt_ForceType, OH_AudioInterrupt_Hint);
    static void failed(OH_AudioCapturer*, void*, OH_AudioStream_Result);
    void work(std::unique_ptr<cwstation::CwDecoder>);
    void append(const std::string&);
    void cleanup();
    void fault(const std::string&);
    std::mutex lifecycle, queueMutex, viewMutex;
    std::condition_variable ready;
    std::array<int16_t, Capacity> queue{};
    size_t head = 0, count = 0;
    bool closing = true;
    std::atomic<bool> accept{false}, audioFault{false};
    std::thread worker;
    OH_AudioCapturer* capturer = nullptr;
    OH_AudioStreamBuilder* builder = nullptr;
    Snapshot view;
};
