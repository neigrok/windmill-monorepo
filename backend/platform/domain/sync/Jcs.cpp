#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <optional>
#include <utility>
#include <vector>

#include <locale.h>
#include <stdlib.h>
#if __has_include(<xlocale.h>)
#include <xlocale.h>
#endif

namespace wm::sync {

namespace {

// The code points of a UTF-8 text, or nothing when it is not UTF-8: a truncated or overlong sequence,
// a surrogate, or a value past U+10FFFF.
std::optional<std::u32string> codePoints(std::string_view text) {
  static constexpr char32_t kSmallest[] = {0, 0, 0x80, 0x800, 0x10000};
  std::u32string points;
  for (std::size_t at = 0; at < text.size();) {
    const auto lead = static_cast<unsigned char>(text[at]);
    const std::size_t length = lead < 0x80 ? 1 : (lead >> 5) == 0x6 ? 2 : (lead >> 4) == 0xE ? 3 : (lead >> 3) == 0x1E ? 4 : 0;
    if (length == 0 || at + length > text.size()) return std::nullopt;
    char32_t point = length == 1 ? lead : lead & (0x7F >> length);
    for (std::size_t k = 1; k < length; ++k) {
      const auto next = static_cast<unsigned char>(text[at + k]);
      if ((next & 0xC0) != 0x80) return std::nullopt;
      point = (point << 6) | (next & 0x3F);
    }
    if (point < kSmallest[length] || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF)) return std::nullopt;
    points.push_back(point);
    at += length;
  }
  return points;
}

std::string_view stringOf(const Json::Value& value) {
  const char* begin = nullptr;
  const char* end = nullptr;
  value.getString(&begin, &end);
  return {begin, static_cast<std::size_t>(end - begin)};
}

std::u16string utf16(std::string_view key) {
  const std::optional<std::u32string> points = codePoints(key);
  std::u16string units;
  for (char32_t point : *points) {
    if (point < 0x10000) {
      units.push_back(static_cast<char16_t>(point));
      continue;
    }
    point -= 0x10000;
    units.push_back(static_cast<char16_t>(0xD800 + (point >> 10)));
    units.push_back(static_cast<char16_t>(0xDC00 + (point & 0x3FF)));
  }
  return units;
}

void requireUtf8(std::string_view text) {
  if (!codePoints(text)) throw JsonError("a JSON string is not UTF-8");
}

// ECMAScript Number::toString over the shortest digits that round-trip the double: plain notation for
// exponents from -7 to 20, exponent notation outside them.
std::string numberText(double number) {
  if (!std::isfinite(number)) throw JsonError("a JSON number is finite");
  if (number == 0) return "0";

  char buffer[32];
  const std::to_chars_result shortest = std::to_chars(buffer, buffer + sizeof buffer, number, std::chars_format::scientific);
  std::string_view scientific(buffer, static_cast<std::size_t>(shortest.ptr - buffer));
  const std::string sign = scientific.front() == '-' ? "-" : "";
  scientific.remove_prefix(sign.size());

  const std::size_t e = scientific.find('e');
  std::string digits;
  for (char c : scientific.substr(0, e)) {
    if (c != '.') digits.push_back(c);
  }
  std::string_view exponentText = scientific.substr(e + 1);
  if (exponentText.front() == '+') exponentText.remove_prefix(1);
  int exponent = 0;
  std::from_chars(exponentText.data(), exponentText.data() + exponentText.size(), exponent);

  const int k = static_cast<int>(digits.size());
  const int n = exponent + 1;
  if (k <= n && n <= 21) return sign + digits + std::string(static_cast<std::size_t>(n - k), '0');
  if (0 < n && n <= 21) return sign + digits.substr(0, n) + "." + digits.substr(n);
  if (-6 < n && n <= 0) return sign + "0." + std::string(static_cast<std::size_t>(-n), '0') + digits;
  const std::string mantissa = k == 1 ? digits : digits.substr(0, 1) + "." + digits.substr(1);
  return sign + mantissa + "e" + (n - 1 < 0 ? "-" : "+") + std::to_string(std::abs(n - 1));
}

void appendString(std::string& out, std::string_view text) {
  requireUtf8(text);
  out.push_back('"');
  for (const char c : text) {
    switch (c) {
      case '"': out += "\\\""; continue;
      case '\\': out += "\\\\"; continue;
      case '\b': out += "\\b"; continue;
      case '\t': out += "\\t"; continue;
      case '\n': out += "\\n"; continue;
      case '\f': out += "\\f"; continue;
      case '\r': out += "\\r"; continue;
      default: break;
    }
    if (static_cast<unsigned char>(c) < 0x20) {
      char escaped[7];
      std::snprintf(escaped, sizeof escaped, "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
      out += escaped;
      continue;
    }
    out.push_back(c);
  }
  out.push_back('"');
}

void append(std::string& out, const Json::Value& value) {
  switch (value.type()) {
    case Json::nullValue: out += "null"; return;
    case Json::booleanValue: out += value.asBool() ? "true" : "false"; return;
    case Json::intValue:
    case Json::uintValue:
    case Json::realValue: out += numberText(value.asDouble()); return;
    case Json::stringValue: appendString(out, stringOf(value)); return;
    case Json::arrayValue: {
      out.push_back('[');
      for (Json::ArrayIndex i = 0; i < value.size(); ++i) {
        if (i > 0) out.push_back(',');
        append(out, value[i]);
      }
      out.push_back(']');
      return;
    }
    case Json::objectValue: {
      std::vector<std::string> keys = value.getMemberNames();
      for (const std::string& key : keys) requireUtf8(key);
      std::sort(keys.begin(), keys.end(), [](const std::string& a, const std::string& b) { return utf16(a) < utf16(b); });
      out.push_back('{');
      for (std::size_t i = 0; i < keys.size(); ++i) {
        if (i > 0) out.push_back(',');
        appendString(out, keys[i]);
        out.push_back(':');
        append(out, value[keys[i]]);
      }
      out.push_back('}');
      return;
    }
  }
}

void appendUtf8(std::string& out, char32_t point) {
  if (point < 0x80) {
    out.push_back(static_cast<char>(point));
  } else if (point < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (point >> 6)));
    out.push_back(static_cast<char>(0x80 | (point & 0x3F)));
  } else if (point < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (point >> 12)));
    out.push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (point & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (point >> 18)));
    out.push_back(static_cast<char>(0x80 | ((point >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (point & 0x3F)));
  }
}

