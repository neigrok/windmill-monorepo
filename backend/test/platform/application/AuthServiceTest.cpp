#include "platform/application/AuthService.h"
#include "test/platform/Fakes.h"
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
  FakeAccountFootprint footprint;
  AuthService service{repo, email, tokens, clock, oauth, footprint, "https://windmill.works"};

  AuthService::RequestResult requestLink(
      const std::string& email, const std::string& forkSource = "",
      const std::optional<ForkDescription>& forkDescription = std::nullopt,
      const std::string& door = "") {
    std::optional<AuthService::RequestResult> verdict;
    service.requestLink(email, forkSource, forkDescription, door,
                        [&](AuthService::RequestResult result) { verdict = result; });
    CHECK(verdict.has_value());
    return *verdict;
  }

  AuthService::RequestResult requestCode(const std::string& email) {
    return requestLink(email, "", std::nullopt, "app");
  }

  std::string lastLinkSecret() const {
    const std::string& url = email.sent.back().url;
    return url.substr(url.find("token=") + 6);
  }

  std::string lastCode() const { return email.sent.back().code; }
};
}

TEST(request_link_sends_a_link_that_carries_the_minted_secret) {
  Harness h;
  CHECK(h.requestLink("Sam@Example.com") == AuthService::RequestResult::sent);

  REQUIRE_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].to.value, std::string("sam@example.com"));
  CHECK_EQ(h.email.sent[0].url, std::string("https://windmill.works/#/auth?token=s1"));
  CHECK_EQ(h.email.sent[0].templateId, std::string("magic-link"));
  CHECK_EQ(h.email.sent[0].sourceTitle, std::string(""));
  CHECK_EQ(h.email.sent[0].sourceMeta, std::string(""));
  std::optional<StoredLink> link = h.repo.findLink("d1");
  REQUIRE(link.has_value());
  CHECK_FALSE(link->consumed);
  CHECK_EQ(link->expiresAt, h.clock.now + AuthPolicy::linkLifetimeMs);
}

TEST(request_link_with_a_failing_send_is_unreachable_but_still_leaves_a_usable_link) {
  Harness h;
  h.email.failNext = true;
  CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::unreachable);

  CHECK_EQ(h.email.sent.size(), 0u);
  std::optional<StoredLink> link = h.repo.findLink("d1");
  REQUIRE(link.has_value());
  CHECK_FALSE(link->consumed);
  CHECK_EQ(link->expiresAt, h.clock.now + AuthPolicy::linkLifetimeMs);
}

TEST(request_link_rejects_an_unfinished_address_without_sending) {
  Harness h;
  CHECK(h.requestLink("sam@example") == AuthService::RequestResult::invalidEmail);
  CHECK_EQ(h.email.sent.size(), 0u);
  CHECK_EQ(h.repo.links.size(), 0u);
}

TEST(request_link_rate_limits_after_the_cap_in_the_window) {
  Harness h;
  for (int i = 0; i < AuthPolicy::maxLinksPerWindow; ++i)
    CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::sent);

  CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::rateLimited);
  CHECK_EQ(h.email.sent.size(), static_cast<std::size_t>(AuthPolicy::maxLinksPerWindow));

  CHECK(h.requestLink("other@example.com") == AuthService::RequestResult::sent);
}

TEST(request_link_window_slides_so_old_links_stop_counting) {
  Harness h;
  for (int i = 0; i < AuthPolicy::maxLinksPerWindow; ++i) h.requestLink("sam@example.com");
  CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::rateLimited);

  h.clock.now += AuthPolicy::rateWindowMs + 1;
  CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::sent);
}

TEST(complete_link_creates_the_account_and_a_session_on_first_sign_in) {
  Harness h;
  h.requestLink("sam@example.com");  // mints secret s1 / digest d1

  AuthService::Completion done = h.service.completeLink("s1");
  CHECK(done.verdict == LinkVerdict::valid);
  REQUIRE(done.signedIn.has_value());
  CHECK_EQ(done.signedIn->user.email.value, std::string("sam@example.com"));
  CHECK_EQ(done.signedIn->user.name, std::string("sam"));

  CHECK_EQ(done.signedIn->sessionSecret, std::string("s2"));
  std::optional<StoredSession> session = h.repo.findSession("d2");
  REQUIRE(session.has_value());
  CHECK_EQ(session->user.str(), done.signedIn->user.id.str());
  CHECK_EQ(session->expiresAt, h.clock.now + AuthPolicy::sessionLifetimeMs);

  CHECK(h.repo.findLink("d1")->consumed);
}

TEST(complete_link_reuses_the_existing_account_on_a_later_sign_in) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId first = h.service.completeLink("s1").signedIn->user.id;

  h.requestLink("sam@example.com");  // mints s3 / d3
  AuthService::Completion again = h.service.completeLink("s3");
  REQUIRE(again.signedIn.has_value());
  CHECK_EQ(again.signedIn->user.id.str(), first.str());
  CHECK_EQ(h.repo.usersById.size(), 1u);
}

