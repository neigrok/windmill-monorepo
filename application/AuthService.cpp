#include "application/AuthService.h"

namespace wm {

AuthService::AuthService(AuthRepository& repo, EmailSender& email, TokenGenerator& tokens, Clock& clock,
                         std::string appBaseUrl)
    : repo_(repo), email_(email), tokens_(tokens), clock_(clock), appBaseUrl_(std::move(appBaseUrl)) {}

AuthService::RequestResult AuthService::requestLink(const std::string& rawEmail, const std::string& forkSource,
                                                    const std::optional<ForkDescription>& forkedTree) {
  std::optional<Email> email = parseEmail(rawEmail);
  if (!email) return RequestResult::invalidEmail;

  const UnixMs now = clock_.nowMs();
  if (!withinRateLimit(repo_.countRecentLinks(*email, now - AuthPolicy::rateWindowMs)))
    return RequestResult::rateLimited;

  const MintedToken link = tokens_.mint();
  repo_.insertLink(link.digest, *email, now, linkExpiry(now), forkSource);

  const std::string url = appBaseUrl_ + "/#/auth?token=" + link.secret;
  if (!forkedTree) {
    email_.sendMagicLink(*email, url);
    return RequestResult::sent;
  }
  const std::string meta =
      forkedTree->steps == 1 ? "1 step" : std::to_string(forkedTree->steps) + " steps";
  email_.sendForkLink(*email, url, forkedTree->title, meta);
  return RequestResult::sent;
}

AuthService::Completion AuthService::completeLink(const std::string& linkSecret) {
  const std::string digest = tokens_.digestOf(linkSecret);
  const UnixMs now = clock_.nowMs();

  const std::optional<StoredLink> link = repo_.findLink(digest);
  const LinkVerdict verdict = verifyLink(link.has_value(), link && link->consumed,
                                         link ? link->expiresAt : 0, now);
  if (verdict != LinkVerdict::valid) return {verdict, std::nullopt, ""};

  // Spend it atomically before minting anything. If a concurrent verify already won the
  // row, we lost the race — treat it exactly as an already-used link, no session.
  if (!repo_.consumeLink(digest, now)) return {LinkVerdict::alreadyUsed, std::nullopt, ""};

  const std::optional<User> existing = repo_.findUserByEmail(link->email);
  const User user = existing ? *existing : repo_.createUser(link->email, nameFromEmail(link->email));

  const MintedToken session = tokens_.mint();
  repo_.insertSession(session.digest, user.id, sessionExpiry(now));
  return {verdict, SignedIn{user, session.secret}, link->forkSource};
}

std::optional<User> AuthService::authenticate(const std::string& sessionSecret) {
  if (sessionSecret.empty()) return std::nullopt;

  const std::string digest = tokens_.digestOf(sessionSecret);
  const UnixMs now = clock_.nowMs();

  const std::optional<StoredSession> session = repo_.findSession(digest);
  if (!session || sessionExpired(session->expiresAt, now)) return std::nullopt;

  repo_.refreshSession(digest, sessionExpiry(now));  // rolling: use pushes the window out
  return repo_.findUserById(session->user);
}

void AuthService::signOut(const std::string& sessionSecret) {
  if (sessionSecret.empty()) return;
  repo_.deleteSession(tokens_.digestOf(sessionSecret));
}

}
