#include "decoder_core.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <vector>

extern "C" {
#include "multimon.h"
}

namespace cwstation {
namespace {

std::mutex& instanceMutex() {
  static std::mutex mutex;
  return mutex;
}

// 只由持有 instanceMutex() 的构造/析构写入；_verbprintf 只读取。
std::atomic<CwDecoder*>& activeInstance() {
  static std::atomic<CwDecoder*> instance{nullptr};
  return instance;
}

// 把 pos 前移到 UTF-8 起始字节；用于丢弃旧文本时保持完整片段。
std::size_t utf8Boundary(const char* data, std::size_t size, std::size_t pos) {
  if (pos >= size) {
    return size;
  }
  while (pos < size && (static_cast<unsigned char>(data[pos]) & 0xC0u) == 0x80u) {
    ++pos;
  }
  return pos;
}

}  // namespace

struct CwDecoder::Impl {
  demod_state state{};
  std::mutex text_mutex;
  std::string text;
  std::size_t truncated_bytes = 0;

  void appendUtf8(const char* data, std::size_t size) {
    if (data == nullptr || size == 0) {
      return;
    }

    std::lock_guard<std::mutex> lock(text_mutex);

    // 单次输出本身超过上限时只保留尾部完整片段。
    if (size > kTextCapacityBytes) {
      std::size_t drop = size - kTextCapacityBytes;
      drop = utf8Boundary(data, size, drop);
      truncated_bytes += drop;
      data += drop;
      size -= drop;
    }

    if (text.size() + size > kTextCapacityBytes) {
      const std::size_t need = text.size() + size - kTextCapacityBytes;
      const std::size_t cut = utf8Boundary(text.data(), text.size(), need);
      truncated_bytes += cut;
      text.erase(0, cut);
    }

    text.append(data, size);
  }
};

CwDecoder::CwDecoder() noexcept : impl_(nullptr), valid_(false), finished_(false) {
  std::lock_guard<std::mutex> lock(instanceMutex());
  if (activeInstance().load(std::memory_order_acquire) != nullptr) {
    error_ = "another CwDecoder instance is active";
    return;
  }

  impl_ = new (std::nothrow) Impl();
  if (impl_ == nullptr) {
    error_ = "failed to allocate decoder state";
    return;
  }

  if (demod_morse.float_samples ||
      demod_morse.samplerate != static_cast<unsigned int>(kSampleRateHz) ||
      demod_morse.overlap != 0 || demod_morse.init == nullptr ||
      demod_morse.demod == nullptr || demod_morse.deinit == nullptr) {
    error_ = "vendored demod_morse contract mismatch";
    delete impl_;
    impl_ = nullptr;
    return;
  }

  impl_->state.dem_par = &demod_morse;
  demod_morse.init(&impl_->state);
  activeInstance().store(this, std::memory_order_release);
  valid_ = true;
}

CwDecoder::~CwDecoder() {
  std::lock_guard<std::mutex> lock(instanceMutex());
  if (activeInstance().load(std::memory_order_acquire) == this) {
    if (valid_ && !finished_ && impl_ != nullptr) {
      try {
        finish(false);
      } catch (...) {
        // 析构不得抛出；deinit 的统计输出失败也不应阻止释放。
      }
    }
    activeInstance().store(nullptr, std::memory_order_release);
  }
  delete impl_;
  impl_ = nullptr;
  valid_ = false;
}

bool CwDecoder::valid() const noexcept { return valid_ && impl_ != nullptr; }

const std::string& CwDecoder::error() const noexcept { return error_; }

bool CwDecoder::finished() const noexcept { return finished_; }

bool CwDecoder::feed(const std::int16_t* samples, std::size_t sample_count) noexcept {
  if (!valid() || finished_) {
    return false;
  }
  if (sample_count == 0) {
    return true;
  }
  if (samples == nullptr) {
    return false;
  }
  return demodulate(samples, sample_count);
}

bool CwDecoder::finish(bool synthesize_tail) noexcept {
  if (!valid()) {
    return false;
  }
  if (finished_) {
    return true;
  }

  if (synthesize_tail) {
    std::array<std::int16_t, 1024> zeros{};
    std::size_t remaining = kTailSilenceSamples;
    while (remaining > 0) {
      const std::size_t chunk = std::min(remaining, zeros.size());
      demodulate(zeros.data(), chunk);
      remaining -= chunk;
    }
  }

  demod_morse.deinit(&impl_->state);
  finished_ = true;
  return true;
}

std::string CwDecoder::drain() {
  if (impl_ == nullptr) {
    return {};
  }
  std::lock_guard<std::mutex> lock(impl_->text_mutex);
  std::string output;
  output.swap(impl_->text);
  return output;
}

void CwDecoder::clear() {
  if (impl_ == nullptr) {
    return;
  }
  std::lock_guard<std::mutex> lock(impl_->text_mutex);
  impl_->text.clear();
  impl_->truncated_bytes = 0;
}

bool CwDecoder::truncated() const { return truncated_bytes() != 0; }

std::size_t CwDecoder::truncated_bytes() const {
  if (impl_ == nullptr) {
    return 0;
  }
  std::lock_guard<std::mutex> lock(impl_->text_mutex);
  return impl_->truncated_bytes;
}

bool CwDecoder::demodulate(const std::int16_t* samples, std::size_t sample_count) noexcept {
  constexpr std::size_t kMaxChunk =
      static_cast<std::size_t>(std::numeric_limits<int>::max());
  while (sample_count > 0) {
    const std::size_t chunk = std::min(sample_count, kMaxChunk);
    buffer_t buffer{};
    buffer.sbuffer = samples;
    buffer.fbuffer = nullptr;
    demod_morse.demod(&impl_->state, buffer, static_cast<int>(chunk));
    samples += chunk;
    sample_count -= chunk;
  }
  return true;
}

void CwDecoder::captureUtf8(const char* data, std::size_t size) {
  CwDecoder* self = activeInstance().load(std::memory_order_acquire);
  if (self == nullptr || !self->valid_ || self->impl_ == nullptr) {
    return;
  }
  self->impl_->appendUtf8(data, size);
}

}  // namespace cwstation

// multimon-ng 的字符输出统一走 _verbprintf。这里只接收 level 0，并把格式化
// 后的完整 UTF-8 片段交给当前唯一实例；统计级别（level 1）与 stdout 均不触碰。
extern "C" void _verbprintf(int verb_level, const char* fmt, ...) {
  if (verb_level != 0 || fmt == nullptr) {
    return;
  }

  va_list args;
  va_start(args, fmt);
  va_list copy;
  va_copy(copy, args);

  char stack_buffer[256];
  const int needed = std::vsnprintf(stack_buffer, sizeof(stack_buffer), fmt, args);
  va_end(args);

  if (needed < 0) {
    va_end(copy);
    return;
  }

  try {
    if (static_cast<std::size_t>(needed) < sizeof(stack_buffer)) {
      cwstation::CwDecoder::captureUtf8(stack_buffer, static_cast<std::size_t>(needed));
    } else if (needed <= 64 * 1024) {
      std::vector<char> buffer(static_cast<std::size_t>(needed) + 1);
      const int written = std::vsnprintf(buffer.data(), buffer.size(), fmt, copy);
      if (written == needed) {
        cwstation::CwDecoder::captureUtf8(buffer.data(), static_cast<std::size_t>(written));
      }
    }
  } catch (...) {
    // C ABI 边界不得抛出；内存不足时丢弃本次片段。
  }
  va_end(copy);
}
