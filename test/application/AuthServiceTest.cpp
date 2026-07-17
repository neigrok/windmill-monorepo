#include "application/AuthService.h"
#include "test/application/AuthFakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {
struct Harness {
  FakeAuthRepository repo;
  FakeOAuthRepository oauthRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  OAuthService oauth{oauthRepo, tokens, clock};
  AuthService service{repo, email, tokens, clock, oauth, "https://windmill.works"};
};
}

TEST(request_link_sends_a_link_that_carries_the_minted_secret) {
  Harness h;
  CHECK(h.service.requestLink("Sam@Example.com") == AuthService::RequestResult::sent);

  CHECK_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].to.value, std::string("sam@example.com"));
  CHECK_EQ(h.email.sent[0].url, std::string("https://windmill.works/#/auth?token=s1"));
  CHECK_EQ(h.email.sent[0].templateId, std::string("magic-link"));
  CHECK_EQ(h.email.sent[0].treeTitle, std::string(""));
  CHECK_EQ(h.email.sent[0].treeMeta, std::string(""));
  // The link is stored under its digest, unspent, expiring 15 minutes out.
  std::optional<StoredLink> link = h.repo.findLink("d1");
  CHECK(link.has_value());
  CHECK_FALSE(link->consumed);
  CHECK_EQ(link->expiresAt, h.clock.now + AuthPolicy::linkLifetimeMs);
}

TEST(request_link_rejects_an_unfinished_address_without_sending) {
  Harness h;
  CHECK(h.service.requestLink("sam@example") == AuthService::RequestResult::invalidEmail);
  CHECK_EQ(h.email.sent.size(), 0u);
  CHECK_EQ(h.repo.links.size(), 0u);
}

TEST(request_link_rate_limits_after_the_cap_in_the_window) {
  Harness h;
  for (int i = 0; i < AuthPolicy::maxLinksPerWindow; ++i)
    CHECK(h.service.requestLink("sam@example.com") == AuthService::RequestResult::sent);

  CHECK(h.service.requestLink("sam@example.com") == AuthService::RequestResult::rateLimited);
  CHECK_EQ(h.email.sent.size(), static_cast<std::size_t>(AuthPolicy::maxLinksPerWindow));

  // A different address is unaffected; the window is per-email.
  CHECK(h.service.requestLink("other@example.com") == AuthService::RequestResult::sent);
}

TEST(request_link_window_slides_so_old_links_stop_counting) {
  Harness h;
  for (int i = 0; i < AuthPolicy::maxLinksPerWindow; ++i) h.service.requestLink("sam@example.com");
  CHECK(h.service.requestLink("sam@example.com") == AuthService::RequestResult::rateLimited);

  h.clock.now += AuthPolicy::rateWindowMs + 1;  // the earlier links fall out of the window
  CHECK(h.service.requestLink("sam@example.com") == AuthService::RequestResult::sent);
}

TEST(complete_link_creates_the_account_and_a_session_on_first_sign_in) {
  Harness h;
  h.service.requestLink("sam@example.com");  // mints secret s1 / digest d1

  AuthService::Completion done = h.service.completeLink("s1");
  CHECK(done.verdict == LinkVerdict::valid);
  CHECK(done.signedIn.has_value());
  CHECK_EQ(done.signedIn->user.email.value, std::string("sam@example.com"));
  CHECK_EQ(done.signedIn->user.name, std::string("sam"));

  // Session secret is the next mint (s2); it is stored under its digest (d2), 90 days out.
  CHECK_EQ(done.signedIn->sessionSecret, std::string("s2"));
  std::optional<StoredSession> session = h.repo.findSession("d2");
  CHECK(session.has_value());
  CHECK_EQ(session->user.str(), done.signedIn->user.id.str());
  CHECK_EQ(session->expiresAt, h.clock.now + AuthPolicy::sessionLifetimeMs);

  // The link is now spent.
  CHECK(h.repo.findLink("d1")->consumed);
}