TEST(revalidate_accepts_a_live_session_and_refuses_a_signed_out_one) {
  Harness h;
  h.requestLink("sam@example.com");
  const std::string session = h.service.completeLink("s1").signedIn->sessionSecret;
  const std::string digest = h.service.digestOf(session);
  CHECK(h.service.revalidate(digest).has_value());

  h.service.signOut(session);
  CHECK_FALSE(h.service.revalidate(digest).has_value());
}

TEST(revalidate_refuses_a_closed_account) {
  Harness h;
  h.requestLink("sam@example.com");
  const AuthService::SignedIn signedIn = *h.service.completeLink("s1").signedIn;
  const std::string digest = h.service.digestOf(signedIn.sessionSecret);
  CHECK(h.service.revalidate(digest).has_value());

  h.service.closeAccount(signedIn.user.id);
  CHECK_FALSE(h.service.revalidate(digest).has_value());
}

TEST(revalidate_refuses_an_expired_session_and_an_unknown_digest) {
  Harness h;
  h.requestLink("sam@example.com");
  const std::string digest = h.service.digestOf(h.service.completeLink("s1").signedIn->sessionSecret);

  h.clock.now += AuthPolicy::sessionLifetimeMs + 1;
  CHECK_FALSE(h.service.revalidate(digest).has_value());
  CHECK_FALSE(h.service.revalidate("d-never-issued").has_value());
  CHECK_FALSE(h.service.revalidate("").has_value());
}

namespace {
ProviderIdentity googleId(const std::string& subject, const std::string& email, const std::string& name = "") {
  return ProviderIdentity{Provider::google, subject, *parseEmail(email), name, true, false};
}
ProviderIdentity appleId(const std::string& subject, const std::string& email, const std::string& name = "") {
  return ProviderIdentity{Provider::apple, subject, *parseEmail(email), name, true, false};
}
constexpr const char* kRelay = "abc123@privaterelay.appleid.com";
}

TEST(google_sign_in_creates_the_account_and_a_session_for_a_new_email) {
  Harness h;
  std::optional<AuthService::ProviderSignIn> signIn = h.service.completeProvider(googleId("g-1", "sam@example.com", "Sam Gold"));
  REQUIRE(signIn.has_value());
  CHECK_EQ(signIn->signedIn.user.email.value, std::string("sam@example.com"));
  CHECK_EQ(signIn->signedIn.user.name, std::string("Sam Gold"));
  CHECK(signIn->created);
  CHECK_FALSE(signIn->privateEmail);

  CHECK_EQ(signIn->signedIn.sessionSecret, std::string("s1"));
  std::optional<StoredSession> session = h.repo.findSession("d1");
  REQUIRE(session.has_value());
  CHECK_EQ(session->user.str(), signIn->signedIn.user.id.str());
  CHECK_EQ(session->expiresAt, h.clock.now + AuthPolicy::sessionLifetimeMs);
  CHECK_EQ(h.repo.findIdentity(Provider::google, "g-1")->str(), signIn->signedIn.user.id.str());
}

TEST(google_sign_in_links_to_the_same_account_a_magic_link_created) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId viaLink = h.service.completeLink("s1").signedIn->user.id;

  std::optional<AuthService::ProviderSignIn> viaGoogle = h.service.completeProvider(googleId("g-1", "Sam@Example.com", "Sam"));
  REQUIRE(viaGoogle.has_value());
  CHECK_EQ(viaGoogle->signedIn.user.id.str(), viaLink.str());
  CHECK_FALSE(viaGoogle->created);
  CHECK_EQ(h.repo.usersById.size(), 1u);
}

TEST(google_sign_in_revives_a_within_grace_closed_account) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId account = h.service.completeLink("s1").signedIn->user.id;
  h.service.closeAccount(account);
  CHECK(h.repo.usersById.at(account.str()).deletedAt.has_value());

  std::optional<AuthService::ProviderSignIn> revived = h.service.completeProvider(googleId("g-1", "sam@example.com", "Sam"));
  REQUIRE(revived.has_value());
  CHECK_EQ(revived->signedIn.user.id.str(), account.str());
  CHECK_FALSE(revived->signedIn.user.deletedAt.has_value());
  CHECK_FALSE(h.repo.usersById.at(account.str()).deletedAt.has_value());
}

TEST(a_bound_door_resolves_the_same_account_after_the_address_moves) {
  Harness h;
  const UserId first = h.service.completeProvider(googleId("g-1", "sam@example.com"))->signedIn.user.id;

  std::optional<AuthService::ProviderSignIn> later = h.service.completeProvider(googleId("g-1", "sam@newjob.com"));
  REQUIRE(later.has_value());
  CHECK_EQ(later->signedIn.user.id.str(), first.str());
  CHECK_FALSE(later->created);
  CHECK_EQ(h.repo.usersById.size(), 1u);
}

TEST(apple_with_a_real_address_lands_on_the_existing_web_account) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId viaLink = h.service.completeLink("s1").signedIn->user.id;

  std::optional<AuthService::ProviderSignIn> viaApple = h.service.completeProvider(appleId("a-1", "sam@example.com", "Sam"));
  REQUIRE(viaApple.has_value());
  CHECK_EQ(viaApple->signedIn.user.id.str(), viaLink.str());
  CHECK_FALSE(viaApple->privateEmail);
  CHECK_EQ(h.repo.usersById.size(), 1u);
}

