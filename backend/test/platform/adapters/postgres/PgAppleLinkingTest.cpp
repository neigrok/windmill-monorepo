#include "platform/adapters/postgres/PgAuthRepository.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <future>
#include <chrono>
#include <thread>
#include "products/roadmap/adapters/postgres/PgProgressRepository.h"

using namespace wm;

namespace {
struct Fixture {
  PgAuthRepository repo{pgTestPool(), std::make_shared<PgAccountFootprint>(pgTestPool(),
      std::vector<OwnedTable>{{"trees", "owner_id"}, {"node_progress", "user_id", true}, {"journal_page", "user_id"}, {"gym_sessions", "user_id"},
                              {"sync_replicas", "account"}})};
  User mine;
  User other;
  UnixMs now = 1'700'000'000'000;
  ProviderIdentity identity{Provider::apple, "pg-apple-linking", Email{"pg-apple-new@example.com"}, "Sam Gold", true, true};
  Fixture() : mine(create("pg-apple-mine@example.com")), other(create("pg-apple-other@example.com")) {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec("DELETE FROM magic_links WHERE token_hash LIKE 'pg-apple-%'");
    txn.exec("DELETE FROM apple_tickets WHERE token_hash LIKE 'pg-apple-%'");
    txn.exec("DELETE FROM user_identities WHERE subject LIKE 'pg-apple-%'");
    txn.commit();
  }
  User create(const std::string& email) {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec_params("DELETE FROM trees WHERE owner_id IN (SELECT id FROM users WHERE email=$1)", email);
    txn.exec_params("DELETE FROM sync_replicas WHERE account IN (SELECT id FROM users WHERE email=$1)", email);
    txn.exec_params("DELETE FROM node_progress WHERE user_id IN (SELECT id::text FROM users WHERE email=$1)", email);
    txn.exec_params("DELETE FROM feedback WHERE user_id IN (SELECT id FROM users WHERE email=$1)", email);
    txn.exec_params("DELETE FROM tend_runs WHERE user_id IN (SELECT id FROM users WHERE email=$1)", email);
    txn.exec_params("DELETE FROM users WHERE email=$1", email);
    txn.commit();
    return repo.createUser(Email{email}, "Sam");
  }
  ~Fixture() {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec("DELETE FROM trees WHERE owner_id IN (SELECT id FROM users WHERE email LIKE 'pg-apple-%')");
    txn.exec("DELETE FROM sync_replicas WHERE account IN (SELECT id FROM users WHERE email LIKE 'pg-apple-%')");
    txn.exec("DELETE FROM node_progress WHERE user_id IN (SELECT id::text FROM users WHERE email LIKE 'pg-apple-%')");
    txn.exec("DELETE FROM feedback WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pg-apple-%')");
    txn.exec("DELETE FROM tend_runs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pg-apple-%')");
    txn.exec("DELETE FROM org_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pg-apple-%')");
    txn.exec("DELETE FROM paddle_subscriptions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pg-apple-%')");
    txn.exec("DELETE FROM orgs WHERE id='00000000-0000-4000-8000-0000000000a9'");
    txn.exec("DELETE FROM users WHERE email LIKE 'pg-apple-%'");
    txn.exec("DELETE FROM magic_links WHERE token_hash LIKE 'pg-apple-%'");
    txn.exec("DELETE FROM apple_tickets WHERE token_hash LIKE 'pg-apple-%'");
    txn.commit();
  }
  void ticket(const std::string& digest = "pg-apple-ticket") {
    repo.insertAppleTicket(digest, {identity, now + AuthPolicy::appleTicketLifetimeMs});
  }
  AppleTicketResult redeem(const std::string& digest = "pg-apple-ticket", const std::optional<UserId>& target = std::nullopt,
                           const std::string& session = "pg-apple-session") {
    return repo.redeemAppleTicket(digest, now, target, "Sam Gold", session, sessionExpiry(now), "phone", "ip");
  }
};
}