TEST(complete_link_reuses_the_existing_account_on_a_later_sign_in) {
  Harness h;
  h.service.requestLink("sam@example.com");
  const UserId first = h.service.completeLink("s1").signedIn->user.id;

  h.service.requestLink("sam@example.com");  // mints s3 / d3
  AuthService::Completion again = h.service.completeLink("s3");
  CHECK(again.signedIn.has_value());
  CHECK_EQ(again.signedIn->user.id.str(), first.str());  // same account, keyed by email
  CHECK_EQ(h.repo.usersById.size(), 1u);
}

TEST(a_fork_request_sends_the_fork_mail_naming_the_source_tree) {
  Harness h;
  AuthService::ForkDescription tree{"Learn to sail", 12};
  CHECK(h.service.requestLink("sam@example.com", "t_source", tree) == AuthService::RequestResult::sent);

  CHECK_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].to.value, std::string("sam@example.com"));
  CHECK_EQ(h.email.sent[0].url, std::string("https://windmill.works/#/auth?token=s1"));
  CHECK_EQ(h.email.sent[0].templateId, std::string("magic-link-fork"));
  CHECK_EQ(h.email.sent[0].treeTitle, std::string("Learn to sail"));
  CHECK_EQ(h.email.sent[0].treeMeta, std::string("12 steps"));
  CHECK_EQ(h.repo.findLink("d1")->forkSource, std::string("t_source"));
}

TEST(a_single_step_tree_reads_1_step_not_1_steps) {
  Harness h;
  AuthService::ForkDescription tree{"Plant one seed", 1};
  CHECK(h.service.requestLink("sam@example.com", "t_source", tree) == AuthService::RequestResult::sent);

  CHECK_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].treeMeta, std::string("1 step"));
}

TEST(a_fork_request_with_an_unreadable_source_falls_back_to_the_plain_mail) {
  Harness h;
  CHECK(h.service.requestLink("sam@example.com", "t_ghost", std::nullopt) == AuthService::RequestResult::sent);

  CHECK_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].templateId, std::string("magic-link"));
  CHECK_EQ(h.email.sent[0].treeTitle, std::string(""));
  CHECK_EQ(h.email.sent[0].treeMeta, std::string(""));
  // The pending fork still rides the link; verify degrades it if the source stays gone.
  CHECK_EQ(h.repo.findLink("d1")->forkSource, std::string("t_ghost"));
}

TEST(a_pending_fork_rides_the_link_from_request_to_completion) {
  Harness h;
  CHECK(h.service.requestLink("sam@example.com", "t_source") == AuthService::RequestResult::sent);
  CHECK_EQ(h.repo.findLink("d1")->forkSource, std::string("t_source"));

  AuthService::Completion done = h.service.completeLink("s1");
  CHECK(done.verdict == LinkVerdict::valid);
  CHECK(done.signedIn.has_value());
  CHECK_EQ(done.forkSource, std::string("t_source"));
}

TEST(a_plain_link_completes_with_no_pending_fork) {
  Harness h;
  h.service.requestLink("sam@example.com");
  AuthService::Completion done = h.service.completeLink("s1");
  CHECK(done.verdict == LinkVerdict::valid);
  CHECK_EQ(done.forkSource, std::string(""));
}

TEST(complete_link_is_single_use) {
  Harness h;
  h.service.requestLink("sam@example.com");
  CHECK(h.service.completeLink("s1").verdict == LinkVerdict::valid);

  AuthService::Completion second = h.service.completeLink("s1");
  CHECK(second.verdict == LinkVerdict::alreadyUsed);
  CHECK_FALSE(second.signedIn.has_value());
}

TEST(complete_link_loses_the_race_when_a_concurrent_verify_already_spent_it) {
  // The link is still unspent when findLink reads it, but consume loses the atomic race —
  // exactly what a second concurrent verify sees. No session, no account for the loser.
  struct LostRaceRepo : FakeAuthRepository {
    bool consumeLink(const std::string&, UnixMs) override { return false; }
  } repo;
  FakeOAuthRepository oauthRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  OAuthService oauth{oauthRepo, tokens, clock};
  AuthService service{repo, email, tokens, clock, oauth, "https://windmill.works"};
  repo.insertLink("d1", Email{"sam@example.com"}, clock.now, clock.now + AuthPolicy::linkLifetimeMs, "");

  AuthService::Completion done = service.completeLink("s1");  // digestOf("s1") == "d1"
  CHECK(done.verdict == LinkVerdict::alreadyUsed);
  CHECK_FALSE(done.signedIn.has_value());
  CHECK_EQ(repo.sessions.size(), 0u);
  CHECK_EQ(repo.usersById.size(), 0u);
}