// The C locale, so a number's '.' reads as its decimal point whatever locale the process runs under.
locale_t cLocale() {
  static const locale_t c = newlocale(LC_ALL_MASK, "C", static_cast<locale_t>(nullptr));
  return c;
}

// parseJson's reading of one text, left to right: a value, whitespace only between tokens, and nothing after it.
class StrictReader {
public:
  explicit StrictReader(std::string_view text) : text_(text) {}

  Json::Value document() {
    Json::Value value = next(0);
    skipSpace();
    if (at_ != text_.size()) fail("text follows the value");
    return value;
  }

private:
  static constexpr int kMaxDepth = 1000;

  [[noreturn]] void fail(const std::string& what) const {
    throw JsonError("not strict JSON at byte " + std::to_string(at_) + ": " + what);
  }

  bool at(char c) const { return at_ < text_.size() && text_[at_] == c; }
  bool atDigit() const { return at_ < text_.size() && text_[at_] >= '0' && text_[at_] <= '9'; }

  void skipSpace() {
    while (at(' ') || at('\t') || at('\n') || at('\r')) ++at_;
  }

  void take(char c) {
    if (!at(c)) fail(std::string("expected '") + c + "'");
    ++at_;
  }

  Json::Value next(int depth) {
    skipSpace();
    if (at_ == text_.size()) fail("a value is missing");
    switch (text_[at_]) {
      case '{': return object(depth + 1);
      case '[': return array(depth + 1);
      case '"': {
        const std::string text = string();
        return Json::Value(text.data(), text.data() + text.size());
      }
      case 't': return word("true", Json::Value(true));
      case 'f': return word("false", Json::Value(false));
      case 'n': return word("null", Json::Value());
      default: return number();
    }
  }

  Json::Value word(std::string_view spelling, Json::Value value) {
    if (text_.substr(at_, spelling.size()) != spelling) fail("not a JSON value");
    at_ += spelling.size();
    return value;
  }

  Json::Value array(int depth) {
    if (depth > kMaxDepth) fail("nested deeper than 1000");
    take('[');
    Json::Value items(Json::arrayValue);
    skipSpace();
    if (at(']')) {
      ++at_;
      return items;
    }
    while (true) {
      items.append(next(depth));
      skipSpace();
      if (at(']')) {
        ++at_;
        return items;
      }
      take(',');
    }
  }