TEST(pg_apple_tickets_roundtrip_verified_identity_and_expire_at_fifteen_minutes) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  auto stored = f.repo.findAppleTicket("pg-apple-ticket", f.now);
  REQUIRE(stored);
  CHECK_EQ(stored->identity.subject, f.identity.subject);
  CHECK_EQ(stored->identity.email, f.identity.email);
  CHECK_EQ(stored->identity.name, f.identity.name);
  CHECK(stored->identity.emailVerified);
  CHECK(stored->identity.relayEmail);
  CHECK_EQ(stored->expiresAt, f.now + AuthPolicy::appleTicketLifetimeMs);
  CHECK(f.repo.findAppleTicket("pg-apple-ticket", stored->expiresAt - 1));
  CHECK(!f.repo.findAppleTicket("pg-apple-ticket", stored->expiresAt));
  CHECK(!f.repo.findAppleTicket("raw-ticket-secret", f.now));
  CHECK(!f.repo.findUserByEmail(f.identity.email));
  f.now = stored->expiresAt;
  CHECK(f.redeem().outcome == AppleTicketOutcome::expired);
  CHECK(!f.repo.findSession("pg-apple-session"));
}

TEST(pg_apple_creation_spends_ticket_binds_metadata_and_mints_session_atomically) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  const auto result = f.redeem();
  REQUIRE(result.user);
  CHECK(result.outcome == AppleTicketOutcome::completed);
  CHECK(result.created);
  CHECK_EQ(result.user->name, std::string("Sam Gold"));
  CHECK_EQ(f.repo.findIdentity(Provider::apple, f.identity.subject), std::optional<UserId>{result.user->id});
  CHECK(f.repo.findSession("pg-apple-session"));
  CHECK(!f.repo.findAppleTicket("pg-apple-ticket", f.now));
  CHECK(f.redeem().outcome == AppleTicketOutcome::expired);
  const auto methods = f.repo.signInMethods(result.user->id);
  REQUIRE_EQ(methods.size(), std::size_t{1});
  CHECK_EQ(methods[0].email, f.identity.email.value);
  CHECK(methods[0].relay);
}

TEST(pg_apple_ticket_redeems_once_under_concurrent_requests) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  auto first = std::async(std::launch::async, [&] { return f.redeem("pg-apple-ticket", f.mine.id, "pg-apple-session-one"); });
  auto second = std::async(std::launch::async, [&] { return f.redeem("pg-apple-ticket", f.mine.id, "pg-apple-session-two"); });
  const auto a = first.get(), b = second.get();
  CHECK((a.outcome == AppleTicketOutcome::completed && b.outcome == AppleTicketOutcome::expired) ||
        (b.outcome == AppleTicketOutcome::completed && a.outcome == AppleTicketOutcome::expired));
  CHECK_EQ(f.repo.listSessions(f.mine.id).size(), std::size_t{1});
}

TEST(pg_apple_subject_race_rolls_back_creation_and_keeps_ticket_live) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  CHECK(f.repo.tryBindIdentity(f.identity, f.other.id));
  CHECK(f.redeem().outcome == AppleTicketOutcome::identityTaken);
  CHECK(f.redeem("pg-apple-ticket", f.mine.id).outcome == AppleTicketOutcome::identityTaken);
  CHECK(!f.repo.findUserByEmail(f.identity.email));
  CHECK(!f.repo.findSession("pg-apple-session"));
  CHECK(f.repo.findAppleTicket("pg-apple-ticket", f.now));
  CHECK_EQ(f.repo.findIdentity(Provider::apple, f.identity.subject), std::optional<UserId>{f.other.id});
  CHECK(!f.repo.tryBindIdentity(f.identity, f.mine.id));
}

TEST(pg_apple_distinct_tickets_cannot_bind_one_subject_to_different_accounts_concurrently) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket("pg-apple-one");
  f.ticket("pg-apple-two");
  auto first = std::async(std::launch::async, [&] { return f.redeem("pg-apple-one", f.mine.id, "pg-apple-session-one"); });
  auto second = std::async(std::launch::async, [&] { return f.redeem("pg-apple-two", f.other.id, "pg-apple-session-two"); });
  const auto a = first.get(), b = second.get();
  CHECK((a.outcome == AppleTicketOutcome::completed && b.outcome == AppleTicketOutcome::identityTaken) ||
        (b.outcome == AppleTicketOutcome::completed && a.outcome == AppleTicketOutcome::identityTaken));
  CHECK_EQ(f.repo.listSessions(f.mine.id).size() + f.repo.listSessions(f.other.id).size(), std::size_t{1});
}

