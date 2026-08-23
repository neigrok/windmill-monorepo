#include "platform/application/AuthService.h"

#include <trantor/utils/Logger.h>

namespace wm {

AuthService::AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
                         OAuthService& oauth, AccountFootprint& footprint, std::string appBaseUrl)
    : repo_(repo), email_(email), tokens_(tokens), clock_(clock), oauth_(oauth), footprint_(footprint),
      appBaseUrl_(std::move(appBaseUrl)) {}

void AuthService::requestLink(const std::string& rawEmail, const std::string& forkSource,
                              const std::optional<ForkDescription>& forkDescription,
                              const std::string& door, std::function<void(RequestResult)> done) {
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

  // Mint and persist both credentials before deferring the send.
  const MintedToken link = tokens_.mint();
  const std::string code = tokens_.mintCode();
  repo_.insertLink(link.digest, tokens_.digestOf(code), *email, now, linkExpiry(now), forkSource);

  auto resolve = [done = std::move(done)](bool ok) {
    done(ok ? RequestResult::sent : RequestResult::unreachable);
  };
  // The app door's mail carries the code and never the link.
  if (door == "app") {
    email_.sendSignInCode(*email, code, std::move(resolve));
    return;
  }
  const std::string url = appBaseUrl_ + "/#/auth?token=" + link.secret;
  if (!forkDescription) {
    email_.sendMagicLink(*email, url, std::move(resolve));
    return;
  }
  email_.sendForkLink(*email, url, forkDescription->title, forkDescription->meta, std::move(resolve));
}

AuthService::Completion AuthService::completeLink(const std::string& linkSecret, const SessionContext& ctx) {
  const std::string digest = tokens_.digestOf(linkSecret);
  const UnixMs now = clock_.nowMs();

  const std::optional<StoredLink> link = repo_.findLink(digest);
  const LinkVerdict verdict = verifyLink(link.has_value(), link && link->consumed,
                                         link ? link->expiresAt : 0, now);
  if (verdict != LinkVerdict::valid) return {verdict, std::nullopt, ""};

  // Spend it atomically before minting anything: losing the race is an already-used link.
  if (!repo_.consumeLink(digest, now)) return {LinkVerdict::alreadyUsed, std::nullopt, ""};

  return {verdict, mintSessionFor(link->email, nameFromEmail(link->email), ctx, now), link->forkSource};
}

AuthService::CodeCompletion AuthService::completeCode(const std::string& rawEmail,
                                                      const std::string& code,
                                                      const SessionContext& ctx) {
  const std::optional<Email> email = parseEmail(rawEmail);
  if (!email) return {CodeVerdict::noLiveCode, std::nullopt, ""};
  const UnixMs now = clock_.nowMs();

  // The newest live row is the code for this address: a resend supersedes the one before it.
  const std::optional<StoredSignInCode> stored =
      repo_.findLiveCode(*email, now, AuthPolicy::maxCodeAttempts);
  const CodeVerdict verdict =
      verifyCode(stored.has_value(), stored && tokens_.digestOf(code) == stored->codeDigest);
  if (verdict == CodeVerdict::wrongCode) {
    // At maxCodeAttempts the lookup above stops finding the row.
    repo_.spendCodeAttempt(stored->linkDigest, AuthPolicy::maxCodeAttempts);
    return {verdict, std::nullopt, ""};
  }
  if (verdict != CodeVerdict::valid) return {verdict, std::nullopt, ""};

  // Either credential burns the one row.
  if (!repo_.consumeLink(stored->linkDigest, now)) return {CodeVerdict::noLiveCode, std::nullopt, ""};

  return {verdict, mintSessionFor(*email, nameFromEmail(*email), ctx, now), stored->forkSource};
}

std::optional<AuthService::ProviderSignIn> AuthService::completeProvider(const ProviderIdentity& identity,
                                                                        const SessionContext& ctx) {
  const AddressTrust trust = trustOf(identity);
  if (trust == AddressTrust::unusable || identity.subject.empty()) return std::nullopt;

  const UnixMs now = clock_.nowMs();
  const bool privateEmail = trust == AddressTrust::appOnly;

  // The subject is the identity, not the address: a bound door opens the account it was bound to.
  if (const std::optional<UserId> bound = repo_.findIdentity(identity.provider, identity.subject)) {
    if (const std::optional<User> user = repo_.findUserById(*bound)) {
      LOG_INFO << "auth: provider sign-in by bound door provider=" << toString(identity.provider)
               << " user=" << user->id.str();
      return ProviderSignIn{mintSession(revived(*user), ctx, now), false, privateEmail};
    }
  }

  // No door bound: the verified address finds an account as a magic link would, and the door is
  // bound here. A provider's name is unvetted text and only seeds a NEW account, through the gate
  // the settings rename uses.
  const bool created = !repo_.findUserByEmail(identity.email).has_value();
  const std::optional<std::string> offered = parseName(identity.name);
  const SignedIn signedIn =
      mintSessionFor(identity.email, offered ? *offered : nameFromEmail(identity.email), ctx, now);
  repo_.bindIdentity(identity.provider, identity.subject, signedIn.user.id, identity.email.value);
  // Never log the subject.
  LOG_INFO << "auth: provider sign-in bound a door provider=" << toString(identity.provider)
           << " user=" << signedIn.user.id.str() << " created=" << (created ? "yes" : "no")
           << " relay=" << (privateEmail ? "yes" : "no");
  return ProviderSignIn{signedIn, created, privateEmail};
}