  Json::Value object(int depth) {
    if (depth > kMaxDepth) fail("nested deeper than 1000");
    take('{');
    Json::Value members(Json::objectValue);
    skipSpace();
    if (at('}')) {
      ++at_;
      return members;
    }
    while (true) {
      skipSpace();
      if (!at('"')) fail("a key is a string");
      const std::string key = string();
      if (members.isMember(key)) fail("a key is repeated");
      skipSpace();
      take(':');
      members[key] = next(depth);
      skipSpace();
      if (at('}')) {
        ++at_;
        return members;
      }
      take(',');
    }
  }

  // A string's value, its escapes read: every control character escaped, and the value UTF-8.
  std::string string() {
    take('"');
    std::string value;
    while (true) {
      if (at_ == text_.size()) fail("a string is not closed");
      const char c = text_[at_++];
      if (c == '"') break;
      if (static_cast<unsigned char>(c) < 0x20) fail("a control character in a string is not escaped");
      if (c != '\\') {
        value.push_back(c);
        continue;
      }
      if (at_ == text_.size()) fail("a string is not closed");
      switch (const char escaped = text_[at_++]) {
        case '"':
        case '\\':
        case '/': value.push_back(escaped); break;
        case 'b': value.push_back('\b'); break;
        case 'f': value.push_back('\f'); break;
        case 'n': value.push_back('\n'); break;
        case 'r': value.push_back('\r'); break;
        case 't': value.push_back('\t'); break;
        case 'u': appendUtf8(value, escapedPoint()); break;
        default: fail("an unknown escape");
      }
    }
    requireUtf8(value);
    return value;
  }

  // The code point of a \u escape, just past its `u`: a high surrogate and the low one of the \u after it.
  char32_t escapedPoint() {
    const char32_t unit = hexUnit();
    if (unit >= 0xDC00 && unit <= 0xDFFF) fail("a low surrogate stands alone");
    if (unit < 0xD800 || unit > 0xDBFF) return unit;
    if (text_.substr(at_, 2) != "\\u") fail("a high surrogate stands alone");
    at_ += 2;
    const char32_t low = hexUnit();
    if (low < 0xDC00 || low > 0xDFFF) fail("a high surrogate stands alone");
    return 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
  }

  char32_t hexUnit() {
    std::uint32_t unit = 0;
    const char* const first = text_.data() + at_;
    const char* const last = text_.data() + std::min(at_ + 4, text_.size());
    const auto [end, error] = std::from_chars(first, last, unit, 16);
    if (error != std::errc{} || end != first + 4) fail("a \\u escape has four hex digits");
    at_ += 4;
    return unit;
  }

  // §9.1 Numbers. An integer literal that Int64 or UInt64 holds stays that integer, as jsoncpp keeps one; any other
  // literal is the double it rounds to, which must be finite, and zero only when every digit of the literal is.
  Json::Value number() {
    const std::size_t start = at_;
    if (at('-')) ++at_;
    if (at('0')) ++at_;
    else if (atDigit()) digits();
    else fail("not a JSON value");
    bool integral = true;
    if (at('.')) {
      ++at_;
      digits();
      integral = false;
    }
    const bool zero = text_.substr(start, at_ - start).find_first_of("123456789") == std::string_view::npos;
    if (at('e') || at('E')) {
      ++at_;
      if (at('+') || at('-')) ++at_;
      digits();
      integral = false;
    }
    const std::string literal(text_.substr(start, at_ - start));
    const char* const first = literal.data();
    const char* const last = first + literal.size();
    if (std::int64_t whole = 0; integral && std::from_chars(first, last, whole).ec == std::errc{}) return Json::Value(Json::Int64(whole));
    if (std::uint64_t whole = 0; integral && std::from_chars(first, last, whole).ec == std::errc{}) return Json::Value(Json::UInt64(whole));
    char* end = nullptr;
    const double value = strtod_l(first, &end, cLocale());
    if (end != last || !std::isfinite(value)) fail("a number is not a finite double");
    if (value == 0 && !zero) fail("a nonzero number rounds to zero");
    return Json::Value(value);
  }

  void digits() {
    if (!atDigit()) fail("a digit is missing");
    while (atDigit()) ++at_;
  }

  std::string_view text_;
  std::size_t at_ = 0;
};

}

std::string jcs(const Json::Value& value) {
  std::string out;
  append(out, value);
  return out;
}

Json::Value parseJson(std::string_view text) {
  return StrictReader(text).document();
}

std::strong_ordering compareJcs(const Json::Value& a, const Json::Value& b) {
  return jcs(a) <=> jcs(b);
}

}