TEST(pg_apple_takeover_deletes_empty_account_and_returns_only_its_revoked_sessions) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  CHECK(f.repo.tryBindIdentity(f.identity, f.other.id));
  f.repo.insertSession("pg-apple-old", f.other.id, sessionExpiry(f.now), "", "", f.now);
  f.repo.insertSession("pg-apple-mine", f.mine.id, sessionExpiry(f.now), "", "", f.now);
  auto changed = f.identity;
  changed.email = Email{"changed@example.com"}; changed.relayEmail = false;
  const auto revoked = f.repo.takeOverIdentity(changed, f.other.id, f.mine.id);
  REQUIRE(revoked);
  CHECK_EQ(*revoked, (std::vector<std::string>{"pg-apple-old"}));
  CHECK(!f.repo.findUserById(f.other.id));
  CHECK(!f.repo.findSession("pg-apple-old"));
  CHECK(f.repo.findSession("pg-apple-mine"));
  CHECK_EQ(f.repo.findIdentity(Provider::apple, f.identity.subject), std::optional<UserId>{f.mine.id});
  const auto methods = f.repo.signInMethods(f.mine.id);
  REQUIRE_EQ(methods.size(), std::size_t{1});
  CHECK_EQ(methods[0].email, f.identity.email.value);
  CHECK(methods[0].relay);
}

TEST(pg_apple_takeover_rechecks_product_and_replica_footprints_and_never_deletes_data) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  for (const int state : {0, 1, 2}) {
    Fixture f;
    CHECK(f.repo.tryBindIdentity(f.identity, f.other.id));
    f.repo.insertSession("pg-apple-old", f.other.id, sessionExpiry(f.now), "", "", f.now);
    {
      PgLease lease{*pgTestPool()}; pqxx::work txn{*lease};
      if (state == 0) txn.exec_params("INSERT INTO trees(id,owner_id) VALUES('pg-apple-tree',$1::uuid)", f.other.id.str());
      if (state == 1) txn.exec_params("INSERT INTO journal_page(user_id,day,body) VALUES($1::uuid,'2026-01-01','page')", f.other.id.str());
      if (state == 2) txn.exec_params("INSERT INTO sync_replicas(replica,account,last_seen) VALUES('pg-apple-replica',$1::uuid,1)", f.other.id.str());
      txn.commit();
    }
    CHECK(!f.repo.takeOverIdentity(f.identity, f.other.id, f.mine.id));
    CHECK(f.repo.findUserById(f.other.id));
    CHECK(f.repo.findSession("pg-apple-old"));
    CHECK_EQ(f.repo.findIdentity(Provider::apple, f.identity.subject), std::optional<UserId>{f.other.id});
  }
}

TEST(pg_apple_unbind_is_scoped_and_preserves_account_sessions_and_other_providers) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  CHECK(f.repo.tryBindIdentity(f.identity, f.mine.id));
  auto other = f.identity; other.subject = "pg-apple-other-subject";
  CHECK(f.repo.tryBindIdentity(other, f.other.id));
  f.repo.bindIdentity(Provider::google, "pg-apple-google", f.mine.id, f.mine.email.value);
  f.repo.insertSession("pg-apple-mine", f.mine.id, sessionExpiry(f.now), "", "", f.now);
  CHECK(f.repo.unbindIdentity(Provider::apple, f.mine.id));
  CHECK(!f.repo.unbindIdentity(Provider::apple, f.mine.id));
  CHECK(!f.repo.findIdentity(Provider::apple, f.identity.subject));
  CHECK(f.repo.findIdentity(Provider::apple, other.subject));
  CHECK(f.repo.findIdentity(Provider::google, "pg-apple-google"));
  CHECK(f.repo.findUserById(f.mine.id));
  CHECK(f.repo.findSession("pg-apple-mine"));
}

TEST(pg_apple_ticket_checked_again_before_code_consumption_when_another_request_spent_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  f.repo.insertLink("pg-apple-code", "code-digest", f.mine.email, f.now, linkExpiry(f.now), "");
  REQUIRE(f.repo.findAppleTicket("pg-apple-ticket", f.now));
  CHECK(f.redeem().outcome == AppleTicketOutcome::completed);
  const auto result = f.repo.redeemAppleTicket("pg-apple-ticket", f.now, f.mine.id, "", "pg-apple-loser-session",
                                             sessionExpiry(f.now), "", "", "pg-apple-code");
  CHECK(result.outcome == AppleTicketOutcome::expired);
  const auto code = f.repo.findLink("pg-apple-code");
  REQUIRE(code);
  CHECK(!code->consumed);
  CHECK(!f.repo.findSession("pg-apple-loser-session"));
}

