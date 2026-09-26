#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

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

// jsoncpp reads a number past the double range as infinity rather than failing.
void requireJsonText(const Json::Value& value) {
  if (value.isDouble() && !std::isfinite(value.asDouble())) throw JsonError("a JSON number is finite");
  if (value.isString()) requireUtf8(stringOf(value));
  if (value.isArray()) {
    for (const Json::Value& item : value) requireJsonText(item);
  }
  if (value.isObject()) {
    for (const std::string& key : value.getMemberNames()) {
      requireUtf8(key);
      requireJsonText(value[key]);
    }
  }
}

}

std::string jcs(const Json::Value& value) {
  std::string out;
  append(out, value);
  return out;
}

Json::Value parseJson(std::string_view text) {
  Json::CharReaderBuilder builder;
  Json::CharReaderBuilder::strictMode(&builder.settings_);
  builder.settings_["strictRoot"] = false;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());

  Json::Value value;
  std::string errors;
  if (!reader->parse(text.data(), text.data() + text.size(), &value, &errors)) throw JsonError("not strict JSON: " + errors);
  requireJsonText(value);
  return value;
}

std::strong_ordering compareJcs(const Json::Value& a, const Json::Value& b) {
  return jcs(a) <=> jcs(b);
}

}
