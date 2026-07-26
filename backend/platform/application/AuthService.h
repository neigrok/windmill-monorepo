#pragma once

#include "platform/application/OAuthService.h"
#include "platform/domain/Auth.h"
#include "platform/ports/AuthRepository.h"
#include "platform/ports/Clock.h"
#include "platform/ports/EmailSender.h"
#include "platform/ports/TokenGenerator.h"

#include <cstddef>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// What the request tells us about the device behind a session: its user-agent and IP, raw.
// Threaded into a new session at sign-in and healed onto an existing row on each use; empty
// fields leave the stored values untouched.
struct SessionContext {
  std::string userAgent;
  std::string ip;
};

// One row of the settings §5 sessions list, dressed for the API: the private digest is gone
// and `current` marks the caller's own session. lastSeenMs is already coalesced.
struct SessionView {
  std::string id;
  std::string userAgent;
  UnixMs lastSeenMs = 0;
  UnixMs createdMs = 0;
  std::string ip;
  bool current = false;
};

// Drives the magic-link lifecycle (guidelines/auth.md) and the settings §5 account surface
// (profile, sessions, close). Each method is a fail-fast pipeline: load through the
// repository, defer every decision to the Auth domain, persist the result. The service holds
// no policy of its own — lifetimes, limits, the name cap, and the close grace live in
// domain/Auth. Closing an account is where auth meets OAuth: it delegates the tool teardown
// to OAuthService, so a close leaves no live access anywhere.
class AuthService {
public:
  AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
              OAuthService& oauth, std::string appBaseUrl);

  enum class RequestResult { sent, invalidEmail, rateLimited, unreachable };

  // When the link carries a fork, the caller resolves the source tree's face up front (the
  // auth pipeline holds no tree dependency) and passes it here; the mail then uses the fork
  // template that names the tree. A fork whose source couldn't be read arrives undescribed
  // and falls back to the plain template — the mail never names a tree it can't see.
  struct ForkDescription {
    std::string title;
    std::size_t steps = 0;
  };
  // Asynchronous, so the slow Resend send never parks the calling handler thread. The sync
  // work runs first and fast — parse, rate-limit, mint, insert the link row — then only the
  // send is deferred. done fires exactly once with the verdict: invalidEmail / rateLimited
  // resolve inline before any send; sent or unreachable waits on the send's completion (which
  // may fire on the sender's loop thread). An unreachable send still leaves the link row
  // inserted, so a Resend hiccup loses no link — a retry mints a fresh one and the first
  // still opens the door for its 15-minute life.
  void requestLink(const std::string& rawEmail, const std::string& forkSource,
                   const std::optional<ForkDescription>& forkedTree,
                   std::function<void(RequestResult)> done);

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
  // The load-bearing revival point: a within-grace sign-in clears the close before the
  // session is minted, so signing in is the undo. The new session is born with the device's
  // metadata (ctx).
  Completion completeLink(const std::string& linkSecret, const SessionContext& ctx = {});

  // Sign in a Google-verified identity. The email is resolved to an account the same way a magic
  // link is — found or created, revived if within its close grace — so a Google email and a
  // magic-link email that match land on ONE account (users.email is unique), with no new provider
  // state. The caller must have proven the email is Google-verified before calling this.
  SignedIn completeGoogle(const Email& verifiedEmail, const std::string& name,
                          const SessionContext& ctx = {});

  // Resolve a session secret to its user, rolling the 90-day window forward on each use and
  // healing the row's metadata from ctx. A closed account is refused (nullopt) even if a
  // stale session row somehow survives — defense in depth behind the close's session sweep.
  std::optional<User> authenticate(const std::string& sessionSecret, const SessionContext& ctx = {});

  // The same check keyed by the session's DIGEST rather than its secret — for a long-lived
  // connection that must keep proving its session is still good without holding the raw secret in
  // memory for hours. digestOf turns a secret into that key once, at the point it arrives.
  std::string digestOf(const std::string& sessionSecret);
  std::optional<User> revalidate(const std::string& digest, const SessionContext& ctx = {});
  void signOut(const std::string& sessionSecret);

  // Settings §5 profile: rename the account. nullopt is a blank or over-cap name (a 400); the
  // updated user otherwise.
  std::optional<User> updateName(const UserId& userId, const std::string& rawName);

  // Settings §5 sessions: the user's live sessions, the caller's own flagged `current`.
  std::vector<SessionView> listSessions(const UserId& userId, const std::string& currentSecret);

  // Revoke one session by id. `revokedCurrent` tells the edge to also clear the cookie;
  // `notFound` is a foreign or unknown id (a 404).
  enum class RevokeOutcome { revoked, revokedCurrent, notFound };
  RevokeOutcome revokeSession(const UserId& userId, const std::string& sessionId,
                              const std::string& currentSecret);

  // "Sign out everywhere": every session but the caller's own current one.
  void signOutEverywhere(const UserId& userId, const std::string& currentSecret);

  // Settings §4 close: stamp the soft close, drop every session, disconnect every tool.
  // Returns the instant the account finally closes (the 30-day grace's end).
  UnixMs closeAccount(const UserId& userId);

private:
  // The shared session-mint tail behind both doors: find-or-create the user by email, revive a
  // within-grace closed account, then mint + persist a session. Every sign-in path funnels here so
  // the revival rule and account-linking-by-email hold identically.
  SignedIn mintSessionFor(const Email& email, const std::string& name, const SessionContext& ctx,
                          UnixMs now);

  AuthRepository& repo_;
  EmailSender& email_;
  TokenGenerator& tokens_;
  Clock& clock_;
  OAuthService& oauth_;
  std::string appBaseUrl_;
};

}