TEST(pg_apple_code_no_account_spends_only_code_and_a_followup_code_can_attach) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  f.repo.insertLink("pg-apple-code-no-account", "code-digest", Email{"unknown@example.com"}, f.now, linkExpiry(f.now), "");
  auto result = f.repo.redeemAppleTicket("pg-apple-ticket", f.now, std::nullopt, "", "pg-apple-no-account-session",
                                        sessionExpiry(f.now), "", "", "pg-apple-code-no-account");
  CHECK(result.outcome == AppleTicketOutcome::noAccount);
  CHECK(f.repo.findLink("pg-apple-code-no-account")->consumed);
  CHECK(f.repo.findAppleTicket("pg-apple-ticket", f.now));
  CHECK(!f.repo.findUserByEmail(f.identity.email));
  CHECK(!f.repo.findSession("pg-apple-no-account-session"));
  f.repo.insertLink("pg-apple-code-followup", "code-digest", f.mine.email, f.now, linkExpiry(f.now), "");
  f.repo.markUserDeleted(f.mine.id, f.now);
  result = f.repo.redeemAppleTicket("pg-apple-ticket", f.now, f.mine.id, "", "pg-apple-followup-session",
                                   sessionExpiry(f.now), "", "", "pg-apple-code-followup");
  CHECK(result.outcome == AppleTicketOutcome::completed);
  REQUIRE(result.user);
  CHECK_EQ(result.user->id, f.mine.id);
  CHECK(!result.user->deletedAt);
  CHECK(!f.repo.findAppleTicket("pg-apple-ticket", f.now));
}

TEST(pg_apple_binding_session_failure_rolls_back_ticket_code_and_identity_together) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  f.repo.insertLink("pg-apple-code-failure", "code-digest", f.mine.email, f.now, linkExpiry(f.now), "");
  f.repo.insertSession("pg-apple-duplicate-session", f.other.id, sessionExpiry(f.now), "", "", f.now);
  bool failed = false;
  try {
    f.repo.redeemAppleTicket("pg-apple-ticket", f.now, f.mine.id, "", "pg-apple-duplicate-session",
                             sessionExpiry(f.now), "", "", "pg-apple-code-failure");
  } catch (const pqxx::unique_violation&) { failed = true; }
  CHECK(failed);
  CHECK(f.repo.findAppleTicket("pg-apple-ticket", f.now));
  CHECK(!f.repo.findLink("pg-apple-code-failure")->consumed);
  CHECK(!f.repo.findIdentity(Provider::apple, f.identity.subject));
  CHECK(f.repo.findSession("pg-apple-duplicate-session"));
}

TEST(pg_apple_distinct_create_tickets_for_one_subject_have_one_created_success_and_one_expiry) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket("pg-apple-one"); f.ticket("pg-apple-two");
  auto first = std::async(std::launch::async, [&] { return f.redeem("pg-apple-one", std::nullopt, "pg-apple-session-one"); });
  auto second = std::async(std::launch::async, [&] { return f.redeem("pg-apple-two", std::nullopt, "pg-apple-session-two"); });
  const auto a = first.get(), b = second.get();
  CHECK((a.outcome == AppleTicketOutcome::completed && a.created && b.outcome == AppleTicketOutcome::expired) ||
        (b.outcome == AppleTicketOutcome::completed && b.created && a.outcome == AppleTicketOutcome::expired));
  const auto user = f.repo.findUserByEmail(f.identity.email);
  REQUIRE(user);
  CHECK_EQ(f.repo.listSessions(user->id).size(), std::size_t{1});
  CHECK(!f.repo.findAppleTicket("pg-apple-one", f.now));
  CHECK(!f.repo.findAppleTicket("pg-apple-two", f.now));
}

TEST(pg_apple_matched_email_session_failure_rolls_back_binding_and_revival) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.repo.markUserDeleted(f.mine.id, f.now);
  f.repo.insertSession("pg-apple-duplicate-session", f.other.id, sessionExpiry(f.now), "", "", f.now);
  bool failed = false;
  try {
    f.repo.signInApple(f.identity, f.mine.id, "pg-apple-duplicate-session", sessionExpiry(f.now), "", "", f.now);
  } catch (const pqxx::unique_violation&) { failed = true; }
  CHECK(failed);
  CHECK(!f.repo.findIdentity(Provider::apple, f.identity.subject));
  CHECK(f.repo.findUserById(f.mine.id)->deletedAt);
  const auto signedIn = f.repo.signInApple(f.identity, f.mine.id, "pg-apple-matched-session", sessionExpiry(f.now), "", "", f.now);
  REQUIRE(signedIn);
  CHECK(!signedIn->deletedAt);
  CHECK(f.repo.findIdentity(Provider::apple, f.identity.subject));
  CHECK(f.repo.findSession("pg-apple-matched-session"));
}

