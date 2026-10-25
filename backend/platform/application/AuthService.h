#pragma once

#include "platform/application/OAuthService.h"
#include "platform/domain/Auth.h"
#include "platform/ports/AccountFootprint.h"
#include "platform/ports/AuthRepository.h"
#include "platform/ports/Clock.h"
#include "platform/ports/EmailSender.h"
#include "platform/ports/SessionRevocations.h"
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
// domain/Auth. Every session it revokes is told to `revocations` once its row is gone. A close is
// revived by a sign-in within its grace; past it, the account is erased, by the sign-in that meets
// it first or by eraseFinalCloses.
class AuthService {
public:
  AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
              OAuthService& oauth, AccountFootprint& footprint, SessionRevocations& revocations,
              std::string appBaseUrl);

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
  // A within-grace sign-in clears the close before the session is minted; past the grace the old
  // account is erased and the sign-in starts a new one.
  Completion completeLink(const std::string& linkSecret, const SessionContext& ctx = {});

  // Resolves the newest live code row for the address; spends an attempt on a wrong guess, burns
  // the row on a right one.
  struct CodeCompletion {
    CodeVerdict verdict;
    std::optional<SignedIn> signedIn;
    std::string forkSource;  // a pending fork rides the row whichever credential spends it
    AppleTicketOutcome appleOutcome = AppleTicketOutcome::completed;
    bool appleAttached = false;
  };
  CodeCompletion completeCode(const std::string& rawEmail, const std::string& code,
                              const SessionContext& ctx = {},
                              const std::optional<std::string>& appleTicket = std::nullopt);

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

  struct AppleStart {
    std::optional<ProviderSignIn> signIn;
    std::string ticket;
    UnixMs expiresAt = 0;
  };
  AppleStart beginApple(const ProviderIdentity& identity, const SessionContext& ctx = {});
  struct AppleCreation {
    AppleTicketOutcome outcome;
    std::optional<ProviderSignIn> signIn;
  };
  AppleCreation createApple(const std::string& ticket, const SessionContext& ctx = {});
  std::vector<SignInMethod> signInMethods(const UserId& userId);
  bool removeApple(const UserId& userId);

  // Apple can leave another account only when its footprint is empty.
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
  AccountCloseResult closeAccount(const UserId& userId, const std::string& operationId,
      const std::string& proof, UnixMs requestedAt, const std::string& sessionSecret);
  ClosureReceipt closureReceipt(const UserId& userId, const std::string& operationId,
      const std::string& proof, UnixMs requestedAt);

  // Erases accounts whose close is final, the earliest first and at most `limit`, each with every
  // database row any product keys to it. Answers how many went; one that fails is reported and the
  // rest still go.
  int eraseFinalCloses(int limit);

private:
  // Find-or-create by email, revive a within-grace close, mint and persist a session.
  SignedIn mintSessionFor(const Email& email, const std::string& name, const SessionContext& ctx,
                          UnixMs now);
  // The account a sign-in opens: `found`, its within-grace close cleared first. nullopt when there
  // is none, or when its close is final and it was erased here.
  std::optional<User> standing(std::optional<User> found, UnixMs now);
  // `found`, unless its close is final: then it is erased here and nothing is left to find.
  std::optional<User> unlessFinal(std::optional<User> found, UnixMs now);
  // `door` is who met the final close: a sign-in ("server-origin") or the sweep ("background").
  bool erase(const UserId& userId, UnixMs now, const std::string& door);
  SignedIn mintSession(const User& user, const SessionContext& ctx, UnixMs now);

  AuthRepository& repo_;
  EmailSender& email_;
  TokenGenerator& tokens_;
  Clock& clock_;
  OAuthService& oauth_;
  AccountFootprint& footprint_;
  SessionRevocations& revocations_;
  std::string appBaseUrl_;
};

}
