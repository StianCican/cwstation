// Android JNI adapter for the reused Harmony CW bridge.
//
// This file owns only platform lifetime and byte transfer. It does not contain a
// second decoder: CwDecoder and demod_morse come from apps/harmony-cw by relative
// source path and are compiled with CW_TARGET_TONE_HZ=600.
//
// Handles are opaque positive ids resolved through a mutex-protected registry.
// The Java worker owns create/feed/finish/destroy; the UI may drain/clear while
// the worker runs. No reinterpret_cast of a Java long handle is used, so a stale
// handle can never become a dangling pointer.

#include <jni.h>

#include <android/log.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "decoder_core.h"

namespace {

constexpr const char* kLogTag = "cwandroid-jni";

struct Session {
  std::unique_ptr<cwstation::CwDecoder> decoder;
};

std::mutex g_session_mutex;
std::unordered_map<jlong, std::shared_ptr<Session>> g_sessions;
std::atomic<jlong> g_next_handle{1};

std::shared_ptr<Session> acquire(jlong handle) {
  if (handle <= 0) {
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(g_session_mutex);
  const auto it = g_sessions.find(handle);
  return it == g_sessions.end() ? nullptr : it->second;
}

jbyteArray toByteArray(JNIEnv* env, const std::string& value) {
  const auto size = static_cast<jsize>(value.size());
  jbyteArray result = env->NewByteArray(size);
  if (result == nullptr) {
    return nullptr;
  }
  if (size > 0) {
    env->SetByteArrayRegion(
        result, 0, size,
        reinterpret_cast<const jbyte*>(value.data()));  // byte copy, not a handle
  }
  return result;
}

void logError(const char* message) {
  __android_log_print(ANDROID_LOG_ERROR, kLogTag, "%s", message);
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_org_cwstation_androidcw_CwNative_nativeCreate(JNIEnv*, jclass) {
  try {
    auto session = std::make_shared<Session>();
    session->decoder = std::make_unique<cwstation::CwDecoder>();
    const jlong handle = g_next_handle.fetch_add(1, std::memory_order_relaxed);
    {
      std::lock_guard<std::mutex> lock(g_session_mutex);
      g_sessions.emplace(handle, std::move(session));
    }
    return handle;
  } catch (const std::exception& error) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "nativeCreate: %s", error.what());
    return 0;
  } catch (...) {
    logError("nativeCreate: unknown exception");
    return 0;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_org_cwstation_androidcw_CwNative_nativeError(JNIEnv* env, jclass, jlong handle) {
  const auto session = acquire(handle);
  if (!session || !session->decoder) {
    return toByteArray(env, "native decoder handle is not available");
  }
  // Standard UTF-8 bytes are returned to Java; NewStringUTF is deliberately not
  // used so non-ASCII Morse output cannot be mangled by modified UTF-8.
  return toByteArray(env, session->decoder->error());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_org_cwstation_androidcw_CwNative_nativeFeed(
    JNIEnv* env, jclass, jlong handle, jshortArray samples, jint sample_count) {
  if (samples == nullptr || sample_count < 0) {
    return JNI_FALSE;
  }
  const jsize array_length = env->GetArrayLength(samples);
  if (sample_count > array_length) {
    return JNI_FALSE;
  }
  const auto session = acquire(handle);
  if (!session || !session->decoder) {
    return JNI_FALSE;
  }

  try {
    std::vector<std::int16_t> pcm(static_cast<std::size_t>(sample_count));
    if (sample_count > 0) {
      env->GetShortArrayRegion(samples, 0, sample_count, pcm.data());
      if (env->ExceptionCheck()) {
        env->ExceptionClear();
        logError("nativeFeed: GetShortArrayRegion failed");
        return JNI_FALSE;
      }
    }
    return session->decoder->feed(pcm.data(), pcm.size()) ? JNI_TRUE : JNI_FALSE;
  } catch (const std::exception& error) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "nativeFeed: %s", error.what());
    return JNI_FALSE;
  } catch (...) {
    logError("nativeFeed: unknown exception");
    return JNI_FALSE;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_org_cwstation_androidcw_CwNative_nativeDrain(JNIEnv* env, jclass, jlong handle) {
  const auto session = acquire(handle);
  if (!session || !session->decoder) {
    return toByteArray(env, std::string());
  }
  try {
    return toByteArray(env, session->decoder->drain());
  } catch (...) {
    logError("nativeDrain: unknown exception");
    return toByteArray(env, std::string());
  }
}

extern "C" JNIEXPORT jboolean JNICALL
Java_org_cwstation_androidcw_CwNative_nativeFinish(
    JNIEnv*, jclass, jlong handle, jboolean synthesize_tail) {
  const auto session = acquire(handle);
  if (!session || !session->decoder) {
    return JNI_FALSE;
  }
  try {
    return session->decoder->finish(synthesize_tail == JNI_TRUE) ? JNI_TRUE : JNI_FALSE;
  } catch (...) {
    logError("nativeFinish: unknown exception");
    return JNI_FALSE;
  }
}

extern "C" JNIEXPORT jlong JNICALL
Java_org_cwstation_androidcw_CwNative_nativeTruncatedBytes(
    JNIEnv*, jclass, jlong handle) {
  const auto session = acquire(handle);
  if (!session || !session->decoder) {
    return 0;
  }
  return static_cast<jlong>(session->decoder->truncated_bytes());
}

extern "C" JNIEXPORT void JNICALL
Java_org_cwstation_androidcw_CwNative_nativeClear(JNIEnv*, jclass, jlong handle) {
  const auto session = acquire(handle);
  if (session && session->decoder) {
    session->decoder->clear();
  }
}

extern "C" JNIEXPORT jboolean JNICALL
Java_org_cwstation_androidcw_CwNative_nativeDestroy(JNIEnv*, jclass, jlong handle) {
  if (handle <= 0) {
    return JNI_FALSE;
  }
  std::shared_ptr<Session> victim;
  {
    std::lock_guard<std::mutex> lock(g_session_mutex);
    const auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) {
      return JNI_FALSE;
    }
    victim = std::move(it->second);
    g_sessions.erase(it);
  }
  // The session is destroyed after releasing the registry lock. A concurrent
  // drain/clear holds its own shared_ptr and cannot observe a dangling handle.
  victim.reset();
  return JNI_TRUE;
}