TEST(apple_with_hide_my_email_opens_a_new_account_and_flags_the_link_door) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId web = h.service.completeLink("s1").signedIn->user.id;

  std::optional<AuthService::ProviderSignIn> phone = h.service.completeProvider(appleId("a-1", kRelay, "Sam"));
  REQUIRE(phone.has_value());
  CHECK(phone->created);
  CHECK(phone->privateEmail);
  CHECK(phone->signedIn.user.id.str() != web.str());
  CHECK_EQ(h.repo.usersById.size(), 2u);
}

TEST(a_returning_relay_address_never_opens_a_third_account) {
  Harness h;
  const UserId phone = h.service.completeProvider(appleId("a-1", kRelay))->signedIn.user.id;
  h.repo.identities.clear();

  std::optional<AuthService::ProviderSignIn> again = h.service.completeProvider(appleId("a-1", kRelay));
  REQUIRE(again.has_value());
  CHECK_EQ(again->signedIn.user.id.str(), phone.str());
  CHECK_EQ(h.repo.usersById.size(), 1u);
}

TEST(an_unverified_provider_address_is_refused_outright) {
  Harness h;
  ProviderIdentity unverified = googleId("g-1", "sam@example.com");
  unverified.emailVerified = false;
  CHECK_FALSE(h.service.completeProvider(unverified).has_value());
  CHECK_EQ(h.repo.usersById.size(), 0u);

  ProviderIdentity subjectless = googleId("", "sam@example.com");
  CHECK_FALSE(h.service.completeProvider(subjectless).has_value());
  CHECK_EQ(h.repo.usersById.size(), 0u);
}

TEST(a_provider_sign_in_while_signed_in_attaches_rather_than_resolving) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId account = h.service.completeLink("s1").signedIn->user.id;

  CHECK(h.service.attachIdentity(account, appleId("a-1", kRelay)) == AuthService::AttachOutcome::attached);
  CHECK_EQ(h.repo.usersById.size(), 1u);
  CHECK_EQ(h.repo.findIdentity(Provider::apple, "a-1")->str(), account.str());

  CHECK(h.service.attachIdentity(account, appleId("a-1", kRelay)) == AuthService::AttachOutcome::alreadyMine);
  const UserId other = h.service.completeProvider(googleId("g-9", "other@example.com"))->signedIn.user.id;
  CHECK(h.service.attachIdentity(other, appleId("a-1", kRelay)) == AuthService::AttachOutcome::takenByAnother);
  CHECK_EQ(h.repo.findIdentity(Provider::apple, "a-1")->str(), account.str());
}

TEST(linking_moves_the_doors_and_deletes_the_empty_account) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId web = h.service.completeLink("s1").signedIn->user.id;
  const UserId phone = h.service.completeProvider(appleId("a-1", kRelay))->signedIn.user.id;
  CHECK_EQ(h.repo.usersById.size(), 2u);

  h.requestLink("sam@example.com");  // s3/d3
  AuthService::LinkResult result = h.service.linkAccount(phone, h.lastLinkSecret());
  CHECK(result.outcome == AuthService::LinkOutcome::linked);
  REQUIRE(result.signedIn.has_value());
  CHECK_EQ(result.signedIn->user.id.str(), web.str());

  CHECK_EQ(h.repo.usersById.size(), 1u);
  CHECK_FALSE(h.repo.findUserById(phone).has_value());
  CHECK_EQ(h.repo.findIdentity(Provider::apple, "a-1")->str(), web.str());
  CHECK_EQ(h.service.completeProvider(appleId("a-1", kRelay))->signedIn.user.id.str(), web.str());
}

TEST(linking_is_refused_when_the_callers_account_holds_data) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId web = h.service.completeLink("s1").signedIn->user.id;
  const UserId phone = h.service.completeProvider(appleId("a-1", kRelay))->signedIn.user.id;
  h.footprint.withData.insert(phone.str());

  h.requestLink("sam@example.com");
  const std::string secret = h.lastLinkSecret();
  AuthService::LinkResult result = h.service.linkAccount(phone, secret);
  CHECK(result.outcome == AuthService::LinkOutcome::notEmpty);
  CHECK_FALSE(result.signedIn.has_value());
  CHECK_EQ(h.repo.usersById.size(), 2u);
  CHECK(h.repo.findUserById(phone).has_value());
  CHECK_EQ(h.repo.findIdentity(Provider::apple, "a-1")->str(), phone.str());

  CHECK_FALSE(h.repo.findLink(h.service.digestOf(secret))->consumed);
  h.footprint.withData.clear();
  CHECK(h.service.linkAccount(phone, secret).outcome == AuthService::LinkOutcome::linked);
}