AuthService::AttachOutcome AuthService::attachIdentity(const UserId& userId,
                                                       const ProviderIdentity& identity) {
  if (trustOf(identity) == AddressTrust::unusable || identity.subject.empty())
    return AttachOutcome::refused;

  const std::optional<UserId> bound = repo_.findIdentity(identity.provider, identity.subject);
  if (bound && *bound == userId) return AttachOutcome::alreadyMine;
  if (bound) return AttachOutcome::takenByAnother;  // a door opens one account; it is never stolen

  repo_.bindIdentity(identity.provider, identity.subject, userId, identity.email.value);
  LOG_INFO << "auth: provider door attached provider=" << toString(identity.provider)
           << " user=" << userId.str();
  return AttachOutcome::attached;
}

AuthService::LinkResult AuthService::linkAccount(const UserId& caller, const std::string& linkSecret,
                                                 const SessionContext& ctx) {
  const std::string digest = tokens_.digestOf(linkSecret);
  const UnixMs now = clock_.nowMs();

  const std::optional<StoredLink> link = repo_.findLink(digest);
  if (verifyLink(link.has_value(), link && link->consumed, link ? link->expiresAt : 0, now) !=
      LinkVerdict::valid)
    return {LinkOutcome::badLink, std::nullopt};

  // The link names the account that survives. Resolved before it is spent, so the refusals below
  // do not burn a single-use credential.
  const std::optional<User> target = repo_.findUserByEmail(link->email);
  const bool linkingToSelf = target && target->id == caller;

  // The caller's row must hold nothing. Checked before the link is spent, since it is a permanent
  // refusal.
  if (!linkingToSelf && footprint_.anyData(caller)) return {LinkOutcome::notEmpty, std::nullopt};

  if (!repo_.consumeLink(digest, now)) return {LinkOutcome::badLink, std::nullopt};
  if (linkingToSelf) return {LinkOutcome::sameAccount, std::nullopt};

  const User surviving = target ? revived(*target) : repo_.createUser(link->email, nameFromEmail(link->email));
  repo_.moveIdentities(caller, surviving.id);
  repo_.deleteUser(caller);  // empty by proof; the cascade takes the caller's own session with it
  LOG_INFO << "auth: empty account folded into another folded=" << caller.str()
           << " surviving=" << surviving.id.str();
  return {LinkOutcome::linked, mintSession(surviving, ctx, now)};
}

AuthService::SignedIn AuthService::mintSessionFor(const Email& email, const std::string& name,
                                                  const SessionContext& ctx, UnixMs now) {
  const std::optional<User> existing = repo_.findUserByEmail(email);
  if (existing) return mintSession(revived(*existing), ctx, now);
  return mintSession(repo_.createUser(email, name), ctx, now);
}

User AuthService::revived(User user) {
  // A within-grace closed account revives before the session is minted.
  if (!user.deletedAt) return user;
  repo_.reviveUser(user.id);
  user.deletedAt = std::nullopt;
  return user;
}

AuthService::SignedIn AuthService::mintSession(const User& user, const SessionContext& ctx, UnixMs now) {
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
  LOG_INFO << "auth: signed out everywhere user=" << userId.str();
}

UnixMs AuthService::closeAccount(const UserId& userId) {
  const UnixMs now = clock_.nowMs();
  LOG_INFO << "auth: account closed user=" << userId.str();
  // Tear down every credential BEFORE stamping the close: the MCP token path has no deletedAt
  // guard, so stamping first leaves a window where a token resolves for a closed account.
  repo_.revokeAllSessions(userId);     // every device signed out
  oauth_.disconnectAll(userId);        // every connected tool disconnected (drops its tokens)
  repo_.markUserDeleted(userId, now);  // the grace starts now; the trees are left untouched
  return closesAt(now);
}

}
