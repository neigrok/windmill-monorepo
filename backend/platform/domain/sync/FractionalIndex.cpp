#include "platform/domain/sync/FractionalIndex.h"

#include <algorithm>
#include <iterator>

namespace wm::sync {

namespace {

constexpr std::string_view kDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
constexpr int kBase = 62;
constexpr char kZero = '0';
constexpr char kLast = 'z';

// The integer part below every integer a key may hold; it only ever carries a fraction.
const std::string& smallestInteger() {
  static const std::string integer = "A" + std::string(26, kZero);
  return integer;
}

int digitOf(char c) {
  const std::size_t at = kDigits.find(c);
  return at == std::string_view::npos ? -1 : static_cast<int>(at);
}

std::string integerPart(std::string_view key) {
  const char head = key.front();
  std::size_t length = 0;
  if (head >= 'a' && head <= 'z') length = static_cast<std::size_t>(head - 'a' + 2);
  else if (head >= 'A' && head <= 'Z') length = static_cast<std::size_t>('Z' - head + 2);
  else throw OrderKeyError("an order key's head is a letter");
  if (length > key.size()) throw OrderKeyError("an order key is shorter than its head demands");
  return std::string(key.substr(0, length));
}

void requireKey(std::string_view key) {
  if (key.empty() || key == smallestInteger()) throw OrderKeyError("not an order key");
  if (std::any_of(key.begin(), key.end(), [](char c) { return digitOf(c) < 0; })) throw OrderKeyError("an order key's digits are base 62");
  const std::string integer = integerPart(key);
  if (key.size() > integer.size() && key.back() == kZero) throw OrderKeyError("an order key's fraction ends in 0");
}

// A fraction strictly between two fractions, `b` nullopt for no upper end.
std::string midpoint(std::string_view a, std::optional<std::string_view> b) {
  if (b && a >= *b) throw OrderKeyError("the ends are not ascending");
  if ((!a.empty() && a.back() == kZero) || (b && !b->empty() && b->back() == kZero)) throw OrderKeyError("a fraction ends in 0");
  if (b) {
    std::size_t shared = 0;
    while (shared < b->size() && (shared < a.size() ? a[shared] : kZero) == (*b)[shared]) ++shared;
    if (shared > 0) return std::string(b->substr(0, shared)) + midpoint(a.substr(std::min(shared, a.size())), b->substr(shared));
  }
  const int digitA = a.empty() ? 0 : digitOf(a.front());
  const int digitB = b ? digitOf(b->front()) : kBase;
  if (digitB - digitA > 1) return std::string(1, kDigits[static_cast<std::size_t>((digitA + digitB + 1) / 2)]);
  if (b && b->size() > 1) return std::string(b->substr(0, 1));
  return std::string(1, kDigits[static_cast<std::size_t>(digitA)]) + midpoint(a.empty() ? a : a.substr(1), std::nullopt);
}

// The integer part one step up (+1) or down (-1), growing or shrinking by a digit across a head letter;
// nothing past the largest or below the smallest.
std::optional<std::string> stepInteger(const std::string& integer, int direction) {
  const char head = integer.front();
  std::string digits = integer.substr(1);
  bool carry = true;
  for (std::size_t i = digits.size(); carry && i-- > 0;) {
    const int next = digitOf(digits[i]) + direction;
    if (next == kBase || next == -1) {
      digits[i] = direction > 0 ? kZero : kLast;
      continue;
    }
    digits[i] = kDigits[static_cast<std::size_t>(next)];
    carry = false;
  }
  if (!carry) return head + digits;
  if (direction > 0) {
    if (head == 'Z') return std::string{'a', kZero};
    if (head == 'z') return std::nullopt;
    const char next = static_cast<char>(head + 1);
    if (next > 'a') digits.push_back(kZero);
    else digits.pop_back();
    return next + digits;
  }
  if (head == 'a') return std::string{'Z', kLast};
  if (head == 'A') return std::nullopt;
  const char previous = static_cast<char>(head - 1);
  if (previous < 'Z') digits.push_back(kLast);
  else digits.pop_back();
  return previous + digits;
}

}

bool isOrderKey(std::string_view key) {
  try {
    requireKey(key);
    return true;
  } catch (const OrderKeyError&) {
    return false;
  }
}

std::string between(const std::optional<std::string>& a, const std::optional<std::string>& b) {
  if (a) requireKey(*a);
  if (b) requireKey(*b);
  if (a && b && *a >= *b) throw OrderKeyError("the ends are not ascending");
  if (!a && !b) return std::string{'a', kZero};

  if (!a) {
    const std::string integer = integerPart(*b);
    if (integer == smallestInteger()) return integer + midpoint("", std::string_view(*b).substr(integer.size()));
    if (integer < *b) return integer;
    const std::optional<std::string> lower = stepInteger(integer, -1);
    if (!lower) throw OrderKeyError("no key sorts below the smallest");
    return *lower;
  }

  const std::string integerA = integerPart(*a);
  const std::string_view fractionA = std::string_view(*a).substr(integerA.size());
  if (!b) {
    const std::optional<std::string> higher = stepInteger(integerA, +1);
    return higher ? *higher : integerA + midpoint(fractionA, std::nullopt);
  }

  const std::string integerB = integerPart(*b);
  if (integerA == integerB) return integerA + midpoint(fractionA, std::string_view(*b).substr(integerB.size()));
  const std::optional<std::string> higher = stepInteger(integerA, +1);
  if (!higher) throw OrderKeyError("no key sorts above the largest");
  if (*higher < *b) return *higher;
  return integerA + midpoint(fractionA, std::nullopt);
}

std::string dropKey(const std::vector<OrderedMember>& stored, const std::vector<OrderedMember>& drawn, std::string_view moved,
                    const std::optional<std::string>& above) {
  std::vector<OrderedMember> others;
  std::copy_if(stored.begin(), stored.end(), std::back_inserter(others), [moved](const OrderedMember& member) { return member.id != moved; });
  std::sort(others.begin(), others.end());
  if (!above) return between(std::nullopt, others.empty() ? std::nullopt : std::optional(others.front().key));

  auto keyIn = [&above](const std::vector<OrderedMember>& list) -> std::optional<std::string> {
    const auto found = std::find_if(list.begin(), list.end(), [&above](const OrderedMember& member) { return member.id == *above; });
    if (found == list.end()) return std::nullopt;
    return found->key;
  };
  std::optional<std::string> anchor = keyIn(drawn);
  if (!anchor) anchor = keyIn(others);
  if (!anchor) throw OrderKeyError("the drop anchor is not in the list");
  const auto successor = std::find_if(others.begin(), others.end(), [&anchor](const OrderedMember& member) { return member.key > *anchor; });
  return between(anchor, successor == others.end() ? std::nullopt : std::optional(successor->key));
}

}