TEST(linking_to_the_account_you_are_already_on_is_a_no_op) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId account = h.service.completeLink("s1").signedIn->user.id;

  h.requestLink("sam@example.com");
  AuthService::LinkResult result = h.service.linkAccount(account, h.lastLinkSecret());
  CHECK(result.outcome == AuthService::LinkOutcome::sameAccount);
  CHECK_FALSE(result.signedIn.has_value());
  CHECK_EQ(h.repo.usersById.size(), 1u);
  CHECK(h.repo.findUserById(account).has_value());
}

TEST(linking_refuses_a_spent_or_unknown_link) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId web = h.service.completeLink("s1").signedIn->user.id;
  const UserId phone = h.service.completeProvider(appleId("a-1", kRelay))->signedIn.user.id;

  CHECK(h.service.linkAccount(phone, "s1").outcome == AuthService::LinkOutcome::badLink);
  CHECK(h.service.linkAccount(phone, "s-never").outcome == AuthService::LinkOutcome::badLink);

  h.requestLink("sam@example.com");
  h.clock.now += AuthPolicy::linkLifetimeMs;
  CHECK(h.service.linkAccount(phone, h.lastLinkSecret()).outcome == AuthService::LinkOutcome::badLink);
  CHECK_EQ(h.repo.usersById.size(), 2u);
  CHECK_EQ(h.repo.findIdentity(Provider::apple, "a-1")->str(), phone.str());
}

TEST(a_fork_request_sends_the_fork_mail_naming_the_source) {
  Harness h;
  ForkDescription source{"Learn to sail", "12 steps"};
  CHECK(h.requestLink("sam@example.com", "t_source", source) == AuthService::RequestResult::sent);

  REQUIRE_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].to.value, std::string("sam@example.com"));
  CHECK_EQ(h.email.sent[0].url, std::string("https://windmill.works/#/auth?token=s1"));
  CHECK_EQ(h.email.sent[0].templateId, std::string("magic-link-fork"));
  CHECK_EQ(h.email.sent[0].sourceTitle, std::string("Learn to sail"));
  CHECK_EQ(h.email.sent[0].sourceMeta, std::string("12 steps"));
  CHECK_EQ(h.repo.findLink("d1")->forkSource, std::string("t_source"));
}

TEST(a_fork_description_is_forwarded_word_for_word) {
  Harness h;
  ForkDescription source{"Plant one seed", "1 step"};
  CHECK(h.requestLink("sam@example.com", "t_source", source) == AuthService::RequestResult::sent);

  REQUIRE_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].sourceTitle, std::string("Plant one seed"));
  CHECK_EQ(h.email.sent[0].sourceMeta, std::string("1 step"));
}

TEST(a_fork_request_with_an_unreadable_source_falls_back_to_the_plain_mail) {
  Harness h;
  CHECK(h.requestLink("sam@example.com", "t_ghost", std::nullopt) == AuthService::RequestResult::sent);

  REQUIRE_EQ(h.email.sent.size(), 1u);
  CHECK_EQ(h.email.sent[0].templateId, std::string("magic-link"));
  CHECK_EQ(h.email.sent[0].sourceTitle, std::string(""));
  CHECK_EQ(h.email.sent[0].sourceMeta, std::string(""));
  CHECK_EQ(h.repo.findLink("d1")->forkSource, std::string("t_ghost"));
}

TEST(a_pending_fork_rides_the_link_from_request_to_completion) {
  Harness h;
  CHECK(h.requestLink("sam@example.com", "t_source") == AuthService::RequestResult::sent);
  CHECK_EQ(h.repo.findLink("d1")->forkSource, std::string("t_source"));

  AuthService::Completion done = h.service.completeLink("s1");
  CHECK(done.verdict == LinkVerdict::valid);
  CHECK(done.signedIn.has_value());
  CHECK_EQ(done.forkSource, std::string("t_source"));
}

TEST(a_plain_link_completes_with_no_pending_fork) {
  Harness h;
  h.requestLink("sam@example.com");
  AuthService::Completion done = h.service.completeLink("s1");
  CHECK(done.verdict == LinkVerdict::valid);
  CHECK_EQ(done.forkSource, std::string(""));
}

TEST(complete_link_is_single_use) {
  Harness h;
  h.requestLink("sam@example.com");
  CHECK(h.service.completeLink("s1").verdict == LinkVerdict::valid);

  AuthService::Completion second = h.service.completeLink("s1");
  CHECK(second.verdict == LinkVerdict::alreadyUsed);
  CHECK_FALSE(second.signedIn.has_value());
}

TEST(complete_link_loses_the_race_when_a_concurrent_verify_already_spent_it) {
  struct LostRaceRepo : FakeAuthRepository {
    bool consumeLink(const std::string&, UnixMs) override { return false; }
  } repo;
  FakeOAuthRepository oauthRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  AuthService service{repo, email, tokens, clock, oauth, footprint, "https://windmill.works"};
  repo.insertLink("d1", "", Email{"sam@example.com"}, clock.now, clock.now + AuthPolicy::linkLifetimeMs, "");

  AuthService::Completion done = service.completeLink("s1");  // digestOf("s1") == "d1"
  CHECK(done.verdict == LinkVerdict::alreadyUsed);
  CHECK_FALSE(done.signedIn.has_value());
  CHECK_EQ(repo.sessions.size(), 0u);
  CHECK_EQ(repo.usersById.size(), 0u);
}

