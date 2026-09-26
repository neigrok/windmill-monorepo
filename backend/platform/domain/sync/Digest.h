#pragma once

#include <json/json.h>

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wm::sync {

// An unsigned 256-bit integer under arithmetic mod 2^256, held as 32 big-endian bytes: a SHA-256 hash
// read as a number, and the §6.12 scope digest that sums them. Zero is the digest of an empty scope.
class Digest256 {
public:
  Digest256() = default;
  explicit Digest256(const std::array<std::uint8_t, 32>& bytes) : bytes_(bytes) {}

  // The wire form: exactly 64 lowercase hexadecimal characters.
  static std::optional<Digest256> fromHex(std::string_view hex);

  const std::array<std::uint8_t, 32>& bytes() const { return bytes_; }
  std::string hex() const;

  Digest256 operator+(const Digest256& other) const;
  Digest256 operator-(const Digest256& other) const;
  bool operator==(const Digest256&) const = default;

private:
  std::array<std::uint8_t, 32> bytes_{};
};

Digest256 sha256(std::string_view bytes);

// §6.12 h(r): the SHA-256 of a row's JCS, the row exactly as a page carries it (§9.1), when its life is
// absent or alive. A dead row, and null for an absent one, hash to 0. A scope's digest changes by
// `digest - rowHash(before) + rowHash(after)` for each row an intent changes.
Digest256 rowHash(const Json::Value& row);

// §6.12: the sum of the rows' hashes, recomputed from scratch.
Digest256 scopeDigest(const std::vector<Json::Value>& rows);

}
