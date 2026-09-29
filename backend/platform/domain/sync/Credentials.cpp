#include "platform/domain/sync/Credentials.h"

#include "platform/domain/sync/Wire.h"

#include <algorithm>
#include <string_view>

namespace wm::sync {

namespace {

// RFC 9110 OWS and RFC 6265 WSP: space and tab, and no other byte.
bool isWhitespace(char c) {
  return c == ' ' || c == '\t';
}

std::string_view trimmed(std::string_view text) {
  while (!text.empty() && isWhitespace(text.front())) text.remove_prefix(1);
  while (!text.empty() && isWhitespace(text.back())) text.remove_suffix(1);
  return text;
}

char asciiLower(char c) {
  return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
}

// Header names and the Bearer scheme fold ASCII letters alone: `CooKie`, with a Kelvin sign, names another header.
bool equalsIgnoringAsciiCase(std::string_view text, std::string_view lowerCase) {
  return text.size() == lowerCase.size() &&
         std::equal(text.begin(), text.end(), lowerCase.begin(), [](char a, char b) { return asciiLower(a) == b; });
}

// `Bearer <token>`: the scheme in any case, one space, and a token holding no whitespace.
std::optional<std::string> bearerToken(std::string_view value) {
  constexpr std::string_view scheme = "bearer";
  if (value.size() < scheme.size() + 2 || !equalsIgnoringAsciiCase(value.substr(0, scheme.size()), scheme) || value[scheme.size()] != ' ')
    return std::nullopt;
  const std::string_view token = value.substr(scheme.size() + 1);
  if (std::any_of(token.begin(), token.end(), isWhitespace)) return std::nullopt;
  return std::string(token);
}

}

SentCredentials SentCredentials::fromOccurrences(const HeaderOccurrences& occurrences) {
  std::vector<SentCredential> each;
  for (const auto& [name, rawValue] : occurrences) {
    const std::string_view value = trimmed(rawValue);
    if (equalsIgnoringAsciiCase(name, "authorization")) each.push_back({SentCredential::Kind::authorization, bearerToken(value)});
    if (!equalsIgnoringAsciiCase(name, "cookie")) continue;
    std::string_view pieces = value;
    while (true) {
      const std::size_t end = pieces.find(';');
      const std::string_view piece = pieces.substr(0, end);
      const std::size_t equals = piece.find('=');
      if (trimmed(piece.substr(0, equals)) == kSessionCookie) {
        const std::string_view token = equals == std::string_view::npos ? std::string_view() : trimmed(piece.substr(equals + 1));
        each.push_back({SentCredential::Kind::cookie, token.empty() ? std::nullopt : std::optional(std::string(token))});
      }
      if (end == std::string_view::npos) break;
      pieces.remove_prefix(end + 1);
    }
  }
  return SentCredentials(std::move(each));
}

SentCredentials SentCredentials::withTokens(const std::function<std::string(const std::string& token)>& replace) const {
  std::vector<SentCredential> replaced = each_;
  for (SentCredential& credential : replaced) {
    if (credential.token) credential.token = replace(*credential.token);
  }
  return SentCredentials(std::move(replaced));
}

Credential SentCredentials::resolve(const ResolveToken& resolve) const {
  if (each_.empty()) return Credential::none();
  const auto ofKind = [this](SentCredential::Kind kind) {
    return std::count_if(each_.begin(), each_.end(), [kind](const SentCredential& credential) { return credential.kind == kind; });
  };
  if (ofKind(SentCredential::Kind::authorization) > 1 || ofKind(SentCredential::Kind::cookie) > 1) return Credential::sent(std::nullopt);
  std::optional<UserId> account;
  for (const SentCredential& credential : each_) {
    const std::optional<UserId> resolved = credential.token ? resolve(*credential.token) : std::nullopt;
    if (!resolved || (account && *account != *resolved)) return Credential::sent(std::nullopt);
    account = resolved;
  }
  return Credential::sent(account);
}

Credential::Credential(bool sent, std::optional<UserId> account) : sent_(sent), account_(std::move(account)) {}

Credential Credential::none() {
  return Credential(false, std::nullopt);
}

Credential Credential::sent(std::optional<UserId> account) {
  return Credential(true, std::move(account));
}

bool Credential::fails() const {
  return sent_ && (!account_ || !isAccountId(account_->str()));
}

}
