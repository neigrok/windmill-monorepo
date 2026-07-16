#pragma once

#include "domain/Auth.h"
#include "ports/AuthRepository.h"
#include "ports/Clock.h"
#include "ports/EmailSender.h"
#include "ports/TokenGenerator.h"

#include <cstddef>
#include <optional>
#include <string>

namespace wm {

// Drives the magic-link lifecycle (guidelines/auth.md). Each method is a fail-fast
// pipeline: load through the repository, defer every decision to the Auth domain, persist
// the result, send the email. The service holds no policy of its own — lifetimes, limits,
// and verdicts all live in domain/Auth.
class AuthService {
public:
  AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
              std::string appBaseUrl);

  enum class RequestResult { sent, invalidEmail, rateLimited };

  // When the link carries a fork, the caller resolves the source tree's face up front (the
  // auth pipeline holds no tree dependency) and passes it here; the mail then uses the fork
  // template that names the tree. A fork whose source couldn't be read arrives undescribed
  // and falls back to the plain template — the mail never names a tree it can't see.
  struct ForkDescription {
    std::string title;
    std::size_t steps = 0;
  };
  RequestResult requestLink(const std::string& rawEmail, const std::string& forkSource = "",
                            const std::optional<ForkDescription>& forkedTree = std::nullopt);

  // On a valid link: the account (created here on first sign-in) and a fresh session secret
  // to hand back as the cookie. On any other verdict: the verdict alone, no session.
  struct SignedIn {
    User user;
    std::string sessionSecret;
  };
  struct Completion {
    LinkVerdict verdict;
    std::optional<SignedIn> signedIn;
    std::string forkSource;  // the pending fork the link carried; empty for a plain sign-in
  };
  Completion completeLink(const std::string& linkSecret);

  // Resolve a session secret to its user, rolling the 90-day window forward on each use.
  std::optional<User> authenticate(const std::string& sessionSecret);
  void signOut(const std::string& sessionSecret);

private:
  AuthRepository& repo_;
  EmailSender& email_;
  TokenGenerator& tokens_;
  Clock& clock_;
  std::string appBaseUrl_;
};

}