TEST(complete_link_expires_after_fifteen_minutes) {
  Harness h;
  h.requestLink("sam@example.com");
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
  h.requestLink("sam@example.com");
  const std::string session = h.service.completeLink("s1").signedIn->sessionSecret;  // s2

  h.clock.now += 24ull * 60 * 60 * 1000;
  std::optional<User> user = h.service.authenticate(session);
  REQUIRE(user.has_value());
  CHECK_EQ(user->email.value, std::string("sam@example.com"));
  CHECK_EQ(h.repo.findSession("d2")->expiresAt, h.clock.now + AuthPolicy::sessionLifetimeMs);
}

TEST(authenticate_declines_an_expired_or_empty_or_unknown_session) {
  Harness h;
  h.requestLink("sam@example.com");
  const std::string session = h.service.completeLink("s1").signedIn->sessionSecret;

  CHECK_FALSE(h.service.authenticate("").has_value());
  CHECK_FALSE(h.service.authenticate("s999").has_value());

  h.clock.now += AuthPolicy::sessionLifetimeMs;
  CHECK_FALSE(h.service.authenticate(session).has_value());
}

TEST(sign_out_drops_the_session) {
  Harness h;
  h.requestLink("sam@example.com");
  const std::string session = h.service.completeLink("s1").signedIn->sessionSecret;

  h.service.signOut(session);
  CHECK_FALSE(h.service.authenticate(session).has_value());
  CHECK_EQ(h.repo.sessions.size(), 0u);
}

TEST(update_name_trims_and_persists_and_rejects_blank_or_over_cap) {
  Harness h;
  h.requestLink("sam@example.com");
  const UserId account = h.service.completeLink("s1").signedIn->user.id;

  std::optional<User> renamed = h.service.updateName(account, "  Samwise Gamgee  ");
  REQUIRE(renamed.has_value());
  CHECK_EQ(renamed->name, std::string("Samwise Gamgee"));
  CHECK_EQ(h.repo.usersById[account.str()].name, std::string("Samwise Gamgee"));

  CHECK_FALSE(h.service.updateName(account, "   ").has_value());
  CHECK_EQ(h.repo.usersById[account.str()].name, std::string("Samwise Gamgee"));

  const std::string tooLong(AuthPolicy::nameMaxBytes + 1, 'x');
  CHECK_FALSE(h.service.updateName(account, tooLong).has_value());
  CHECK_EQ(h.repo.usersById[account.str()].name, std::string("Samwise Gamgee"));
  const std::string atCap(AuthPolicy::nameMaxBytes, 'y');
  std::optional<User> capped = h.service.updateName(account, atCap);
  REQUIRE(capped.has_value());
  CHECK_EQ(capped->name, atCap);
}

TEST(list_sessions_flags_the_callers_current_session) {
  Harness h;
  h.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");                        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.requestLink("sam@example.com");                                          // s3/d3
  const std::string other = h.service.completeLink("s3").signedIn->sessionSecret;    // s4/d4

  std::vector<SessionView> list = h.service.listSessions(account, current);
  CHECK_EQ(list.size(), 2u);
  int currentCount = 0;
  for (const SessionView& v : list) if (v.current) ++currentCount;
  CHECK_EQ(currentCount, 1);
}

TEST(list_sessions_coalesces_a_zero_last_seen_to_the_created_time) {
  Harness h;
  h.requestLink("sam@example.com");                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  const UnixMs createdAt = h.clock.now;
  h.repo.sessions["d2"].lastSeenMs = 0;

  std::vector<SessionView> list = h.service.listSessions(account, current);
  REQUIRE_EQ(list.size(), 1u);
  CHECK_EQ(list[0].createdMs, createdAt);
  CHECK_EQ(list[0].lastSeenMs, createdAt);  // coalesced from 0 to the created time
  CHECK(list[0].current);
}

TEST(authenticate_heals_a_pre_migration_rows_user_agent_and_last_seen) {
  Harness h;
  h.requestLink("sam@example.com");                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.repo.sessions["d2"].userAgent = "";  // blank UA, zero last_seen
  h.repo.sessions["d2"].lastSeenMs = 0;

  h.clock.now += 60'000;
  const UnixMs seenAt = h.clock.now;
  CHECK(h.service.authenticate(current, SessionContext{"Firefox/128", "203.0.113.7"}).has_value());

  std::vector<SessionView> list = h.service.listSessions(account, current);
  REQUIRE_EQ(list.size(), 1u);
  CHECK_EQ(list[0].userAgent, std::string("Firefox/128"));
  CHECK_EQ(list[0].ip, std::string("203.0.113.7"));
  CHECK_EQ(list[0].lastSeenMs, seenAt);
}

