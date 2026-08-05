#include "platform/application/AuthService.h"

#include <trantor/utils/Logger.h>

namespace wm {

AuthService::AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
                         OAuthService& oauth, AccountFootprint& footprint, std::string appBaseUrl)
    : repo_(repo), email_(email), tokens_(tokens), clock_(clock), oauth_(oauth), footprint_(footprint),
      appBaseUrl_(std::move(appBaseUrl)) {}

void AuthService::requestLink(const std::string& rawEmail, const std::string& forkSource,
                              const std::optional<ForkDescription>& forkDescription,
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

  // Spend it atomically before minting anything. If a concurrent verify already won the
  // row, we lost the race — treat it exactly as an already-used link, no session.
  if (!repo_.consumeLink(digest, now)) return {LinkVerdict::alreadyUsed, std::nullopt, ""};

  return {verdict, mintSessionFor(link->email, nameFromEmail(link->email), ctx, now), link->forkSource};
}

std::optional<AuthService::ProviderSignIn> AuthService::completeProvider(const ProviderIdentity& identity,
                                                                        const SessionContext& ctx) {
  const AddressTrust trust = trustOf(identity);
  if (trust == AddressTrust::unusable || identity.subject.empty()) return std::nullopt;

  const UnixMs now = clock_.nowMs();
  const bool privateEmail = trust == AddressTrust::appOnly;

  // Step one, and the only step that can answer on its own: the subject IS the identity. Whatever
  // address the provider is sending today, a bound door opens the account it was bound to.
  if (const std::optional<UserId> bound = repo_.findIdentity(identity.provider, identity.subject)) {
    if (const std::optional<User> user = repo_.findUserById(*bound)) {
      LOG_INFO << "auth: provider sign-in by bound door provider=" << toString(identity.provider)
               << " user=" << user->id.str();
      return ProviderSignIn{mintSession(revived(*user), ctx, now), false, privateEmail};
    }
  }

  // Step two: no door is bound, so the verified address gets to find an account exactly as a magic
  // link would — and binding the door here is what backfills the table for every account that
  // predates it, since no provider subject was ever stored to migrate. A relay address runs the
  // same path and is just as safe: it is stable for this app, so it re-finds the same human and
  // can collide with no one else. What it cannot do is find the account they have on the web, and
  // that is what `privateEmail` sends the client to the link door for.
  // A provider's name is unvetted text and only ever seeds a NEW account, so it goes through the
  // same gate the settings rename does — cap and all — rather than reaching a row unchecked.
  const bool created = !repo_.findUserByEmail(identity.email).has_value();
  const std::optional<std::string> offered = parseName(identity.name);
  const SignedIn signedIn =
      mintSessionFor(identity.email, offered ? *offered : nameFromEmail(identity.email), ctx, now);
  repo_.bindIdentity(identity.provider, identity.subject, signedIn.user.id, identity.email.value);
  // The address, never the subject: a subject is an opaque provider id, an address is the person.
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

  // The link names the account that survives. Resolved before it is spent, because two of the three
  // answers below cost the caller nothing and must not burn a single-use credential to reach.
  const std::optional<User> target = repo_.findUserByEmail(link->email);
  const bool linkingToSelf = target && target->id == caller;

  // The one precondition, and the reason no account merger exists: the caller's row must hold
  // nothing, so folding it away destroys nothing and nothing has to be reconciled. Checked BEFORE
  // the link is spent — it is a permanent refusal, and a human who meets it would otherwise have to
  // request a fresh link to be told the same thing again.
  if (!linkingToSelf && footprint_.anyData(caller)) return {LinkOutcome::notEmpty, std::nullopt};

  // Spend it. A concurrent verify that won the row means this one never held a valid link at all.
  if (!repo_.consumeLink(digest, now)) return {LinkOutcome::badLink, std::nullopt};
  if (linkingToSelf) return {LinkOutcome::sameAccount, std::nullopt};

  // Created here when the address has never signed in, so linking to it is still a link and not a
  // dead end — and only now, once the link is proven spendable and the caller proven empty.
  const User surviving = target ? revived(*target) : repo_.createUser(link->email, nameFromEmail(link->email));
  repo_.moveIdentities(caller, surviving.id);
  repo_.deleteUser(caller);  // empty by proof; the cascade takes the caller's own session with it
  // The only path that deletes an account as a side effect of a sign-in. Both ids, because
  // afterwards one of them names nothing and this line is the only place the pair was ever true.
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
  // Signing in is the undo: a within-grace closed account revives before the session is minted,
  // so the door reopens onto exactly the trees and grants the close left in place.
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
  // What a stolen-laptop panic looks like from the server: worth being able to find afterwards.
  LOG_INFO << "auth: signed out everywhere user=" << userId.str();
}

UnixMs AuthService::closeAccount(const UserId& userId) {
  const UnixMs now = clock_.nowMs();
  // The most destructive write this server does, and the one whose absence from a log is least
  // forgivable: after the grace window there is nothing left to ask what happened.
  LOG_INFO << "auth: account closed user=" << userId.str();
  // Tear down every credential BEFORE stamping the close, so "deleted ⇒ no live access" holds
  // with no window: the MCP token path has no deletedAt guard of its own, and stamping first
  // would let a token resolve for an already-closed account until disconnectAll landed.
  repo_.revokeAllSessions(userId);     // every device signed out
  oauth_.disconnectAll(userId);        // every connected tool disconnected (drops its tokens)
  repo_.markUserDeleted(userId, now);  // the grace starts now; the trees are left untouched
  return closesAt(now);
}

}
