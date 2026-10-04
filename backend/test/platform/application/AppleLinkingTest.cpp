#include "test/platform/AppleLinkingFixture.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

TEST(apple_ticket_is_the_only_write_before_the_answer_for_relay_and_real_addresses) {
  for (const bool relay : {false, true}) {
    AppleLinkingFixture f;
    f.verifier->identity->relayEmail = relay;
    f.verifier->identity->email = Email{relay ? "relay@privaterelay.appleid.com" : "new@example.com"};
    f.verifier->identity->name = "  Sam Gold  ";
    const auto start = f.auth->beginApple(f.identity());
    CHECK(!start.signIn);
    REQUIRE(!start.ticket.empty());
    CHECK_EQ(start.expiresAt, f.clock.now + AuthPolicy::appleTicketLifetimeMs);
    CHECK(f.repo.usersById.empty());
    CHECK(f.repo.identities.empty());
    CHECK(f.repo.sessions.empty());
    CHECK(!f.repo.appleTickets.count(start.ticket));
    const auto stored = f.repo.findAppleTicket(f.tokens.digestOf(start.ticket), f.clock.now);
    REQUIRE(stored);
    CHECK_EQ(stored->identity.name, std::string("Sam Gold"));
    CHECK_EQ(stored->identity.relayEmail, relay);
    const auto created = f.auth->createApple(start.ticket, {"phone", "ip"});
    REQUIRE(created.signIn);
    CHECK(created.signIn->created);
    CHECK_EQ(created.signIn->privateEmail, relay);
    CHECK_EQ(created.signIn->signedIn.user.name, std::string("Sam Gold"));
    CHECK_EQ(f.repo.identities.size(), std::size_t{1});
    CHECK_EQ(f.repo.sessions.size(), std::size_t{1});
    CHECK(f.auth->createApple(start.ticket).outcome == AppleTicketOutcome::expired);
  }
}

TEST(apple_known_subject_and_verified_address_sign_in_without_a_ticket_or_rename) {
  for (const bool bound : {false, true}) {
    AppleLinkingFixture f;
    const auto user = f.user(f.identity().email.value);
    if (bound) f.repo.bindIdentity(Provider::apple, f.identity().subject, user.id, user.email.value);
    f.verifier->identity->name = "Changed";
    if (bound) { f.verifier->identity->email = Email{""}; f.verifier->identity->emailVerified = false; }
    const auto start = f.auth->beginApple(f.identity());
    REQUIRE(start.signIn);
    CHECK_EQ(start.signIn->signedIn.user.id, user.id);
    CHECK_EQ(start.signIn->signedIn.user.name, user.name);
    CHECK(!start.signIn->created);
    CHECK(start.ticket.empty());
    CHECK(f.repo.appleTickets.empty());
    CHECK_EQ(f.repo.usersById.size(), std::size_t{1});
  }
}

TEST(apple_unverified_empty_or_wrong_provider_identities_cannot_start) {
  for (const int state : {0, 1, 2, 3}) {
    AppleLinkingFixture f;
    if (state == 0) f.verifier->identity->subject.clear();
    if (state == 1) f.verifier->identity->emailVerified = false;
    if (state == 2) f.verifier->identity->email = Email{""};
    if (state == 3) f.verifier->identity->provider = Provider::google;
    const auto result = f.auth->beginApple(f.identity());
    CHECK(!result.signIn);
    CHECK(result.ticket.empty());
    CHECK(f.repo.appleTickets.empty());
  }
}

TEST(apple_dead_ticket_precedes_code_and_spends_neither_attempt_nor_code) {
  for (const int state : {0, 1, 2}) {
    AppleLinkingFixture f;
    auto ticket = f.ticket();
    const auto code = f.code();
    if (state == 0) ticket = "unknown";
    if (state == 1) f.repo.spentAppleTickets.insert(f.tokens.digestOf(ticket));
    if (state == 2) f.clock.now += AuthPolicy::appleTicketLifetimeMs;
    const auto result = f.auth->completeCode("sam@example.com", code, {}, ticket);
    CHECK(result.appleOutcome == AppleTicketOutcome::expired);
    CHECK(!result.signedIn);
    for (const auto& [digest, row] : f.repo.links) { CHECK(!row.consumedAt); CHECK_EQ(row.attempts, 0); }
    CHECK(f.repo.usersById.empty());
    CHECK(f.auth->createApple(ticket).outcome == AppleTicketOutcome::expired);
  }
}

TEST(apple_code_wrong_or_exhausted_keeps_ticket_and_creates_nothing) {
  AppleLinkingFixture f;
  const auto ticket = f.ticket();
  const auto code = f.code();
  for (int i = 0; i < AuthPolicy::maxCodeAttempts; ++i) {
    const auto result = f.auth->completeCode("sam@example.com", "000000", {}, ticket);
    CHECK(result.verdict == CodeVerdict::wrongCode);
    CHECK(result.appleOutcome == AppleTicketOutcome::completed);
    CHECK(!result.signedIn);
  }
  CHECK(f.auth->completeCode("sam@example.com", code, {}, ticket).verdict == CodeVerdict::noLiveCode);
  CHECK(f.repo.findAppleTicket(f.tokens.digestOf(ticket), f.clock.now));
  CHECK(f.repo.usersById.empty());
}

