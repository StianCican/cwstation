// Host harness：读入 22050 Hz/mono/S16LE（无 WAV 头）并只把原始解码字节写到
// stdout；任何诊断都走 stderr，避免统计污染对照结果。

#include "decoder_core.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

bool readFile(const char* path, std::vector<char>* bytes) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    std::fprintf(stderr, "cw_decode_harness: cannot open %s\n", path);
    return false;
  }
  bytes->assign(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
  if (input.bad()) {
    std::fprintf(stderr, "cw_decode_harness: read failed for %s\n", path);
    return false;
  }
  if (bytes->size() % 2 != 0) {
    std::fprintf(stderr, "cw_decode_harness: input byte count is not a multiple of 2\n");
    return false;
  }
  return true;
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

struct ChunkPlan {
  std::size_t fixed = 11025;
  bool random = false;
  std::uint32_t state = 0x9e3779b9u;

  std::size_t next() {
    if (!random) {
      return fixed;
    }
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return 1 + (state % 97);
  }
};

bool parseChunk(const char* value, ChunkPlan* plan) {
  char* end = nullptr;
  if (std::strncmp(value, "random:", 7) == 0) {
    const unsigned long seed = std::strtoul(value + 7, &end, 10);
    if (end == value + 7 || *end != '\0') {
      return false;
    }
    plan->random = true;
    plan->state = static_cast<std::uint32_t>(seed);
    if (plan->state == 0) {
      plan->state = 0x9e3779b9u;
    }
    return true;
  }
  const unsigned long long parsed = std::strtoull(value, &end, 10);
  if (end == value || *end != '\0' || parsed == 0 || parsed > 0xffffffffull) {
    return false;
  }
  plan->random = false;
  plan->fixed = static_cast<std::size_t>(parsed);
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr,
                 "usage: %s <input.s16le> [--no-tail] [--chunk N|random:SEED]\n",
                 argv[0]);
    return 2;
  }

  const char* path = nullptr;
  bool synthesize_tail = true;
  ChunkPlan plan;

  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--no-tail") == 0) {
      synthesize_tail = false;
    } else if (std::strcmp(argv[i], "--chunk") == 0 && i + 1 < argc) {
      if (!parseChunk(argv[++i], &plan)) {
        std::fprintf(stderr, "cw_decode_harness: invalid --chunk value\n");
        return 2;
      }
    } else if (argv[i][0] != '-' && path == nullptr) {
      path = argv[i];
    } else {
      std::fprintf(stderr, "cw_decode_harness: unknown argument %s\n", argv[i]);
      return 2;
    }
  }

  if (path == nullptr) {
    std::fprintf(stderr, "cw_decode_harness: missing input path\n");
    return 2;
  }

  std::vector<char> bytes;
  if (!readFile(path, &bytes)) {
    return 2;
  }
  const std::vector<std::int16_t> samples = toSamples(bytes);

  cwstation::CwDecoder decoder;
  if (!decoder.valid()) {
    std::fprintf(stderr, "cw_decode_harness: decoder unavailable: %s\n",
                 decoder.error().c_str());
    return 3;
  }

  std::size_t offset = 0;
  while (offset < samples.size()) {
    const std::size_t chunk = std::min(plan.next(), samples.size() - offset);
    if (!decoder.feed(samples.data() + offset, chunk)) {
      std::fprintf(stderr, "cw_decode_harness: feed failed at sample %zu\n", offset);
      return 4;
    }
    offset += chunk;
  }

  if (!decoder.finish(synthesize_tail)) {
    std::fprintf(stderr, "cw_decode_harness: finish failed\n");
    return 4;
  }

  const std::string output = decoder.drain();
  if (!output.empty()) {
    const std::size_t written = std::fwrite(output.data(), 1, output.size(), stdout);
    if (written != output.size()) {
      std::fprintf(stderr, "cw_decode_harness: stdout write failed\n");
      return 4;
    }
  }
  std::fflush(stdout);
  return 0;
}
