#include "domain/Auth.h"

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

LinkVerdict verifyLink(bool found, bool consumed, UnixMs expiresAt, UnixMs now) {
  if (!found) return LinkVerdict::unknown;
  if (consumed) return LinkVerdict::alreadyUsed;
  if (now >= expiresAt) return LinkVerdict::expired;
  return LinkVerdict::valid;
}

}
