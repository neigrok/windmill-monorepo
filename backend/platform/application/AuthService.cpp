#include "platform/application/AuthService.h"

namespace wm {

AuthService::AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
                         OAuthService& oauth, std::string appBaseUrl)
    : repo_(repo), email_(email), tokens_(tokens), clock_(clock), oauth_(oauth),
      appBaseUrl_(std::move(appBaseUrl)) {}

void AuthService::requestLink(const std::string& rawEmail, const std::string& forkSource,
                              const std::optional<ForkDescription>& forkedTree,
                              std::function<void(RequestResult)> done) {
  std::optional<Email> email = parseEmail(rawEmail);
  if (!email) {
    done(RequestResult::invalidEmail);
    return;
  }

  const UnixMs now = clock_.nowMs();
  if (!withinRateLimit(repo_.countRecentLinks(*email, now - AuthPolicy::rateWindowMs))) {
    done(RequestResult::rateLimited);
    return;
  }

  const MintedToken link = tokens_.mint();
  repo_.insertLink(link.digest, *email, now, linkExpiry(now), forkSource);

  // The link row is already persisted; only the slow send is deferred. Its outcome is the
  // last verdict — a 2xx is sent, a failure is unreachable — but the link stands either way,
  // so an unreachable send is still a usable link the user can reach on a retry.
  const std::string url = appBaseUrl_ + "/#/auth?token=" + link.secret;
  auto resolve = [done = std::move(done)](bool ok) {
    done(ok ? RequestResult::sent : RequestResult::unreachable);
  };
  if (!forkedTree) {
    email_.sendMagicLink(*email, url, std::move(resolve));
    return;
  }
  const std::string meta =
      forkedTree->steps == 1 ? "1 step" : std::to_string(forkedTree->steps) + " steps";
  email_.sendForkLink(*email, url, forkedTree->title, meta, std::move(resolve));
}

AuthService::Completion AuthService::completeLink(const std::string& linkSecret, const SessionContext& ctx) {
  const std::string digest = tokens_.digestOf(linkSecret);
  const UnixMs now = clock_.nowMs();

  const std::optional<StoredLink> link = repo_.findLink(digest);
  const LinkVerdict verdict = verifyLink(link.has_value(), link && link->consumed,
                                         link ? link->expiresAt : 0, now);
  if (verdict != LinkVerdict::valid) return {verdict, std::nullopt, ""};

  // Spend it atomically before minting anything. If a concurrent verify already won the
  // row, we lost the race — treat it exactly as an already-used link, no session.
  if (!repo_.consumeLink(digest, now)) return {LinkVerdict::alreadyUsed, std::nullopt, ""};

  return {verdict, mintSessionFor(link->email, nameFromEmail(link->email), ctx, now), link->forkSource};
}

AuthService::SignedIn AuthService::completeGoogle(const Email& verifiedEmail, const std::string& name,
                                                  const SessionContext& ctx) {
  const UnixMs now = clock_.nowMs();
  // No link to verify or consume: the caller proved the email via Google's OAuth. Everything else
  // — revival, account-linking-by-email, session mint — is the shared tail.
  const std::string safeName = name.empty() ? nameFromEmail(verifiedEmail) : name;
  return mintSessionFor(verifiedEmail, safeName, ctx, now);
}

AuthService::SignedIn AuthService::mintSessionFor(const Email& email, const std::string& name,
                                                  const SessionContext& ctx, UnixMs now) {
  // Signing in is the undo: a within-grace closed account revives before the session is
  // minted, so the door reopens onto exactly the trees and grants the close left in place.
  std::optional<User> existing = repo_.findUserByEmail(email);
  if (existing && existing->deletedAt) {
    repo_.reviveUser(existing->id);
    existing->deletedAt = std::nullopt;
  }
  const User user = existing ? *existing : repo_.createUser(email, name);

  const MintedToken session = tokens_.mint();
  repo_.insertSession(session.digest, user.id, sessionExpiry(now), ctx.userAgent, ctx.ip, now);
  return SignedIn{user, session.secret};
}

std::optional<User> AuthService::authenticate(const std::string& sessionSecret, const SessionContext& ctx) {
  if (sessionSecret.empty()) return std::nullopt;
  return revalidate(tokens_.digestOf(sessionSecret), ctx);
}

std::string AuthService::digestOf(const std::string& sessionSecret) {
  return tokens_.digestOf(sessionSecret);
}

std::optional<User> AuthService::revalidate(const std::string& digest, const SessionContext& ctx) {
  if (digest.empty()) return std::nullopt;
  const UnixMs now = clock_.nowMs();

  const std::optional<StoredSession> session = repo_.findSession(digest);
  if (!session || sessionExpired(session->expiresAt, now)) return std::nullopt;

  const std::optional<User> user = repo_.findUserById(session->user);
  if (!user || user->deletedAt) return std::nullopt;  // unknown or closed account cannot act

  repo_.refreshSession(digest, sessionExpiry(now), now, ctx.userAgent, ctx.ip);  // rolling + self-heal
  return user;
}

void AuthService::signOut(const std::string& sessionSecret) {
  if (sessionSecret.empty()) return;
  repo_.deleteSession(tokens_.digestOf(sessionSecret));
}

std::optional<User> AuthService::updateName(const UserId& userId, const std::string& rawName) {
  const std::optional<std::string> name = parseName(rawName);
  if (!name) return std::nullopt;
  repo_.updateName(userId, *name);
  return repo_.findUserById(userId);
}

std::vector<SessionView> AuthService::listSessions(const UserId& userId, const std::string& currentSecret) {
  const std::string currentDigest = tokens_.digestOf(currentSecret);
  std::vector<SessionView> views;
  for (const SessionRow& row : repo_.listSessions(userId))
    views.push_back(SessionView{row.id, row.userAgent, effectiveLastSeen(row.lastSeenMs, row.createdAtMs),
                                row.createdAtMs, row.ip, row.tokenHash == currentDigest});
  return views;
}

AuthService::RevokeOutcome AuthService::revokeSession(const UserId& userId, const std::string& sessionId,
                                                      const std::string& currentSecret) {
  const std::optional<std::string> revokedDigest = repo_.revokeSession(userId, sessionId);
  if (!revokedDigest) return RevokeOutcome::notFound;
  if (*revokedDigest == tokens_.digestOf(currentSecret)) return RevokeOutcome::revokedCurrent;
  return RevokeOutcome::revoked;
}

void AuthService::signOutEverywhere(const UserId& userId, const std::string& currentSecret) {
  repo_.revokeSessionsExcept(userId, tokens_.digestOf(currentSecret));
}

UnixMs AuthService::closeAccount(const UserId& userId) {
  const UnixMs now = clock_.nowMs();
  // Tear down every credential BEFORE stamping the close, so "deleted ⇒ no live access" holds
  // with no window: the MCP token path has no deletedAt guard of its own, and stamping first
  // would let a token resolve for an already-closed account until disconnectAll landed.
  repo_.revokeAllSessions(userId);     // every device signed out
  oauth_.disconnectAll(userId);        // every connected tool disconnected (drops its tokens)
  repo_.markUserDeleted(userId, now);  // the grace starts now; the trees are left untouched
  return closesAt(now);
}

}