TEST(complete_link_expires_after_fifteen_minutes) {
  Harness h;
  h.service.requestLink("sam@example.com");
  h.clock.now += AuthPolicy::linkLifetimeMs;  // exactly at the boundary is lapsed

  AuthService::Completion done = h.service.completeLink("s1");
  CHECK(done.verdict == LinkVerdict::expired);
  CHECK_FALSE(done.signedIn.has_value());
}

TEST(complete_link_rejects_an_unknown_secret) {
  Harness h;
  AuthService::Completion done = h.service.completeLink("s999");
  CHECK(done.verdict == LinkVerdict::unknown);
  CHECK_FALSE(done.signedIn.has_value());
}

TEST(authenticate_resolves_a_session_and_rolls_the_window_forward) {
  Harness h;
  h.service.requestLink("sam@example.com");
  const std::string session = h.service.completeLink("s1").signedIn->sessionSecret;  // s2

  h.clock.now += 24ull * 60 * 60 * 1000;  // a day passes
  std::optional<User> user = h.service.authenticate(session);
  CHECK(user.has_value());
  CHECK_EQ(user->email.value, std::string("sam@example.com"));
  // Rolling: the stored expiry is now measured from the new present.
  CHECK_EQ(h.repo.findSession("d2")->expiresAt, h.clock.now + AuthPolicy::sessionLifetimeMs);
}

TEST(authenticate_declines_an_expired_or_empty_or_unknown_session) {
  Harness h;
  h.service.requestLink("sam@example.com");
  const std::string session = h.service.completeLink("s1").signedIn->sessionSecret;

  CHECK_FALSE(h.service.authenticate("").has_value());
  CHECK_FALSE(h.service.authenticate("s999").has_value());

  h.clock.now += AuthPolicy::sessionLifetimeMs;  // lapse
  CHECK_FALSE(h.service.authenticate(session).has_value());
}

TEST(sign_out_drops_the_session) {
  Harness h;
  h.service.requestLink("sam@example.com");
  const std::string session = h.service.completeLink("s1").signedIn->sessionSecret;

  h.service.signOut(session);
  CHECK_FALSE(h.service.authenticate(session).has_value());
  CHECK_EQ(h.repo.sessions.size(), 0u);
}

TEST(update_name_trims_and_persists_and_rejects_blank_or_over_cap) {
  Harness h;
  h.service.requestLink("sam@example.com");
  const UserId account = h.service.completeLink("s1").signedIn->user.id;

  std::optional<User> renamed = h.service.updateName(account, "  Samwise Gamgee  ");
  CHECK(renamed.has_value());
  CHECK_EQ(renamed->name, std::string("Samwise Gamgee"));  // trimmed
  CHECK_EQ(h.repo.usersById[account.str()].name, std::string("Samwise Gamgee"));

  // Blank once trimmed → refused, the stored name unchanged.
  CHECK_FALSE(h.service.updateName(account, "   ").has_value());
  CHECK_EQ(h.repo.usersById[account.str()].name, std::string("Samwise Gamgee"));

  // Over the byte cap → refused; exactly at the cap → accepted.
  const std::string tooLong(AuthPolicy::nameMaxBytes + 1, 'x');
  CHECK_FALSE(h.service.updateName(account, tooLong).has_value());
  CHECK_EQ(h.repo.usersById[account.str()].name, std::string("Samwise Gamgee"));
  const std::string atCap(AuthPolicy::nameMaxBytes, 'y');
  std::optional<User> capped = h.service.updateName(account, atCap);
  CHECK(capped.has_value());
  CHECK_EQ(capped->name, atCap);
}