TEST(pg_apple_create_never_reuses_an_account_that_appeared_at_the_ticket_email) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  f.ticket();
  const auto existing = f.repo.createUser(f.identity.email, "Existing");
  CHECK(f.redeem().outcome == AppleTicketOutcome::expired);
  CHECK_EQ(f.repo.findUserById(existing.id)->name, std::string("Existing"));
  CHECK(!f.repo.findIdentity(Provider::apple, f.identity.subject));
  CHECK(!f.repo.findSession("pg-apple-session"));
}

namespace {
void preservesFootprint(const std::string& table, const std::string& insert, bool textOwner = false) {
  Fixture f;
  auto footprint = std::make_shared<PgAccountFootprint>(pgTestPool(), std::vector<OwnedTable>{{table,"user_id",textOwner}});
  PgAuthRepository repo{pgTestPool(), footprint};
  CHECK(repo.tryBindIdentity(f.identity, f.other.id));
  repo.insertSession("pg-apple-old", f.other.id, sessionExpiry(f.now), "", "", f.now);
  CHECK(!footprint->anyData(f.other.id));
  {
    PgLease lease{*pgTestPool()}; pqxx::work txn{*lease};
    txn.exec_params(insert, f.other.id.str());
    txn.commit();
  }
  CHECK(footprint->anyData(f.other.id));
  CHECK(!repo.takeOverIdentity(f.identity, f.other.id, f.mine.id));
  CHECK(repo.findUserById(f.other.id));
  CHECK(repo.findSession("pg-apple-old"));
  CHECK_EQ(repo.findIdentity(Provider::apple, f.identity.subject), std::optional<UserId>{f.other.id});
  PgLease lease{*pgTestPool()}; pqxx::work txn{*lease};
  CHECK_EQ(txn.exec_params("SELECT count(*) FROM " + table + " WHERE user_id=" + (textOwner ? "$1::text" : "$1::uuid"), f.other.id.str())[0][0].as<int>(), 1);
}
}

TEST(pg_apple_takeover_preserves_node_progress_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("node_progress", R"(INSERT INTO node_progress(tree_id,user_id,node_id,status) VALUES('t_9e407a96b5330ebe',$1,'public-node','complete'))", true);
}

TEST(pg_apple_takeover_preserves_feedback_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("feedback", R"(INSERT INTO feedback(user_id,message) VALUES($1::uuid,'Feedback'))");
}

TEST(pg_apple_takeover_preserves_tend_runs_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("tend_runs", R"(INSERT INTO tend_runs(id,tree_id,user_id,prompt) VALUES('pg-apple-tend','public-tree',$1::uuid,'Prompt'))");
}

TEST(pg_apple_takeover_preserves_org_members_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("org_members", R"(WITH org AS (INSERT INTO orgs(id,name,slug) VALUES('00000000-0000-4000-8000-0000000000a9','Org','pg-apple-org') RETURNING id) INSERT INTO org_members(org_id,user_id,role) SELECT id,$1::uuid,'member' FROM org)");
}

TEST(pg_apple_takeover_preserves_reminder_subscription_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("reminder_subscription", R"(INSERT INTO reminder_subscription(user_id,enabled) VALUES($1::uuid,true))");
}

TEST(pg_apple_takeover_preserves_reminder_week_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("reminder_week", R"(INSERT INTO reminder_week(user_id,slot_date,decision,reason) VALUES($1::uuid,'2026-01-01','sent','ok'))");
}

TEST(pg_apple_takeover_preserves_journal_page_revision_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_page_revision", R"(INSERT INTO journal_page_revision(user_id,day,body) VALUES($1::uuid,'2026-01-01','History'))");
}

TEST(pg_apple_takeover_preserves_journal_nudge_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_nudge", R"(INSERT INTO journal_nudge(user_id,enabled) VALUES($1::uuid,true))");
}

TEST(pg_apple_takeover_preserves_journal_nudge_day_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_nudge_day", R"(INSERT INTO journal_nudge_day(user_id,slot_day,decision,reason) VALUES($1::uuid,'2026-01-01','sent','ok'))");
}

TEST(pg_apple_takeover_preserves_journal_span_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_span", R"(INSERT INTO journal_span(user_id,span_id,day,ord,lo,hi,text,text_sha256,vector,embed_version) VALUES($1::uuid,1,'2026-01-01',0,0,1,'x','\x01','\x01','v1'))");
}

