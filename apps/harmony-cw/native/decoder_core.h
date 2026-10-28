// Harmony CW 解码检验器的原生桥接接口（host 可验证部分）。
//
// 该桥接只复用 vendored multimon-ng 的 demod_morse 描述符，不复制 Morse
// 算法；采集、N-API 生命周期与界面由 Codex 侧实现。接口保持无异常控制流，
// 以便 Native worker 在错误时直接检查 valid()/error()。

#ifndef CWSTATION_APPS_HARMONY_CW_NATIVE_DECODER_CORE_H_
#define CWSTATION_APPS_HARMONY_CW_NATIVE_DECODER_CORE_H_

#include <cstddef>
#include <cstdint>
#include <string>

// multimon.h 以 C 链接声明；这里提前声明以便 friend 绑定到全局 C 符号。
extern "C" void _verbprintf(int verb_level, const char* fmt, ...);

namespace cwstation {

// 单个进程内只允许一个活动实例。构造失败时 valid()==false，error() 给出原因；
// 析构后释放实例资格。feed/finish 不是线程安全的；调用方必须串行调用同一个
// 实例（Native 侧应保证只有一个解码 worker），drain/clear 可与解码线程并发。
class CwDecoder final {
 public:
  static constexpr int kSampleRateHz = 22050;
  // 0.5 秒 @ 22050 Hz；与 patched CLI 的 EOF 收尾样本数一致。
  static constexpr std::size_t kTailSilenceSamples = 11025;
  static constexpr std::size_t kTextCapacityBytes = 64 * 1024;

  CwDecoder() noexcept;
  ~CwDecoder();

  CwDecoder(const CwDecoder&) = delete;
  CwDecoder& operator=(const CwDecoder&) = delete;

  bool valid() const noexcept;
  const std::string& error() const noexcept;
  bool finished() const noexcept;

  // 输入 22050 Hz/mono/S16LE 样本，单位为样本。返回 false 表示实例无效、
  // 输入为空指针或已经 finish。0 个样本是合法的空操作。
  bool feed(const std::int16_t* samples, std::size_t sample_count) noexcept;

  // 默认先输入 0.5 秒零样本，再调用 demod_morse.deinit。重复调用幂等；
  // synthesize_tail=false 用于与 patched CLI 逐字节对照（尾静音已包含在输入中）。
  bool finish(bool synthesize_tail = true) noexcept;

  // 返回并清空待显示文本（完整 UTF-8 片段）。不改变 decoder 状态。
  std::string drain();

  // 只清待显示文本与截断计数，不重置 decoder/时序/门限状态。
  void clear();

  bool truncated() const;
  std::size_t truncated_bytes() const;

 private:
  struct Impl;
  friend void ::_verbprintf(int verb_level, const char* fmt, ...);
  static void captureUtf8(const char* data, std::size_t size);
  bool demodulate(const std::int16_t* samples, std::size_t sample_count) noexcept;

  Impl* impl_;
  bool valid_;
  bool finished_;
  std::string error_;
};

}  // namespace cwstation

#endif  // CWSTATION_APPS_HARMONY_CW_NATIVE_DECODER_CORE_H_