TEST(revoke_session_revokes_one_flags_the_current_and_404s_unknown) {
  Harness h;
  h.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");                        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.requestLink("sam@example.com");                                          // s3/d3
  const std::string other = h.service.completeLink("s3").signedIn->sessionSecret;    // s4/d4

  std::string currentId, otherId;
  for (const SessionView& v : h.service.listSessions(account, current))
    (v.current ? currentId : otherId) = v.id;
  CHECK_FALSE(currentId.empty());
  CHECK_FALSE(otherId.empty());

  CHECK(h.service.revokeSession(account, "sess-nope", current) == AuthService::RevokeOutcome::notFound);

  CHECK(h.service.revokeSession(account, otherId, current) == AuthService::RevokeOutcome::revoked);
  CHECK_FALSE(h.service.authenticate(other).has_value());
  CHECK(h.service.authenticate(current).has_value());

  CHECK(h.service.revokeSession(account, currentId, current) == AuthService::RevokeOutcome::revokedCurrent);
  CHECK_FALSE(h.service.authenticate(current).has_value());
  CHECK_EQ(h.repo.sessions.size(), 0u);
}

TEST(revoke_session_of_another_account_is_not_found) {
  Harness h;
  h.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion sam = h.service.completeLink("s1");                         // s2/d2
  const UserId account = sam.signedIn->user.id;

  h.requestLink("eve@example.com");                                          // s3/d3
  const std::string eveSession = h.service.completeLink("s3").signedIn->sessionSecret;  // s4/d4
  const UserId eve = h.repo.usersByEmail["eve@example.com"].id;
  const std::string eveId = h.service.listSessions(eve, eveSession)[0].id;

  CHECK(h.service.revokeSession(account, eveId, sam.signedIn->sessionSecret) == AuthService::RevokeOutcome::notFound);
  CHECK(h.service.authenticate(eveSession).has_value());
}

TEST(sign_out_everywhere_keeps_the_caller_current_and_drops_the_rest) {
  Harness h;
  h.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion done = h.service.completeLink("s1");                        // s2/d2
  const std::string current = done.signedIn->sessionSecret;
  const UserId account = done.signedIn->user.id;

  h.requestLink("sam@example.com");                                          // s3/d3
  const std::string other = h.service.completeLink("s3").signedIn->sessionSecret;    // s4/d4
  CHECK_EQ(h.repo.sessions.size(), 2u);

  h.service.signOutEverywhere(account, current);

  CHECK_EQ(h.repo.sessions.size(), 1u);
  CHECK(h.service.authenticate(current).has_value());
  CHECK_FALSE(h.service.authenticate(other).has_value());
}

TEST(authenticate_refuses_a_session_whose_account_is_closed) {
  Harness h;
  h.requestLink("sam@example.com");
  AuthService::Completion done = h.service.completeLink("s1");
  const std::string session = done.signedIn->sessionSecret;  // s2/d2
  CHECK(h.service.authenticate(session).has_value());

  h.repo.markUserDeleted(done.signedIn->user.id, h.clock.now);
  CHECK_FALSE(h.service.authenticate(session).has_value());
  CHECK_EQ(h.repo.sessions.size(), 1u);
}

TEST(close_account_drops_every_session_disconnects_tools_and_returns_the_grace_end) {
  Harness h;
  h.requestLink("sam@example.com");                                          // s1/d1
  AuthService::Completion first = h.service.completeLink("s1");                       // s2/d2
  const UserId account = first.signedIn->user.id;
  const std::string staleSession = first.signedIn->sessionSecret;

  h.requestLink("sam@example.com");                                          // s3/d3
  const std::string otherSession = h.service.completeLink("s3").signedIn->sessionSecret;  // s4/d4

  h.oauthRepo.recordGrant(account, "client-abc", h.clock.now, "");
  CHECK_EQ(h.oauth.listGrants(account).size(), 1u);

  const UnixMs closesMs = h.service.closeAccount(account);
  CHECK_EQ(closesMs, h.clock.now + AuthPolicy::closeGraceMs);
  CHECK_EQ(h.repo.sessions.size(), 0u);
  CHECK_FALSE(h.service.authenticate(staleSession).has_value());
  CHECK_FALSE(h.service.authenticate(otherSession).has_value());
  CHECK_EQ(h.oauth.listGrants(account).size(), 0u);
  CHECK(h.repo.usersById[account.str()].deletedAt.has_value());
}

TEST(a_within_grace_magic_link_sign_in_revives_the_account_and_reissues_a_session) {
  Harness h;
  h.requestLink("sam@example.com");                                          // s1/d1
  const UserId account = h.service.completeLink("s1").signedIn->user.id;             // s2/d2
  h.service.closeAccount(account);
  CHECK(h.repo.usersById[account.str()].deletedAt.has_value());

  h.clock.now += 24ull * 60 * 60 * 1000;
  h.requestLink("sam@example.com");                                          // s3/d3
  AuthService::Completion revived = h.service.completeLink("s3");                     // s4/d4
  CHECK(revived.verdict == LinkVerdict::valid);
  REQUIRE(revived.signedIn.has_value());
  CHECK_EQ(revived.signedIn->user.id.str(), account.str());
  REQUIRE_EQ(h.repo.usersById.size(), 1u);
  CHECK_FALSE(h.repo.usersById[account.str()].deletedAt.has_value());
  CHECK_FALSE(revived.signedIn->user.deletedAt.has_value());

  std::optional<User> back = h.service.authenticate(revived.signedIn->sessionSecret);
  REQUIRE(back.has_value());
  CHECK_EQ(back->email.value, std::string("sam@example.com"));
}

