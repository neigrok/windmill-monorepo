#include "domain/Auth.h"

#include <algorithm>
#include <cctype>

namespace wm {

std::optional<Email> parseEmail(const std::string& raw) {
  const std::size_t begin = raw.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) return std::nullopt;
  const std::size_t end = raw.find_last_not_of(" \t\r\n");

  std::string lower;
  lower.reserve(end - begin + 1);
  for (std::size_t i = begin; i <= end; ++i) {
    const unsigned char c = static_cast<unsigned char>(raw[i]);
    if (std::isspace(c)) return std::nullopt;  // interior whitespace is never an address
    lower.push_back(static_cast<char>(std::tolower(c)));
  }

  const std::size_t at = lower.find('@');
  if (at == std::string::npos || lower.find('@', at + 1) != std::string::npos) return std::nullopt;
  const std::string domain = lower.substr(at + 1);
  if (at == 0 || domain.empty()) return std::nullopt;                 // local and domain both present
  if (domain.front() == '.' || domain.back() == '.') return std::nullopt;
  if (domain.find('.') == std::string::npos) return std::nullopt;     // "unfinished ending" — needs a dot
  return Email{lower};
}

std::string nameFromEmail(const Email& email) {
  return email.value.substr(0, email.value.find('@'));
}

std::string sharableName(const User& user) {
  // Case-insensitively: an address is stored lowercased but a name is not, so a Google profile
  // reading "Sam.Gold" over sam.gold@example.com is the same derivation wearing different case,
  // and an exact match would wave it straight through to strangers.
  const std::string derived = nameFromEmail(user.email);
  const bool isDerived =
      user.name.size() == derived.size() &&
      std::equal(user.name.begin(), user.name.end(), derived.begin(), [](unsigned char a, unsigned char b) {
        return std::tolower(a) == std::tolower(b);
      });
  if (isDerived) return {};
  return user.name;
}

// A name is shown to other people, so it has to survive being pasted into a line of text without
// rearranging it: no control characters, and none of the Unicode bidi or invisible-formatting
// marks (U+200E/200F, U+202A-202E, U+2066-2069) that can reverse or hide whatever follows.
bool isDisplayable(const std::string& name) {
  for (std::size_t i = 0; i < name.size(); ++i) {
    const unsigned char lead = name[i];
    if (lead < 0x20 || lead == 0x7f) return false;
    if (lead == 0xc2 && i + 1 < name.size() && static_cast<unsigned char>(name[i + 1]) <= 0x9f)
      return false;  // U+0080-U+009F, the C1 controls, equally invisible
    if (lead != 0xe2 || i + 2 >= name.size()) continue;
    const unsigned char second = name[i + 1], third = name[i + 2];
    if (second == 0x80 && (third == 0x8e || third == 0x8f || (third >= 0xaa && third <= 0xae))) return false;
    if (second == 0x81 && third >= 0xa6 && third <= 0xa9) return false;
  }
  return true;
}

std::optional<std::string> parseName(const std::string& raw) {
  const std::size_t begin = raw.find_first_not_of(" \t\r\n");
  if (begin == std::string::npos) return std::nullopt;  // blank once trimmed
  const std::size_t end = raw.find_last_not_of(" \t\r\n");
  std::string trimmed = raw.substr(begin, end - begin + 1);
  if (!nameWithinLimit(trimmed)) return std::nullopt;
  if (!isDisplayable(trimmed)) return std::nullopt;
  return trimmed;
}

LinkVerdict verifyLink(bool found, bool consumed, UnixMs expiresAt, UnixMs now) {
  if (!found) return LinkVerdict::unknown;
  if (consumed) return LinkVerdict::alreadyUsed;
  if (now >= expiresAt) return LinkVerdict::expired;
  return LinkVerdict::valid;
}

}