TEST(list_sessions_flags_the_callers_current_session) {
  Harness h;
  h.service.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");                        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.service.requestLink("sam@example.com");                                          // s3/d3
  const std::string other = h.service.completeLink("s3").signedIn->sessionSecret;    // s4/d4

  std::vector<SessionView> list = h.service.listSessions(account, current);
  CHECK_EQ(list.size(), 2u);
  int currentCount = 0;
  for (const SessionView& v : list) if (v.current) ++currentCount;
  CHECK_EQ(currentCount, 1);  // exactly the caller's own is current
}

TEST(list_sessions_coalesces_a_zero_last_seen_to_the_created_time) {
  Harness h;
  h.service.requestLink("sam@example.com");                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  // A pre-migration row: a recorded creation time, but never a last_seen stamp.
  const UnixMs createdAt = h.clock.now;
  h.repo.sessions["d2"].lastSeenMs = 0;

  std::vector<SessionView> list = h.service.listSessions(account, current);
  CHECK_EQ(list.size(), 1u);
  CHECK_EQ(list[0].createdMs, createdAt);
  CHECK_EQ(list[0].lastSeenMs, createdAt);  // coalesced from 0 to the created time
  CHECK(list[0].current);
}

TEST(authenticate_heals_a_pre_migration_rows_user_agent_and_last_seen) {
  Harness h;
  h.service.requestLink("sam@example.com");                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.repo.sessions["d2"].userAgent = "";  // pre-migration: blank UA, zero last_seen
  h.repo.sessions["d2"].lastSeenMs = 0;

  h.clock.now += 60'000;
  const UnixMs seenAt = h.clock.now;
  CHECK(h.service.authenticate(current, SessionContext{"Firefox/128", "203.0.113.7"}).has_value());

  std::vector<SessionView> list = h.service.listSessions(account, current);
  CHECK_EQ(list.size(), 1u);
  CHECK_EQ(list[0].userAgent, std::string("Firefox/128"));
  CHECK_EQ(list[0].ip, std::string("203.0.113.7"));
  CHECK_EQ(list[0].lastSeenMs, seenAt);
}

TEST(revoke_session_revokes_one_flags_the_current_and_404s_unknown) {
  Harness h;
  h.service.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");                        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.service.requestLink("sam@example.com");                                          // s3/d3
  const std::string other = h.service.completeLink("s3").signedIn->sessionSecret;    // s4/d4

  std::string currentId, otherId;
  for (const SessionView& v : h.service.listSessions(account, current))
    (v.current ? currentId : otherId) = v.id;
  CHECK_FALSE(currentId.empty());
  CHECK_FALSE(otherId.empty());

  // An unknown id is a 404, no matter that it is the caller asking.
  CHECK(h.service.revokeSession(account, "sess-nope", current) == AuthService::RevokeOutcome::notFound);

  // Revoking the other device: a plain revoke, the caller's cookie stands.
  CHECK(h.service.revokeSession(account, otherId, current) == AuthService::RevokeOutcome::revoked);
  CHECK_FALSE(h.service.authenticate(other).has_value());
  CHECK(h.service.authenticate(current).has_value());

  // Revoking the current device: reported so the edge clears the cookie.
  CHECK(h.service.revokeSession(account, currentId, current) == AuthService::RevokeOutcome::revokedCurrent);
  CHECK_FALSE(h.service.authenticate(current).has_value());
  CHECK_EQ(h.repo.sessions.size(), 0u);
}

TEST(revoke_session_of_another_account_is_not_found) {
  Harness h;
  h.service.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion sam = h.service.completeLink("s1");                         // s2/d2
  const UserId account = sam.signedIn->user.id;

  h.service.requestLink("eve@example.com");                                          // s3/d3
  const std::string eveSession = h.service.completeLink("s3").signedIn->sessionSecret;  // s4/d4
  const UserId eve = h.repo.usersByEmail["eve@example.com"].id;
  const std::string eveId = h.service.listSessions(eve, eveSession)[0].id;

  // Sam cannot revoke Eve's session: it is not his, so a 404 and Eve stays signed in.
  CHECK(h.service.revokeSession(account, eveId, sam.signedIn->sessionSecret) == AuthService::RevokeOutcome::notFound);
  CHECK(h.service.authenticate(eveSession).has_value());
}