TEST(apple_proven_address_with_no_account_spends_code_keeps_ticket_and_can_then_create) {
  AppleLinkingFixture f;
  const auto ticket = f.ticket();
  const auto code = f.code();
  const auto result = f.auth->completeCode("sam@example.com", code, {}, ticket);
  CHECK(result.appleOutcome == AppleTicketOutcome::noAccount);
  CHECK(!result.signedIn);
  CHECK(!f.repo.findLiveCode(Email{"sam@example.com"}, f.clock.now, AuthPolicy::maxCodeAttempts));
  CHECK(f.repo.findAppleTicket(f.tokens.digestOf(ticket), f.clock.now));
  CHECK(f.repo.usersById.empty());
  CHECK(f.repo.identities.empty());
  CHECK(f.repo.sessions.empty());
  CHECK(f.auth->createApple(ticket).signIn);
}

TEST(apple_proven_address_attaches_and_signs_in_only_to_the_existing_account) {
  AppleLinkingFixture f;
  const auto user = f.user();
  const auto ticket = f.ticket();
  const auto result = f.auth->completeCode(" SAM@example.com ", f.code(), {}, ticket);
  REQUIRE(result.signedIn);
  CHECK(result.appleAttached);
  CHECK_EQ(result.signedIn->user.id, user.id);
  CHECK_EQ(f.repo.findIdentity(Provider::apple, f.identity().subject), std::optional<UserId>{user.id});
  CHECK_EQ(f.repo.usersById.size(), std::size_t{1});
  CHECK(f.auth->createApple(ticket).outcome == AppleTicketOutcome::expired);
}

TEST(apple_subject_bound_during_question_refuses_code_attachment_and_creation_without_touching_owner) {
  for (const bool create : {false, true}) {
    AppleLinkingFixture f;
    const auto target = f.user();
    const auto ticket = f.ticket();
    const auto other = f.user("other@example.com");
    f.repo.bindIdentity(Provider::apple, f.identity().subject, other.id, "original@example.com");
    if (create) CHECK(f.auth->createApple(ticket).outcome == AppleTicketOutcome::identityTaken);
    else CHECK(f.auth->completeCode(target.email.value, f.code(), {}, ticket).appleOutcome == AppleTicketOutcome::identityTaken);
    CHECK_EQ(f.repo.findIdentity(Provider::apple, f.identity().subject), std::optional<UserId>{other.id});
    CHECK_EQ(f.repo.usersById.size(), std::size_t{2});
    CHECK(f.repo.sessions.empty());
    CHECK(f.repo.findAppleTicket(f.tokens.digestOf(ticket), f.clock.now));
  }
}

TEST(apple_attachment_moves_only_an_empty_account_and_reports_its_revoked_sessions) {
  for (const bool data : {false, true}) {
    AppleLinkingFixture f;
    const auto mine = f.user();
    const auto other = f.user("other@example.com");
    f.session(other, "s-old");
    f.repo.bindIdentity(Provider::apple, f.identity().subject, other.id, f.identity().email.value);
    if (data) f.footprint.withData.insert(other.id.str());
    const auto result = f.auth->attachIdentity(mine.id, f.identity());
    if (data) {
      CHECK(result == AuthService::AttachOutcome::takenByAnother);
      CHECK(f.repo.findUserById(other.id));
      CHECK(f.repo.findSession(f.tokens.digestOf("s-old")));
      CHECK(f.revocations.digests.empty());
    } else {
      CHECK(result == AuthService::AttachOutcome::attached);
      CHECK(!f.repo.findUserById(other.id));
      CHECK(!f.repo.findSession(f.tokens.digestOf("s-old")));
      CHECK_EQ(f.revocations.digests, (std::vector<std::string>{f.tokens.digestOf("s-old")}));
      CHECK(f.auth->attachIdentity(mine.id, f.identity()) == AuthService::AttachOutcome::alreadyMine);
    }
  }
}

TEST(apple_takeover_recheck_can_refuse_without_mutation_and_removal_keeps_email_and_sessions) {
  AppleLinkingFixture f;
  const auto mine = f.user();
  const auto other = f.user("other@example.com");
  f.session(mine, "s-mine");
  f.repo.bindIdentity(Provider::apple, f.identity().subject, other.id, f.identity().email.value);
  f.repo.refuseTakeOver = true;
  CHECK(f.auth->attachIdentity(mine.id, f.identity()) == AuthService::AttachOutcome::takenByAnother);
  CHECK(!f.auth->removeApple(mine.id));
  CHECK(f.auth->removeApple(other.id));
  CHECK(f.repo.findUserById(other.id));
  CHECK(f.repo.findSession(f.tokens.digestOf("s-mine")));
  CHECK(f.auth->attachIdentity(mine.id, f.identity()) == AuthService::AttachOutcome::attached);
  const auto methods = f.auth->signInMethods(mine.id);
  REQUIRE_EQ(methods.size(), std::size_t{1});
  CHECK_EQ(methods[0].email, f.identity().email.value);
  CHECK(methods[0].relay);
  CHECK(f.auth->removeApple(mine.id));
  CHECK(f.auth->signInMethods(mine.id).empty());
  CHECK(f.auth->authenticate("s-mine"));
}

TEST(apple_subject_only_attachment_reuses_or_moves_existing_doors_but_cannot_bind_a_new_one) {
  for (const int state : {0, 1, 2}) {
    AppleLinkingFixture f;
    const auto mine = f.user();
    if (state == 1) f.repo.tryBindIdentity(f.identity(), mine.id);
    if (state == 2) f.repo.tryBindIdentity(f.identity(), f.user("other@example.com").id);
    f.verifier->identity->email = Email{""};
    f.verifier->identity->emailVerified = false;
    const auto result = f.auth->attachIdentity(mine.id, f.identity());
    CHECK(result == (state == 0 ? AuthService::AttachOutcome::refused :
                    state == 1 ? AuthService::AttachOutcome::alreadyMine : AuthService::AttachOutcome::attached));
  }
}