// ── The code door: the same mint, typed instead of tapped ─────────────────────────────────────

TEST(every_mint_stores_both_credentials_on_one_row) {
  Harness h;
  CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::sent);

  REQUIRE_EQ(h.repo.links.size(), 1u);
  CHECK_EQ(h.repo.links["d1"].codeDigest, std::string("d00001"));  // digestOf("100001")
  CHECK_EQ(h.repo.links["d1"].attempts, 0);
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-link"));
  CHECK_EQ(h.email.sent.back().code, std::string(""));
  AuthService::CodeCompletion done = h.service.completeCode("sam@example.com", "100001");
  CHECK(done.verdict == CodeVerdict::valid);
  REQUIRE(done.signedIn.has_value());
  CHECK_EQ(done.signedIn->user.email.value, std::string("sam@example.com"));
}

TEST(the_app_door_mails_the_code_and_any_other_door_mails_the_link) {
  Harness h;
  CHECK(h.requestCode("sam@example.com") == AuthService::RequestResult::sent);
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-code"));
  CHECK_EQ(h.email.sent.back().to.value, std::string("sam@example.com"));
  CHECK_EQ(h.email.sent.back().code, std::string("100001"));
  CHECK_EQ(h.email.sent.back().url, std::string(""));

  CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::sent);
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-link"));
  CHECK(h.requestLink("sam@example.com", "", std::nullopt, "toaster") ==
        AuthService::RequestResult::sent);
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-link"));
}

TEST(complete_code_signs_in_through_the_same_tail_and_burns_the_links_row) {
  Harness h;
  h.requestCode("sam@example.com");  // token s1/d1 + code 100001

  AuthService::CodeCompletion done = h.service.completeCode("sam@example.com", h.lastCode());
  CHECK(done.verdict == CodeVerdict::valid);
  REQUIRE(done.signedIn.has_value());
  CHECK_EQ(done.signedIn->user.email.value, std::string("sam@example.com"));
  CHECK_EQ(done.signedIn->user.name, std::string("sam"));
  CHECK_EQ(done.signedIn->sessionSecret, std::string("s2"));
  std::optional<StoredSession> session = h.repo.findSession("d2");
  REQUIRE(session.has_value());
  CHECK_EQ(session->user.str(), done.signedIn->user.id.str());
  CHECK_EQ(session->expiresAt, h.clock.now + AuthPolicy::sessionLifetimeMs);

  CHECK(h.service.completeCode("sam@example.com", h.lastCode()).verdict == CodeVerdict::noLiveCode);
  CHECK(h.service.completeLink("s1").verdict == LinkVerdict::alreadyUsed);
}

TEST(spending_the_link_kills_its_code_twin) {
  Harness h;
  h.requestCode("sam@example.com");
  CHECK(h.service.completeLink("s1").verdict == LinkVerdict::valid);
  CHECK(h.service.completeCode("sam@example.com", "100001").verdict == CodeVerdict::noLiveCode);
}

TEST(complete_code_spends_an_attempt_only_on_a_wrong_guess_against_a_live_row) {
  Harness h;
  h.requestCode("sam@example.com");

  CHECK(h.service.completeCode("sam@example.com", "999999").verdict == CodeVerdict::wrongCode);
  CHECK_EQ(h.repo.links["d1"].attempts, 1);
  CHECK(h.service.completeCode("nobody@example.com", "100001").verdict == CodeVerdict::noLiveCode);
  CHECK(h.service.completeCode("sam@example", "100001").verdict == CodeVerdict::noLiveCode);
  CHECK_EQ(h.repo.links["d1"].attempts, 1);

  h.clock.now += AuthPolicy::linkLifetimeMs;
  CHECK(h.service.completeCode("sam@example.com", "100001").verdict == CodeVerdict::noLiveCode);
  CHECK_EQ(h.repo.links["d1"].attempts, 1);
  CHECK_EQ(h.repo.sessions.size(), 0u);
}

TEST(the_guess_before_the_cap_can_still_be_the_right_one) {
  Harness h;
  h.requestCode("sam@example.com");
  for (int guess = 0; guess < AuthPolicy::maxCodeAttempts - 1; ++guess)
    CHECK(h.service.completeCode("sam@example.com", "999999").verdict == CodeVerdict::wrongCode);

  CHECK(h.service.completeCode("sam@example.com", h.lastCode()).verdict == CodeVerdict::valid);
}

TEST(five_wrong_guesses_kill_the_code_even_for_the_right_one) {
  Harness h;
  h.requestCode("sam@example.com");
  const std::string code = h.lastCode();
  for (int guess = 0; guess < AuthPolicy::maxCodeAttempts; ++guess)
    CHECK(h.service.completeCode("sam@example.com", "999999").verdict == CodeVerdict::wrongCode);
  CHECK_EQ(h.repo.links["d1"].attempts, AuthPolicy::maxCodeAttempts);

  CHECK(h.service.completeCode("sam@example.com", code).verdict == CodeVerdict::noLiveCode);
  CHECK_EQ(h.repo.links["d1"].attempts, AuthPolicy::maxCodeAttempts);
  CHECK_EQ(h.repo.sessions.size(), 0u);

  h.clock.now += 1;
  h.requestCode("sam@example.com");
  CHECK(h.service.completeCode("sam@example.com", h.lastCode()).verdict == CodeVerdict::valid);
}

