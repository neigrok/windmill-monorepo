#include "platform/domain/sync/Credentials.h"

#include "platform/domain/sync/Wire.h"

#include <algorithm>
#include <cctype>
#include <string_view>

namespace wm::sync {

namespace {

// The whitespace the reference reads a header by (String.prototype.trim and \s, over a header decoded as Latin-1): space,
// tab, line feed, vertical tab, form feed, carriage return and the no-break space 0xA0.
bool isSpace(char c) {
  return c == ' ' || (c >= '\t' && c <= '\r') || static_cast<unsigned char>(c) == 0xA0;
}

std::string_view trimmed(std::string_view text) {
  while (!text.empty() && isSpace(text.front())) text.remove_prefix(1);
  while (!text.empty() && isSpace(text.back())) text.remove_suffix(1);
  return text;
}

bool equalsIgnoringCase(std::string_view a, std::string_view b) {
  return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
           return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
         });
}

// `Bearer <token>`: the scheme in any case, one space, and a token holding no whitespace.
std::optional<std::string> bearerToken(std::string_view value) {
  constexpr std::string_view scheme = "Bearer";
  if (value.size() < scheme.size() + 2 || !equalsIgnoringCase(value.substr(0, scheme.size()), scheme) || value[scheme.size()] != ' ')
    return std::nullopt;
  const std::string_view token = value.substr(scheme.size() + 1);
  if (std::any_of(token.begin(), token.end(), isSpace)) return std::nullopt;
  return std::string(token);
}

}

std::vector<SentCredential> sentCredentialsOf(const HeaderFields& headers) {
  std::vector<SentCredential> sent;
  for (const auto& [name, value] : headers) {
    if (equalsIgnoringCase(name, "authorization")) sent.push_back({SentCredential::Kind::authorization, bearerToken(value)});
    if (!equalsIgnoringCase(name, "cookie")) continue;
    std::string_view pieces = value;
    while (true) {
      const std::size_t end = pieces.find(';');
      const std::string_view piece = trimmed(pieces.substr(0, end));
      const std::size_t equals = piece.find('=');
      if (trimmed(piece.substr(0, equals)) == kSessionCookie) {
        const std::string_view token = equals == std::string_view::npos ? std::string_view() : piece.substr(equals + 1);
        sent.push_back({SentCredential::Kind::cookie, token.empty() ? std::nullopt : std::optional(std::string(token))});
      }
      if (end == std::string_view::npos) break;
      pieces.remove_prefix(end + 1);
    }
  }
  return sent;
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

Credential credentialOf(const std::vector<SentCredential>& sent, const ResolveToken& resolve) {
  if (sent.empty()) return Credential::none();
  const auto ofKind = [&sent](SentCredential::Kind kind) {
    return std::count_if(sent.begin(), sent.end(), [kind](const SentCredential& credential) { return credential.kind == kind; });
  };
  if (ofKind(SentCredential::Kind::authorization) > 1 || ofKind(SentCredential::Kind::cookie) > 1) return Credential::sent(std::nullopt);
  std::optional<UserId> account;
  for (const SentCredential& credential : sent) {
    const std::optional<UserId> resolved = credential.token ? resolve(*credential.token) : std::nullopt;
    if (!resolved || (account && *account != *resolved)) return Credential::sent(std::nullopt);
    account = resolved;
  }
  return Credential::sent(account);
}

}
