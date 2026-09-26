#include "platform/domain/sync/Digest.h"

#include "platform/domain/sync/Jcs.h"

#include "third_party/sha256/picosha2.h"

namespace wm::sync {

namespace {

constexpr char kHexDigits[] = "0123456789abcdef";

std::optional<std::uint8_t> nibble(char c) {
  if (c >= '0' && c <= '9') return static_cast<std::uint8_t>(c - '0');
  if (c >= 'a' && c <= 'f') return static_cast<std::uint8_t>(c - 'a' + 10);
  return std::nullopt;
}

bool isAlive(const Json::Value& row) {
  const Json::Value& life = row["life"];
  return life.isNull() || (life.isArray() && life[0] == "alive");
}

}

std::optional<Digest256> Digest256::fromHex(std::string_view hex) {
  if (hex.size() != 64) return std::nullopt;
  std::array<std::uint8_t, 32> bytes{};
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    const std::optional<std::uint8_t> high = nibble(hex[2 * i]);
    const std::optional<std::uint8_t> low = nibble(hex[2 * i + 1]);
    if (!high || !low) return std::nullopt;
    bytes[i] = static_cast<std::uint8_t>(*high << 4 | *low);
  }
  return Digest256{bytes};
}

std::string Digest256::hex() const {
  std::string text;
  for (const std::uint8_t byte : bytes_) {
    text.push_back(kHexDigits[byte >> 4]);
    text.push_back(kHexDigits[byte & 0x0F]);
  }
  return text;
}

Digest256 Digest256::operator+(const Digest256& other) const {
  std::array<std::uint8_t, 32> sum{};
  unsigned carry = 0;
  for (std::size_t i = sum.size(); i-- > 0;) {
    const unsigned total = bytes_[i] + other.bytes_[i] + carry;
    sum[i] = static_cast<std::uint8_t>(total);
    carry = total >> 8;
  }
  return Digest256{sum};
}

Digest256 Digest256::operator-(const Digest256& other) const {
  std::array<std::uint8_t, 32> difference{};
  int borrow = 0;
  for (std::size_t i = difference.size(); i-- > 0;) {
    const int total = bytes_[i] - other.bytes_[i] - borrow;
    difference[i] = static_cast<std::uint8_t>(total);
    borrow = total < 0 ? 1 : 0;
  }
  return Digest256{difference};
}

Digest256 sha256(std::string_view bytes) {
  std::array<std::uint8_t, 32> hash{};
  picosha2::hash256(bytes.begin(), bytes.end(), hash.begin(), hash.end());
  return Digest256{hash};
}

Digest256 rowHash(const Json::Value& row) {
  if (row.isNull() || !isAlive(row)) return Digest256{};
  return sha256(jcs(row));
}

Digest256 scopeDigest(const std::vector<Json::Value>& rows) {
  Digest256 sum;
  for (const Json::Value& row : rows) sum = sum + rowHash(row);
  return sum;
}

}