TEST(sign_out_everywhere_keeps_the_caller_current_and_drops_the_rest) {
  Harness h;
  h.service.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");                        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.service.requestLink("sam@example.com");                                          // s3/d3
  const std::string other = h.service.completeLink("s3").signedIn->sessionSecret;    // s4/d4
  CHECK_EQ(h.repo.sessions.size(), 2u);

  h.service.signOutEverywhere(account, current);

  CHECK_EQ(h.repo.sessions.size(), 1u);
  CHECK(h.service.authenticate(current).has_value());      // this device stands
  CHECK_FALSE(h.service.authenticate(other).has_value());  // the rest are gone
}

TEST(authenticate_refuses_a_session_whose_account_is_closed) {
  Harness h;
  h.service.requestLink("sam@example.com");
  AuthService::Completion done = h.service.completeLink("s1");
  const std::string session = done.signedIn->sessionSecret;  // s2/d2
  CHECK(h.service.authenticate(session).has_value());

  // Close the account but leave its session row in place: the refusal is the user check,
  // defense in depth behind the close's own session sweep.
  h.repo.markUserDeleted(done.signedIn->user.id, h.clock.now);
  CHECK_FALSE(h.service.authenticate(session).has_value());
  CHECK_EQ(h.repo.sessions.size(), 1u);
}

TEST(close_account_drops_every_session_disconnects_tools_and_returns_the_grace_end) {
  Harness h;
  h.service.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion first = h.service.completeLink("s1");                       // s2/d2
  const UserId account = first.signedIn->user.id;
  const std::string staleSession = first.signedIn->sessionSecret;

  h.service.requestLink("sam@example.com");                                          // s3/d3
  const std::string otherSession = h.service.completeLink("s3").signedIn->sessionSecret;  // s4/d4

  // The account has a connected tool.
  h.oauthRepo.recordGrant(account, "client-abc", h.clock.now);
  CHECK_EQ(h.oauth.listGrants(account).size(), 1u);

  const UnixMs closesMs = h.service.closeAccount(account);
  CHECK_EQ(closesMs, h.clock.now + AuthPolicy::closeGraceMs);
  CHECK_EQ(h.repo.sessions.size(), 0u);                       // every device signed out
  CHECK_FALSE(h.service.authenticate(staleSession).has_value());
  CHECK_FALSE(h.service.authenticate(otherSession).has_value());
  CHECK_EQ(h.oauth.listGrants(account).size(), 0u);           // every tool disconnected
  CHECK(h.repo.usersById[account.str()].deletedAt.has_value());
}

TEST(a_within_grace_magic_link_sign_in_revives_the_account_and_reissues_a_session) {
  Harness h;
  h.service.requestLink("sam@example.com");                                          // s1/d1
  const UserId account = h.service.completeLink("s1").signedIn->user.id;             // s2/d2
  h.service.closeAccount(account);
  CHECK(h.repo.usersById[account.str()].deletedAt.has_value());

  // A day later — well inside the 30-day grace — signing in undoes the close.
  h.clock.now += 24ull * 60 * 60 * 1000;
  h.service.requestLink("sam@example.com");                                          // s3/d3
  AuthService::Completion revived = h.service.completeLink("s3");                     // s4/d4
  CHECK(revived.verdict == LinkVerdict::valid);
  CHECK(revived.signedIn.has_value());
  CHECK_EQ(revived.signedIn->user.id.str(), account.str());   // same account — its trees stay owned by it
  CHECK_EQ(h.repo.usersById.size(), 1u);
  CHECK_FALSE(h.repo.usersById[account.str()].deletedAt.has_value());  // the close is undone
  CHECK_FALSE(revived.signedIn->user.deletedAt.has_value());          // and the handed-back user is live

  // The freshly issued session works: the account is live again.
  std::optional<User> back = h.service.authenticate(revived.signedIn->sessionSecret);
  CHECK(back.has_value());
  CHECK_EQ(back->email.value, std::string("sam@example.com"));
}
