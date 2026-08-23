#pragma once

#include "platform/application/OAuthService.h"
#include "platform/domain/Auth.h"
#include "platform/ports/AccountFootprint.h"
#include "platform/ports/AuthRepository.h"
#include "platform/ports/Clock.h"
#include "platform/ports/EmailSender.h"
#include "platform/ports/SignupFork.h"  // ForkDescription
#include "platform/ports/TokenGenerator.h"

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// Empty fields leave the stored values untouched.
struct SessionContext {
  std::string userAgent;
  std::string ip;
};

// The API shape: no digest; lastSeenMs already coalesced.
struct SessionView {
  std::string id;
  std::string userAgent;
  UnixMs lastSeenMs = 0;
  UnixMs createdMs = 0;
  std::string ip;
  bool current = false;
};

// Holds no policy of its own: lifetimes, limits, the name cap and the close grace live in
// domain/Auth.
class AuthService {
public:
  AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
              OAuthService& oauth, AccountFootprint& footprint, std::string appBaseUrl);

  enum class RequestResult { sent, invalidEmail, rateLimited, unreachable };

  // `forkDescription` arrives already rendered. Only the send is deferred; `done` fires exactly
  // once and may fire on the sender's loop thread. An unreachable send still leaves the row
  // inserted, so both credentials stay usable. `door` == "app" mails the code, anything else the
  // link.
  void requestLink(const std::string& rawEmail, const std::string& forkSource,
                   const std::optional<ForkDescription>& forkDescription, const std::string& door,
                   std::function<void(RequestResult)> done);

  // The account is created here on first sign-in; any verdict but valid carries no session.
  struct SignedIn {
    User user;
    std::string sessionSecret;
  };
  struct Completion {
    LinkVerdict verdict;
    std::optional<SignedIn> signedIn;
    std::string forkSource;  // the pending fork the link carried; empty for a plain sign-in
  };
  // A within-grace sign-in clears the close before the session is minted.
  Completion completeLink(const std::string& linkSecret, const SessionContext& ctx = {});

  // Resolves the newest live code row for the address; spends an attempt on a wrong guess, burns
  // the row on a right one.
  struct CodeCompletion {
    CodeVerdict verdict;
    std::optional<SignedIn> signedIn;
    std::string forkSource;  // a pending fork rides the row whichever credential spends it
  };
  CodeCompletion completeCode(const std::string& rawEmail, const std::string& code,
                              const SessionContext& ctx = {});

  // `privateEmail`: the address behind the identity is a provider relay.
  struct ProviderSignIn {
    SignedIn signedIn;
    bool created = false;
    bool privateEmail = false;
  };
  // Caller must have proven the identity with the provider first. The subject resolves the account
  // outright; only when no door is bound may the verified address find one. nullopt is a refused
  // identity, never a storage failure.
  std::optional<ProviderSignIn> completeProvider(const ProviderIdentity& identity,
                                                 const SessionContext& ctx = {});

  // A door already bound to another account is refused, never stolen.
  enum class AttachOutcome { attached, alreadyMine, takenByAnother, refused };
  AttachOutcome attachIdentity(const UserId& userId, const ProviderIdentity& identity);

  // Refused unless the caller's account holds nothing. `linked` carries a session for the surviving
  // account.
  enum class LinkOutcome { linked, sameAccount, notEmpty, badLink };
  struct LinkResult {
    LinkOutcome outcome;
    std::optional<SignedIn> signedIn;
  };
  LinkResult linkAccount(const UserId& caller, const std::string& linkSecret,
                         const SessionContext& ctx = {});

  // Rolls the session window forward and heals the row's metadata from ctx. A closed account is
  // refused even if a stale session row survives.
  std::optional<User> authenticate(const std::string& sessionSecret, const SessionContext& ctx = {});

  // The same check keyed by digest, for connections that must not hold the raw secret.
  std::string digestOf(const std::string& sessionSecret);
  std::optional<User> revalidate(const std::string& digest, const SessionContext& ctx = {});
  void signOut(const std::string& sessionSecret);

  // nullopt is a blank or over-cap name; the updated user otherwise.
  std::optional<User> updateName(const UserId& userId, const std::string& rawName);

  std::vector<SessionView> listSessions(const UserId& userId, const std::string& currentSecret);

  // `revokedCurrent` tells the edge to also clear the cookie; `notFound` is a foreign or unknown id.
  enum class RevokeOutcome { revoked, revokedCurrent, notFound };
  RevokeOutcome revokeSession(const UserId& userId, const std::string& sessionId,
                              const std::string& currentSecret);

  // Every session but the caller's own current one.
  void signOutEverywhere(const UserId& userId, const std::string& currentSecret);

  // Drops every session and disconnects every tool. Returns the instant the account finally closes.
  UnixMs closeAccount(const UserId& userId);

private:
  // Find-or-create by email, revive a within-grace close, mint and persist a session.
  SignedIn mintSessionFor(const Email& email, const std::string& name, const SessionContext& ctx,
                          UnixMs now);
  // A within-grace close clears before any session is minted onto it.
  User revived(User user);
  SignedIn mintSession(const User& user, const SessionContext& ctx, UnixMs now);

  AuthRepository& repo_;
  EmailSender& email_;
  TokenGenerator& tokens_;
  Clock& clock_;
  OAuthService& oauth_;
  AccountFootprint& footprint_;
  std::string appBaseUrl_;
};

}
