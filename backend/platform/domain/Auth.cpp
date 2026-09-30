#include "platform/domain/Auth.h"

#include <algorithm>
#include <cctype>
#include <stdexcept>

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
  // Compared case-insensitively: an address is stored lowercased but a name is not.
  const std::string derived = nameFromEmail(user.email);
  const bool isDerived =
      user.name.size() == derived.size() &&
      std::equal(user.name.begin(), user.name.end(), derived.begin(), [](unsigned char a, unsigned char b) {
        return std::tolower(a) == std::tolower(b);
      });
  if (isDerived) return {};
  return user.name;
}

// Rejects control characters and the Unicode bidi / invisible-formatting marks (U+200E/200F,
// U+202A-202E, U+2066-2069) that can reverse or hide whatever follows.
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

CodeVerdict verifyCode(bool foundLive, bool matches) {
  if (!foundLive) return CodeVerdict::noLiveCode;  // a match against no live row is no match
  if (!matches) return CodeVerdict::wrongCode;
  return CodeVerdict::valid;
}

std::string toString(Provider provider) {
  return provider == Provider::apple ? "apple" : "google";
}

std::optional<Provider> parseProvider(std::string_view raw) {
  if (raw == "google") return Provider::google;
  if (raw == "apple") return Provider::apple;
  return std::nullopt;
}

bool isPrivateRelay(const Email& email) {
  static constexpr std::string_view suffix = "@privaterelay.appleid.com";
  // parseEmail has already lowercased, so a plain suffix match is the whole test.
  return email.value.size() > suffix.size() && email.value.ends_with(suffix);
}

AddressTrust trustOf(const ProviderIdentity& identity) {
  if (!identity.emailVerified) return AddressTrust::unusable;
  if (!parseEmail(identity.email.value)) return AddressTrust::unusable;
  if (identity.relayEmail || isPrivateRelay(identity.email)) return AddressTrust::appOnly;
  return AddressTrust::crossDoor;
}

namespace {

std::string_view trimmedOfSpaceAndTab(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
  return text;
}

// The scope a browser files a cookie under for a Domain: no leading dot, lower case (RFC 6265 §5.2.3).
std::string cookieScopeOf(std::string_view domain) {
  if (domain.starts_with('.')) domain.remove_prefix(1);
  std::string scope(domain);
  std::transform(scope.begin(), scope.end(), scope.begin(), [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; });
  return scope;
}

bool isHostNameByte(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.';
}

// The WHATWG URL host parser reads a name whose last label is a number (decimal, or hex after 0x) as an IPv4 address.
bool endsInANumber(std::string_view host) {
  std::string_view last = host.substr(host.rfind('.') + 1);
  if (last.starts_with("0x") || last.starts_with("0X")) {
    last.remove_prefix(2);
    return std::all_of(last.begin(), last.end(), [](char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; });
  }
  return !last.empty() && std::all_of(last.begin(), last.end(), [](char c) { return c >= '0' && c <= '9'; });
}

}

std::optional<std::string> SessionCookieScopes::refusalOf(std::string_view domain) {
  const std::string_view trimmed = trimmedOfSpaceAndTab(domain);
  if (trimmed.empty()) return std::nullopt;
  const std::string quoted = "\"" + std::string(domain) + "\"";
  if (trimmed.starts_with('[') || std::count(trimmed.begin(), trimmed.end(), ':') > 1) return quoted + " is an IP address";
  if (!std::all_of(trimmed.begin(), trimmed.end(), isHostNameByte)) return quoted + " is not a bare host name";
  const std::string_view host = trimmed.starts_with('.') ? trimmed.substr(1) : trimmed;
  if (host.empty() || host.starts_with('.') || host.ends_with('.') || host.find("..") != std::string_view::npos)
    return quoted + " has an empty label";
  if (host.find('.') == std::string_view::npos) return quoted + " is a single label, with no registrable domain";
  if (endsInANumber(host)) return quoted + " is an IP address";
  if (cookieScopeOf(host.substr(host.rfind('.') + 1)) == "localhost") return quoted + " ends in the label localhost, with no registrable domain";
  return std::nullopt;
}

SessionCookieScopes::SessionCookieScopes(std::string_view domain, std::string_view retiredDomains) {
  std::vector<std::string_view> named{domain, ""};
  for (std::size_t start = 0; start <= retiredDomains.size();) {
    const std::size_t comma = std::min(retiredDomains.find(',', start), retiredDomains.size());
    named.push_back(retiredDomains.substr(start, comma - start));
    start = comma + 1;
  }
  for (const std::string_view entry : named) {
    if (const std::optional<std::string> refusal = refusalOf(entry)) throw std::invalid_argument("the session cookie's Domain " + *refusal);
    const std::string scope(trimmedOfSpaceAndTab(entry));
    const bool known = std::any_of(scopes_.begin(), scopes_.end(), [&scope](const std::string& kept) { return cookieScopeOf(kept) == cookieScopeOf(scope); });
    if (!known) scopes_.push_back(scope);
  }
}

}
