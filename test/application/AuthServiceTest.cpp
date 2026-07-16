#include "application/AuthService.h"
#include "test/application/AuthFakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {
struct Harness {
  FakeAuthRepository repo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  AuthService service{repo, email, tokens, clock, "https://windmill.works"};
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
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  AuthService service{repo, email, tokens, clock, "https://windmill.works"};
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