TEST(pg_apple_takeover_preserves_journal_echo_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_echo", R"(INSERT INTO journal_echo(user_id,trigger_day,trigger_span_id,match_day,match_span_id) VALUES($1::uuid,'2026-01-02',1,'2026-01-01',2))");
}

TEST(pg_apple_takeover_preserves_journal_echo_dismissal_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_echo_dismissal", R"(INSERT INTO journal_echo_dismissal(user_id,trigger_hash,match_hash) VALUES($1::uuid,'\x01','\x02'))");
}

TEST(pg_apple_takeover_preserves_journal_echo_signal_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_echo_signal", R"(INSERT INTO journal_echo_signal(user_id,trigger_day,trigger_span_id,match_day,match_span_id,kind) VALUES($1::uuid,'2026-01-02',1,'2026-01-01',2,'useful'))");
}

TEST(pg_apple_takeover_preserves_journal_echo_offer_dismissal_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_echo_offer_dismissal", R"(INSERT INTO journal_echo_offer_dismissal(user_id,day) VALUES($1::uuid,'2026-01-01'))");
}

TEST(pg_apple_takeover_preserves_journal_page_curation_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("journal_page_curation", R"(INSERT INTO journal_page_curation(user_id,day,status) VALUES($1::uuid,'2026-01-01','ok'))");
}

TEST(pg_apple_takeover_preserves_gym_preferences_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("gym_preferences", R"(INSERT INTO gym_preferences(user_id,units) VALUES($1::uuid,'lb'))");
}

TEST(pg_apple_takeover_preserves_oauth_codes_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("oauth_codes", R"(INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,resource,expires_ms) VALUES('pg-apple-code','client',$1::uuid,'https://client.test','challenge','resource',1))");
}

TEST(pg_apple_takeover_preserves_oauth_tokens_alone) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  preservesFootprint("oauth_tokens", R"(INSERT INTO oauth_tokens(token_hash,refresh_hash,client_id,user_id,resource,expires_ms,refresh_expires_ms) VALUES('pg-apple-access','pg-apple-refresh','client',$1::uuid,'resource',1,2))");
}

TEST(pg_apple_takeover_waits_for_a_first_progress_write_then_rechecks_the_committed_footprint) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  CHECK(f.repo.tryBindIdentity(f.identity, f.other.id));
  std::future<std::optional<std::vector<std::string>>> takeover;
  {
    PgLease lease{*pgTestPool()}; pqxx::work txn{*lease};
    txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR KEY SHARE", f.other.id.str());
    txn.exec_params("INSERT INTO node_progress(tree_id,user_id,node_id,status) VALUES('public-tree',$1,'node','complete')", f.other.id.str());
    takeover = std::async(std::launch::async, [&] { return f.repo.takeOverIdentity(f.identity, f.other.id, f.mine.id); });
    CHECK(takeover.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout);
    txn.commit();
  }
  CHECK(!takeover.get());
  CHECK(f.repo.findUserById(f.other.id));
  CHECK_EQ(f.repo.findIdentity(Provider::apple, f.identity.subject), std::optional<UserId>{f.other.id});
}

TEST(pg_apple_takeover_blocks_a_late_progress_write_and_deletion_prevents_an_orphan) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  Fixture f;
  CHECK(f.repo.tryBindIdentity(f.identity, f.other.id));
  std::future<bool> writer;
  {
    PgLease lease{*pgTestPool()}; pqxx::work txn{*lease};
    txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR UPDATE", f.other.id.str());
    writer = std::async(std::launch::async, [&] {
      PgProgressRepository progress{pgTestPool()};
      try {
        progress.setStatus(TreeId{"public-tree"}, f.other.id, NodeId{"node"}, ProgressStatus::complete, false, Hlc{1,0,"actor"}, 1);
        return false;
      } catch (const std::runtime_error&) { return true; }
    });
    CHECK(writer.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout);
    txn.exec_params("UPDATE user_identities SET user_id=$2::uuid WHERE user_id=$1::uuid", f.other.id.str(), f.mine.id.str());
    txn.exec_params("DELETE FROM users WHERE id=$1::uuid", f.other.id.str());
    txn.commit();
  }
  CHECK(writer.get());
  PgProgressRepository progress{pgTestPool()};
  CHECK(progress.load(TreeId{"public-tree"}, f.other.id).marks.empty());
}