TEST(racing_wrong_guesses_can_never_push_attempts_past_the_cap) {
  Harness h;
  h.requestCode("sam@example.com");
  for (int guess = 0; guess < AuthPolicy::maxCodeAttempts - 1; ++guess)
    CHECK(h.service.completeCode("sam@example.com", "999999").verdict == CodeVerdict::wrongCode);

  CHECK(h.repo.findLiveCode(Email{"sam@example.com"}, h.clock.now, AuthPolicy::maxCodeAttempts)
            .has_value());
  CHECK(h.repo.findLiveCode(Email{"sam@example.com"}, h.clock.now, AuthPolicy::maxCodeAttempts)
            .has_value());
  CHECK_EQ(h.repo.spendCodeAttempt("d1", AuthPolicy::maxCodeAttempts), AuthPolicy::maxCodeAttempts);
  CHECK_EQ(h.repo.spendCodeAttempt("d1", AuthPolicy::maxCodeAttempts), 0);
  CHECK_EQ(h.repo.links["d1"].attempts, AuthPolicy::maxCodeAttempts);
}

TEST(a_resend_supersedes_the_code_before_it) {
  Harness h;
  h.requestCode("sam@example.com");  // code 100001 on row d1
  const std::string oldCode = h.lastCode();
  h.clock.now += 1'000;
  h.requestCode("sam@example.com");  // code 100002 on row d2

  CHECK(h.service.completeCode("sam@example.com", oldCode).verdict == CodeVerdict::wrongCode);
  CHECK_EQ(h.repo.links["d2"].attempts, 1);
  CHECK_EQ(h.repo.links["d1"].attempts, 0);

  CHECK(h.service.completeCode("sam@example.com", h.lastCode()).verdict == CodeVerdict::valid);
}

TEST(complete_code_loses_the_race_when_a_concurrent_verify_already_spent_the_row) {
  struct LostRaceRepo : FakeAuthRepository {
    bool consumeLink(const std::string&, UnixMs) override { return false; }
  } repo;
  FakeOAuthRepository oauthRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  AuthService service{repo, email, tokens, clock, oauth, footprint, "https://windmill.works"};
  repo.insertLink("d1", "d83201", Email{"sam@example.com"}, clock.now,
                  clock.now + AuthPolicy::linkLifetimeMs, "");

  AuthService::CodeCompletion done = service.completeCode("sam@example.com", "483201");
  CHECK(done.verdict == CodeVerdict::noLiveCode);
  CHECK_FALSE(done.signedIn.has_value());
  CHECK_EQ(repo.sessions.size(), 0u);
  CHECK_EQ(repo.usersById.size(), 0u);
}

TEST(a_within_grace_code_sign_in_revives_the_account) {
  Harness h;
  h.requestLink("sam@example.com");                                        // s1/d1
  const UserId account = h.service.completeLink("s1").signedIn->user.id;   // s2/d2
  h.service.closeAccount(account);
  CHECK(h.repo.usersById[account.str()].deletedAt.has_value());

  h.clock.now += 24ull * 60 * 60 * 1000;  // a day into the 30-day grace
  h.requestCode("sam@example.com");
  AuthService::CodeCompletion revived = h.service.completeCode("sam@example.com", h.lastCode());
  CHECK(revived.verdict == CodeVerdict::valid);
  REQUIRE(revived.signedIn.has_value());
  CHECK_EQ(revived.signedIn->user.id.str(), account.str());
  CHECK_FALSE(revived.signedIn->user.deletedAt.has_value());
  CHECK_FALSE(h.repo.usersById[account.str()].deletedAt.has_value());
  CHECK(h.service.authenticate(revived.signedIn->sessionSecret).has_value());
}

TEST(the_code_door_spends_the_same_per_email_budget_as_the_link_door) {
  Harness h;
  for (int i = 0; i < AuthPolicy::maxLinksPerWindow; ++i)
    CHECK(h.requestCode("sam@example.com") == AuthService::RequestResult::sent);
  CHECK(h.requestCode("sam@example.com") == AuthService::RequestResult::rateLimited);
  CHECK(h.requestLink("sam@example.com") == AuthService::RequestResult::rateLimited);
}

TEST(a_pending_fork_rides_the_row_whichever_credential_spends_it) {
  Harness h;
  CHECK(h.requestLink("sam@example.com", "t_source", std::nullopt, "app") ==
        AuthService::RequestResult::sent);
  CHECK_EQ(h.email.sent.back().templateId, std::string("magic-code"));

  AuthService::CodeCompletion done = h.service.completeCode("sam@example.com", h.lastCode());
  CHECK(done.verdict == CodeVerdict::valid);
  CHECK_EQ(done.forkSource, std::string("t_source"));
}
