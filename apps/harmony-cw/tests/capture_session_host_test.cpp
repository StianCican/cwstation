// Host tests for the real capture_session.cpp against a fake OH_AudioCapturer.
//
// Covered: format-gate release, start-failure release, valid PCM -> same
// CwDecoder -> stop/finish, restart, stop-failure not reported as success,
// release-failure callback-userdata retention and retry.
//
// This does not run HarmonyOS audio, N-API, ArkTS, or any device path.

#include "capture_session.h"
#include "fake_audio.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

namespace {

int failures = 0;
const char* test_vector_path = nullptr;

void check(bool condition, const std::string& message) {
  if (!condition) {
    std::fprintf(stderr, "FAIL: %s\n", message.c_str());
    ++failures;
  }
}

template <typename Function>
bool throwsContaining(Function&& function, const std::string& needle, std::string* what) {
  try {
    function();
  } catch (const std::exception& error) {
    *what = error.what();
    return what->find(needle) != std::string::npos;
  }
  return false;
}

std::vector<std::int16_t> readSamples(const char* path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    std::fprintf(stderr, "cannot open PCM vector: %s\n", path);
    return {};
  }
  std::vector<char> bytes((std::istreambuf_iterator<char>(input)),
                          std::istreambuf_iterator<char>());
  if (bytes.size() % 2 != 0) {
    return {};
  }
  std::vector<std::int16_t> samples(bytes.size() / 2);
  std::memcpy(samples.data(), bytes.data(), bytes.size());
  return samples;
}

void resetFake() {
  check(!fake_audio::hasCapturer(), "previous case left a capturer unreleased");
  fake_audio::reset();
}

void startSession(CaptureSession* session, std::uint64_t* token) {
  *token = session->requestStart();
  session->start(*token);
}

// 1. Actual format differs: start must fail, release capturer and builder,
//    leave no worker, and allow a later correctly-formatted start.
void formatMismatchReleases() {
  resetFake();
  fake_audio::config.rate = 44100;
  {
    CaptureSession session;
    std::uint64_t token = 0;
    std::string what;
    check(throwsContaining([&] { startSession(&session, &token); }, "22050", &what),
          "format mismatch must fail with a format error, got: " + what);
    check(fake_audio::counters.release == 1, "format mismatch must release the capturer once");
    check(fake_audio::counters.builderDestroy == 1, "format mismatch must destroy the builder");
    check(!fake_audio::hasCapturer(), "format mismatch must not retain the capturer");
    check(!session.drain().running, "format mismatch must not report running");

    fake_audio::config.rate = 22050;
    startSession(&session, &token);
    check(session.drain().running, "a corrected format must allow a new start");
    session.stop();
  }
  resetFake();
}

// 2. OH_AudioCapturer_Start fails after the worker exists: start must reject,
//    release the capturer, join the worker, and allow a retry.
void startFailureReleases() {
  resetFake();
  fake_audio::config.failStart = true;
  {
    CaptureSession session;
    std::uint64_t token = 0;
    std::string what;
    check(throwsContaining([&] { startSession(&session, &token); }, "启动采集失败", &what),
          "start failure must surface the capturer start error, got: " + what);
    check(fake_audio::counters.release == 1, "start failure must release the capturer once");
    check(fake_audio::counters.builderDestroy == 1, "start failure must destroy the builder");
    check(!fake_audio::hasCapturer(), "start failure must not retain the capturer");
    check(!session.drain().running, "start failure must not report running");

    session.stop();  // Idempotent after the failed start's cleanup.

    fake_audio::config.failStart = false;
    startSession(&session, &token);
    check(session.drain().running, "retry after start failure must succeed");
    session.stop();
  }
  resetFake();
}

