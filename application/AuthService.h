#pragma once

#include "domain/Auth.h"
#include "ports/AuthRepository.h"
#include "ports/Clock.h"
#include "ports/EmailSender.h"
#include "ports/TokenGenerator.h"

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
  RequestResult requestLink(const std::string& rawEmail, const std::string& forkSource = "");

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
