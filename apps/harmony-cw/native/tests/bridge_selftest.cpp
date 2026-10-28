// Host 状态测试：单实例门禁、clear 不重置 decoder、finish/feed 生命周期。

#include "decoder_core.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "SELFTEST FAIL: %s\n", message);
    ++failures;
  }
}

bool readFile(const char* path, std::vector<char>* bytes) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    return false;
  }
  bytes->assign(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
  return !input.bad() && bytes->size() % 2 == 0;
}

std::vector<std::int16_t> toSamples(const std::vector<char>& bytes) {
  std::vector<std::int16_t> samples(bytes.size() / 2);
  for (std::size_t i = 0; i < samples.size(); ++i) {
    const auto lo = static_cast<std::uint16_t>(static_cast<unsigned char>(bytes[i * 2]));
    const auto hi = static_cast<std::uint16_t>(static_cast<unsigned char>(bytes[i * 2 + 1]));
    samples[i] = static_cast<std::int16_t>(lo | (hi << 8));
  }
  return samples;
}

bool feedAll(cwstation::CwDecoder* decoder, const std::vector<std::int16_t>& samples,
             std::size_t begin, std::size_t end) {
  return decoder->feed(samples.data() + begin, end - begin);
}

std::string decodeAll(const std::vector<std::int16_t>& samples, bool tail) {
  cwstation::CwDecoder decoder;
  if (!decoder.valid()) {
    return {};
  }
  if (!decoder.feed(samples.data(), samples.size())) {
    return {};
  }
  if (!decoder.finish(tail)) {
    return {};
  }
  return decoder.drain();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: %s <cq-test-notail.s16le>\n", argv[0]);
    return 2;
  }

  std::vector<char> bytes;
  if (!readFile(argv[1], &bytes)) {
    std::fprintf(stderr, "cw_bridge_selftest: cannot read %s\n", argv[1]);
    return 2;
  }
  const std::vector<std::int16_t> samples = toSamples(bytes);
  if (samples.empty()) {
    std::fprintf(stderr, "cw_bridge_selftest: empty input\n");
    return 2;
  }

  const std::string expected_with_tail = "CQ TEST \n";
  const std::string expected_without_tail = "CQ TES\n";

  check(decodeAll(samples, true) == expected_with_tail,
        "tail synthesis must produce CQ TEST + newline");
  check(decodeAll(samples, false) == expected_without_tail,
        "no-tail EOF must produce CQ TES + newline");

  // 单实例门禁：第二个实例必须被拒绝，且拒绝后第一个实例仍可用；析构后
  // 新实例必须可以再次创建。
  {
    cwstation::CwDecoder first;
    check(first.valid(), "first instance must be valid");
    {
      cwstation::CwDecoder second;
      check(!second.valid(), "second concurrent instance must be rejected");
      check(!second.error().empty(), "rejection must carry an error message");
    }
    check(first.valid(), "first instance must survive rejected second instance");
    check(!first.finished(), "first instance must not be altered by rejection");
  }
  {
    cwstation::CwDecoder next;
    check(next.valid(), "a new instance must be creatable after destruction");
    check(!next.finished(), "new instance starts unfinished");
  }

  // clear 只清结果：在两段 PCM 之间 clear，最终文本必须与完整解码一致。
  {
    cwstation::CwDecoder decoder;
    check(decoder.valid(), "split decoder must be valid");
    const std::size_t midpoint = samples.size() / 2;
    check(feedAll(&decoder, samples, 0, midpoint), "split first half feed");
    std::string early = decoder.drain();
    check(decoder.drain().empty(), "drain must clear pending text");
    decoder.clear();
    check(decoder.drain().empty(), "clear must empty pending text");
    check(feedAll(&decoder, samples, midpoint, samples.size()), "split second half feed");
    check(decoder.finish(true), "split finish");
    std::string late = decoder.drain();
    check(early + late == expected_with_tail,
          "clear must not reset decoder state (split result equals full result)");
    check(decoder.finished(), "finished flag after finish");
    check(decoder.finish(true), "finish must be idempotent");
    check(decoder.drain().empty(), "idempotent finish must not emit duplicate newline");
    check(!decoder.feed(samples.data(), 1), "feed after finish must be rejected");
    check(decoder.truncated_bytes() == 0, "short vector must not truncate");
  }

  if (failures != 0) {
    std::fprintf(stderr, "SELFTEST FAIL: %d check(s) failed\n", failures);
    return 1;
  }
  std::fprintf(stderr,
               "SELFTEST PASS: instance gate, clear-preserves-decoder, finish/feed state\n");
  return 0;
}