// 3. Valid 22050 Hz/mono/S16LE PCM goes through the real bounded queue into
//    the real CwDecoder; stop must drain, synthesize the 0.5 s tail, finish
//    and expose the exact decoded bytes.
void validPcmFinishes() {
  resetFake();
  const std::vector<std::int16_t> samples = readSamples(test_vector_path);
  check(!samples.empty(), "test vector must be readable and non-empty");
  if (samples.empty()) {
    return;
  }
  {
    CaptureSession session;
    std::uint64_t token = 0;
    startSession(&session, &token);
    check(session.drain().running, "valid start must report running");

    constexpr std::size_t kChunk = 512;
    for (std::size_t offset = 0; offset < samples.size(); offset += kChunk) {
      const std::size_t count = std::min(kChunk, samples.size() - offset);
      fake_audio::emit(samples.data() + offset, count);
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    session.stop();
    const Snapshot out = session.drain();
    check(out.text == "CQ TEST \n", "stop must finish the decoder with the 0.5 s tail; got: " +
                                       std::string(out.text));
    check(out.droppedSamples == 0, "test pacing must not drop PCM samples; dropped=" +
                                       std::to_string(out.droppedSamples));
    check(!out.running, "successful stop must report not running");
    check(out.error.empty(), "successful stop must not leave an error");
  }
  resetFake();
}

// 4. A stopped session can start again, and the second run still decodes.
void restartAfterStop() {
  resetFake();
  const std::vector<std::int16_t> samples = readSamples(test_vector_path);
  check(!samples.empty(), "test vector must be readable for restart");
  if (samples.empty()) {
    return;
  }
  {
    CaptureSession session;
    std::uint64_t token = 0;
    startSession(&session, &token);
    session.stop();
    check(!session.drain().running, "first stop must report not running");

    startSession(&session, &token);
    check(session.drain().running, "second start must report running");
    constexpr std::size_t kChunk = 512;
    for (std::size_t offset = 0; offset < samples.size(); offset += kChunk) {
      const std::size_t count = std::min(kChunk, samples.size() - offset);
      fake_audio::emit(samples.data() + offset, count);
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    session.stop();
    const Snapshot out = session.drain();
    check(out.text == "CQ TEST \n", "second run must decode after restart; got: " +
                                       std::string(out.text));
    check(fake_audio::counters.builderCreate == 2, "restart must create a fresh builder");
    check(fake_audio::counters.release == 2, "each stop must release exactly once");
  }
  resetFake();
}

// 5. A failed Stop must reject, not resolve as a normal stopped state; the
//    retry can release. This also records whether a recovered stop leaves a
//    stale error visible to the UI poller.
void stopFailureIsNotSuccess() {
  resetFake();
  {
    CaptureSession session;
    std::uint64_t token = 0;
    startSession(&session, &token);
    fake_audio::config.failStop = true;
    std::string what;
    check(throwsContaining([&] { session.stop(); }, "停止采集失败", &what),
          "stop failure must throw, got: " + what);
    Snapshot failed = session.drain();
    check(!failed.running, "released capturer after failed Stop must not report running");
    check(failed.error.find("停止采集失败") != std::string::npos,
          "failed Stop must publish the error");

    fake_audio::config.failStop = false;
    session.stop();
    Snapshot retried = session.drain();
    check(retried.error.empty(), "successful stop retry must clear stale native error");
    std::printf("OBSERVE stop-retry-error: '%s'\n", retried.error.c_str());
    check(!retried.running, "successful retry stop must report not running");
  }
  resetFake();
}

// 6. Release failure must keep the callback userdata alive (the capturer is
//    retained), ignore later callbacks safely, and allow an explicit retry
//    that releases and permits a fresh start.
void releaseFailureRetainsCallback() {
  resetFake();
  {
    CaptureSession session;
    std::uint64_t token = 0;
    startSession(&session, &token);
    fake_audio::config.failRelease = true;
    std::string what;
    check(throwsContaining([&] { session.stop(); }, "释放采集器失败", &what),
          "release failure must throw, got: " + what);
    check(fake_audio::hasCapturer(), "release failure must retain the capturer");
    check(fake_audio::counters.release == 1, "release must have been attempted once");
    Snapshot failed = session.drain();
    check(failed.running, "retained capturer must keep the session reported as not stopped");

    // The callback userdata still points at the live CaptureSession. A late
    // read must be ignored because accept is already false.
    const std::int16_t late[4] = {0, 0, 0, 0};
    fake_audio::emit(late, 4);
    const double lateLevel = session.drain().level;
    check(lateLevel == 0.0, "late callback after failed release must not update the view");

    fake_audio::config.failRelease = false;
    session.stop();
    check(!fake_audio::hasCapturer(), "retry must release the capturer");
    Snapshot retried = session.drain();
    check(!retried.running, "retried stop must report not running");
    check(retried.error.empty(), "successful release retry must clear stale native error");
    std::printf("OBSERVE release-retry-error: '%s'\n", retried.error.c_str());

    startSession(&session, &token);
    check(session.drain().running, "start after successful release retry must work");
    session.stop();
  }
  resetFake();
}

// Requests can run out of order on the N-API pool: old stops cannot tear down a newer start.
void supersededRequests() {
  resetFake();
  {
    CaptureSession session;
    auto staleStart = session.requestStart();
    auto oldStop = session.requestStop();
    std::string what;
    check(throwsContaining([&] { session.start(staleStart); }, "取消", &what),
          "superseded start must reject instead of succeeding without effect");
    check(fake_audio::counters.builderCreate == 0, "canceled start must not create audio resources");
    auto current = session.requestStart();
    session.start(current);
    session.stop(oldStop);
    check(session.drain().running, "old queued stop must not tear down the new generation");
    check(fake_audio::counters.release == 0, "old queued stop must not release the new capturer");
    session.stop(session.requestStop());
    check(!session.retainsResources(), "current stop must clean all resources");
  }
  resetFake();
}

void builderFailureRetainsOwnership() {
  resetFake();
  {
    CaptureSession session;
    fake_audio::config.failBuilderDestroy = true;
    std::string what;
    check(throwsContaining([&] { session.start(session.requestStart()); }, "释放", &what),
          "builder destruction failure must surface");
    check(session.retainsResources(), "failed builder destroy must retain ownership");
    check(!fake_audio::hasCapturer(), "capturer release may succeed independently of builder destroy");
    const int creates = fake_audio::counters.builderCreate;
    check(throwsContaining([&] { session.start(session.requestStart()); }, "占用", &what),
          "restart must refuse while the old builder is retained");
    check(fake_audio::counters.builderCreate == creates, "restart must never overwrite the retained builder");
    fake_audio::config.failBuilderDestroy = false;
    session.stop();
    check(!session.retainsResources(), "explicit retry must release the retained builder");
    session.start(session.requestStart()); session.stop();
  }
  resetFake();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: %s <cq-test.s16le>\n", argv[0]);
    return 2;
  }
  test_vector_path = argv[1];

  formatMismatchReleases();
  startFailureReleases();
  validPcmFinishes();
  restartAfterStop();
  stopFailureIsNotSuccess();
  releaseFailureRetainsCallback();
  supersededRequests();
  builderFailureRetainsOwnership();

  if (failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("PASS: capture_session host concurrency/lifecycle checks\n");
  return 0;
}
