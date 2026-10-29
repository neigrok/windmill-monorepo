#include "platform/adapters/postgres/PgAuthRepository.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"

#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

// Opt-in integration test: needs a live local Postgres with the schema applied and WM_PG_TEST set; otherwise every
// case reports skip. It seeds its own rows: what the bulk revocations and an account's delete answer is every digest
// they dropped, which the live sync sockets those sessions opened are closed by.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kSam = "66666666-6666-4666-8666-666666666666";
const std::string kEve = "77777777-7777-4777-8777-777777777777";
const std::string kFold = "88888888-8888-4888-8888-888888888888";

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("DELETE FROM sessions WHERE token_hash LIKE 'pgtest-%'");
  w.exec("INSERT INTO users (id, email) VALUES ('" + kSam + "', 'sam-pgtest@example.com'), ('" + kEve + "', 'eve-pgtest@example.com'), ('" +
         kFold + "', 'fold-pgtest@example.com') ON CONFLICT (id) DO NOTHING");
  w.commit();
}

std::vector<std::string> sorted(std::vector<std::string> digests) {
  std::sort(digests.begin(), digests.end());
  return digests;
}
}

TEST(pg_auth_bulk_revocations_answer_every_digest_they_dropped_and_only_the_accounts_own) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAuthRepository repo{pgTestPool()};
  for (const std::string digest : {"pgtest-sam-1", "pgtest-sam-2", "pgtest-sam-3"}) repo.insertSession(digest, UserId{kSam}, 9'000'000'000'000, "", "", 1);
  repo.insertSession("pgtest-eve-1", UserId{kEve}, 9'000'000'000'000, "", "", 1);

  CHECK_EQ(sorted(repo.revokeSessionsExcept(UserId{kSam}, "pgtest-sam-2")), (std::vector<std::string>{"pgtest-sam-1", "pgtest-sam-3"}));
  CHECK(repo.findSession("pgtest-sam-2").has_value());
  CHECK_EQ(repo.revokeAllSessions(UserId{kSam}), (std::vector<std::string>{"pgtest-sam-2"}));
  CHECK(repo.revokeAllSessions(UserId{kSam}).empty());
  CHECK(repo.findSession("pgtest-eve-1").has_value());
}

TEST(pg_auth_deleting_an_account_answers_every_session_its_row_took_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAuthRepository repo{pgTestPool()};
  for (const std::string digest : {"pgtest-fold-1", "pgtest-fold-2"}) repo.insertSession(digest, UserId{kFold}, 9'000'000'000'000, "", "", 1);
  repo.insertSession("pgtest-eve-1", UserId{kEve}, 9'000'000'000'000, "", "", 1);

  CHECK_EQ(sorted(repo.deleteUser(UserId{kFold})), (std::vector<std::string>{"pgtest-fold-1", "pgtest-fold-2"}));
  CHECK_FALSE(repo.findUserById(UserId{kFold}).has_value());
  CHECK_FALSE(repo.findSession("pgtest-fold-1").has_value());
  CHECK(repo.findSession("pgtest-eve-1").has_value());
  CHECK(repo.deleteUser(UserId{kFold}).empty());
}

TEST(pg_auth_refresh_answers_whether_the_session_row_was_updated) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAuthRepository repo{pgTestPool()};
  repo.insertSession("pgtest-refresh", UserId{kSam}, 9'000'000'000'000, "", "", 1);
  CHECK(repo.refreshSession("pgtest-refresh", 9'000'000'000'001, 2, "", ""));
  CHECK_FALSE(repo.refreshSession("pgtest-no-session", 9'000'000'000'001, 2, "", ""));
  REQUIRE(repo.findSession("pgtest-refresh").has_value());
  CHECK_EQ(repo.findSession("pgtest-refresh")->expiresAt, 9'000'000'000'001ULL);
}

namespace {
const std::string kErased = "5a5a0000-0000-4000-8000-00000000e7a5";
const std::string kErasedEmail = "erase-sam-pgtest@example.com";
const std::string kKept = "e7e00000-0000-4000-8000-00000000e7a5";
const UnixMs kClosedAt = 1'700'000'000'000;

std::string withAccounts(std::string sql) {
  for (const auto& [name, id] : {std::pair{std::string("SAM"), kErased}, std::pair{std::string("EVE"), kKept}})
    for (std::size_t at = sql.find(name); at != std::string::npos; at = sql.find(name, at)) sql.replace(at, name.size(), id);
  return sql;
}

// What erasure leaves of a closed account until a fresh run plants it again: the accounting rows it keeps on purpose,
// and whatever a failed run stranded under the fixture's tree ids once their trees were gone.
void eraseLeftovers(PgAuthRepository& repo) {
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    for (const char* table : {"tree_nodes", "tree_edges", "tree_kinds", "tree_og_images", "tree_og_videos", "tree_ops",
                              "node_progress", "tend_runs"})
      w.exec(std::string("DELETE FROM ") + table + " WHERE tree_id LIKE 't\\_erase\\_%'");
    w.exec("DELETE FROM ai_usage WHERE operation = 'erase-pgtest'");
    w.exec("DELETE FROM ai_budget_grants WHERE id = 'erase-pgtest-grant'");
    w.exec("DELETE FROM ai_budget_device_accounts WHERE device_id = 'erase-pgtest-device'");
    w.exec(withAccounts("DELETE FROM account_closures WHERE account_id IN ('SAM', 'EVE')"));
    w.exec(withAccounts("UPDATE users SET deleted_at = to_timestamp(0), closes_at = to_timestamp(0) WHERE id IN ('SAM', 'EVE')"));
    w.commit();
  }
  repo.eraseAccount(UserId{kErased}, kClosedAt);
  repo.eraseAccount(UserId{kKept}, kClosedAt);
}

// Every column through which a row can belong to an account: its id under any of the names the schema gives it, any
// column with a foreign key to users, its address, and the trees it owns.
struct AccountColumn {
  std::string table;
  std::string column;
};
std::vector<AccountColumn> accountColumns(pqxx::work& w) {
  const pqxx::result rows = w.exec(
      "SELECT c.table_name, c.column_name FROM information_schema.columns c "
      "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
      "WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND ("
      "  c.column_name IN ('user_id', 'owner_id', 'owner', 'account', 'account_id', 'created_by', 'actor', 'actor_id',"
      "                    'subject_id', 'subject_key', 'email', 'email_at_link', 'tree_id')"
      "  OR (c.table_name, c.column_name) IN ("
      "    SELECT r.relname::text, a.attname::text FROM pg_constraint k "
      "    JOIN pg_class r ON r.oid = k.conrelid "
      "    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey) "
      "    WHERE k.contype = 'f' AND k.confrelid = 'users'::regclass)) "
      "ORDER BY 1, 2");
  std::vector<AccountColumn> columns;
  for (const auto& row : rows) columns.push_back({row[0].template as<std::string>(), row[1].template as<std::string>()});
  return columns;
}

// A row that names the address but belongs to an open account by its user_id is that account's, not the erased one's.
int rowsOfTheErasedAccount(pqxx::work& w, const AccountColumn& at, const std::set<std::string>& ownedByUserId) {
  const std::string rows = "SELECT count(*)::int FROM " + w.quote_name(at.table) + " WHERE ";
  const std::string column = w.quote_name(at.column);
  if (at.column == "tree_id") return w.exec(rows + column + " IN ('t_erase_sam', 't_erase_sam_retired')")[0][0].as<int>();
  if (at.column == "email" || at.column == "email_at_link") {
    const std::string unowned = ownedByUserId.count(at.table) ? " AND user_id IS NULL" : "";
    return w.exec_params(rows + "lower(" + column + "::text) = lower($1)" + unowned, kErasedEmail)[0][0].as<int>();
  }
  return w.exec_params(rows + column + "::text = $1", kErased)[0][0].as<int>();
}

std::set<std::string> tablesOwnedByUserId(const std::vector<AccountColumn>& columns) {
  std::set<std::string> tables;
  for (const AccountColumn& at : columns)
    if (at.column == "user_id") tables.insert(at.table);
  return tables;
}

int count(const std::string& sql) {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  return w.exec("SELECT count(*)::int FROM " + withAccounts(sql))[0][0].as<int>();
}
}

TEST(pg_auth_erasing_a_closed_account_leaves_no_row_any_product_keys_to_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgAuthRepository repo{pgTestPool(), nullptr, {roadmapAccountErasure()}};
  eraseLeftovers(repo);
  // Kept on purpose: the AI accounting relations keep an opaque account id with no address or content
  // (AI_ALLOWANCES.md); sign-in credentials and closure receipts are collected at their own expiry.
  const std::set<std::string> kept = {"ai_usage", "ai_budget_grants", "ai_budget_device_accounts", "ai_budget_balances",
                                      "ai_budget_reservations", "ai_budget_alerts", "magic_links", "apple_tickets", "account_closures"};
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec(withAccounts(R"SQL(
INSERT INTO users (id, email, name) VALUES ('SAM', 'erase-sam-pgtest@example.com', 'Sam'), ('EVE', 'erase-eve-pgtest@example.com', 'Eve');
INSERT INTO orgs (id, name, slug) VALUES ('0a900000-0000-4000-8000-00000000e7a5', 'Erase', 'erase-pgtest') ON CONFLICT DO NOTHING;
INSERT INTO org_members (org_id, user_id, role) VALUES ('0a900000-0000-4000-8000-00000000e7a5', 'SAM', 'member');
INSERT INTO trees (id, owner_id, title) VALUES ('t_erase_sam', 'SAM', 'Sam'), ('t_erase_eve', 'EVE', 'Eve');
INSERT INTO trees (id, owner_id, title, deleted_at) VALUES ('t_erase_sam_retired', 'SAM', 'Retired', now());
INSERT INTO tree_nodes (tree_id, node_id) VALUES ('t_erase_sam', 'n1'), ('t_erase_sam_retired', 'n1'), ('t_erase_eve', 'n1');
INSERT INTO tree_edges (tree_id, from_id, to_id) VALUES ('t_erase_sam', 'n1', 'n2');
INSERT INTO tree_kinds (tree_id, kind_id) VALUES ('t_erase_sam', 'k1');
INSERT INTO tree_og_images (tree_id, png) VALUES ('t_erase_sam', '\x00'::bytea);
INSERT INTO tree_og_videos (tree_id, video) VALUES ('t_erase_sam', '\x00'::bytea);
INSERT INTO tree_ops (tree_id, seq, actor_id, op_id, kind, payload, hlc) VALUES ('t_erase_sam', 1, 'SAM', 'op1', 'node.create', '{}', '1:0:a');
INSERT INTO node_progress (tree_id, user_id, node_id, status) VALUES ('t_erase_sam', 'EVE', 'n1', 'done'), ('t_erase_eve', 'SAM', 'n1', 'done'), ('t_erase_eve', 'EVE', 'n1', 'done');
INSERT INTO tend_runs (id, tree_id, user_id, prompt) VALUES ('erase-tend', 't_erase_sam', 'SAM', '');
INSERT INTO reminder_subscription (user_id) VALUES ('SAM');
INSERT INTO reminder_week (user_id, slot_date, decision, reason, tree_id) VALUES ('SAM', '2026-01-05', 'sent', 'ok', 't_erase_sam');
INSERT INTO sessions (token_hash, user_id, expires_ms) VALUES ('erase-session', 'SAM', 9000000000000);
INSERT INTO account_closures (operation_id, account_id, proof_hash, requested_ms, closes_ms, expires_ms) VALUES ('e7a50000-0000-4000-8000-000000000001', 'SAM', repeat('a',64), 1, 2, 3);
INSERT INTO user_identities (provider, subject, user_id) VALUES ('google', 'erase-subject', 'SAM');
INSERT INTO mcp_keys (token_hash, user_id, created_ms) VALUES ('erase-key', 'SAM', 1);
INSERT INTO oauth_grants (user_id, client_id, granted_ms) VALUES ('SAM', 'erase-client', 1);
INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_ms) VALUES ('erase-code', 'erase-client', 'SAM', 'https://a/cb', 'c', 'r', 1);
INSERT INTO oauth_tokens (token_hash, client_id, user_id, resource, expires_ms) VALUES ('erase-token', 'erase-client', 'SAM', 'r', 1);
INSERT INTO events (user_id, name) VALUES ('SAM', 'erase_event');
INSERT INTO feedback (user_id, message) VALUES ('SAM', 'erase note');
INSERT INTO feedback (message, email) VALUES ('erase ghost note', 'Erase-Sam-PGTest@example.com');
INSERT INTO server_errors (actor, path) VALUES ('SAM', '/erase');
INSERT INTO sync_scopes (key, kind, owner) VALUES ('acct:SAM/gym', 'product', 'SAM');
INSERT INTO sync_spent (scope_key, type, id, life_stamp, seq) VALUES ('acct:SAM/gym', 'set', 'erase-spent', 's', 1);
INSERT INTO sync_replicas (replica, account, last_seen) VALUES ('erase-replica', 'SAM', 1);
INSERT INTO sync_results (replica, n, digest) VALUES ('erase-replica', 1, decode(repeat('00', 32), 'hex'));
INSERT INTO sync_requests (account, request_id, digest, state, started_at) VALUES ('SAM', 'erase-request', decode(repeat('00', 32), 'hex'), 'done', 1);
INSERT INTO paddle_customers (customer_id, email) VALUES ('ctm_erase', 'erase-sam-pgtest@example.com');
INSERT INTO paddle_subscriptions (subscription_id, customer_id, user_id, status) VALUES ('sub_erase', 'ctm_erase', 'SAM', 'active');
INSERT INTO journal_page (user_id, day, body) VALUES ('SAM', '2026-01-01', 'Sam'), ('EVE', '2026-01-01', 'Eve');
INSERT INTO journal_page_revision (user_id, day, body) VALUES ('SAM', '2026-01-01', 'old');
INSERT INTO journal_sync_state (user_id) VALUES ('SAM');
INSERT INTO journal_claim_receipts (user_id, claim_id, arguments_digest, day, document_stamp) VALUES ('SAM', 'erase-claim', 'd', '2026-01-01', '{}');
INSERT INTO journal_content_clock (user_id, ms, counter) VALUES ('SAM', 1, 0);
INSERT INTO journal_nudge (user_id) VALUES ('SAM');
INSERT INTO journal_nudge_day (user_id, slot_day, decision, reason) VALUES ('SAM', '2026-01-01', 'sent', 'ok');
INSERT INTO journal_span (user_id, span_id, day, ord, lo, hi, text, text_sha256, vector, embed_version) VALUES ('SAM', 1, '2026-01-01', 0, 0, 1, 't', '\x00', '\x00', 'v');
INSERT INTO journal_echo (user_id, trigger_day, trigger_span_id, match_day, match_span_id) VALUES ('SAM', '2026-01-02', 2, '2026-01-01', 1);
INSERT INTO journal_echo_dismissal (user_id, trigger_hash, match_hash) VALUES ('SAM', '\x01', '\x02');
INSERT INTO journal_echo_signal (user_id, trigger_day, trigger_span_id, match_day, match_span_id, kind) VALUES ('SAM', '2026-01-02', 2, '2026-01-01', 1, 'opened');
INSERT INTO journal_echo_offer_dismissal (user_id, day) VALUES ('SAM', '2026-01-01');
INSERT INTO journal_page_curation (user_id, day) VALUES ('SAM', '2026-01-01');
INSERT INTO gym_exercises (id, name, pattern, equipment, created_by) VALUES ('erase-lift', 'Erase Lift', 'squat', 'barbell', 'SAM');
INSERT INTO gym_exercise_names (user_id, exercise_id, name) VALUES ('SAM', 'back-squat', 'My Squat');
INSERT INTO gym_exercise_aliases (user_id, exercise_id, name) VALUES ('SAM', 'erase-lift', 'Old Lift');
INSERT INTO gym_routines (id, user_id, name) VALUES ('erase-routine', 'SAM', 'Day A');
INSERT INTO gym_routine_creations (routine_id, user_id, routine) VALUES ('erase-routine', 'SAM', '{}');
INSERT INTO gym_routine_entries (routine_id, position, exercise_id) VALUES ('erase-routine', 1, 'erase-lift');
INSERT INTO gym_routine_entry_sets (routine_id, position, set_index) VALUES ('erase-routine', 1, 1);
INSERT INTO gym_ask_threads (id, user_id, title, created_at, asked_at) VALUES ('erase-thread', 'SAM', 'T', now(), now());
INSERT INTO gym_ask_turns (thread_id, position, user_id, from_lifter, text, said_at) VALUES ('erase-thread', 1, 'SAM', true, 'q', now());
INSERT INTO gym_ask_generations (id, thread_id, user_id, request_id, payload) VALUES ('erase-generation', 'erase-thread', 'SAM', 'r', '{}');
INSERT INTO gym_ask_attachments (id, user_id, thread_id, linked_thread_id, media_type, width, height, data) VALUES ('erase-attachment', 'SAM', 'erase-thread', 'erase-thread', 'image/png', 1, 1, '\x00');
INSERT INTO gym_ask_deleted_threads (id, user_id) VALUES ('erase-deleted-thread', 'SAM');
INSERT INTO gym_threads (id, user_id, title) VALUES ('erase-conversation', 'SAM', 'T');
INSERT INTO gym_messages (id, user_id, thread_id, role, body, at) VALUES ('erase-message', 'SAM', 'erase-conversation', 'lifter', 'q', 1);
INSERT INTO gym_proposals (id, routine_id, user_id, intent, base_revision, base_name, proposed_name, state, door, created_at, thread_id) VALUES ('erase-proposal', 'erase-routine', 'SAM', 'revise', 1, 'Day A', 'Day A', 'pending', 'ask', now(), 'erase-thread');
INSERT INTO gym_proposal_applies (id, user_id) VALUES ('erase-apply', 'SAM');
INSERT INTO gym_proposal_changes (proposal_id, position, user_id, kind, exercise_id) VALUES ('erase-proposal', 1, 'SAM', 'kept', 'erase-lift');
INSERT INTO gym_sessions (id, user_id, routine_id, started_at, finished_at) VALUES ('erase-session', 'SAM', 'erase-routine', now(), now()), ('erase-eve-session', 'EVE', NULL, now(), now());
INSERT INTO gym_write_receipts (kind, id, user_id, session_id, request_hash) VALUES ('set', 'erase-set', 'SAM', 'erase-session', 'h');
INSERT INTO gym_sets (id, session_id, user_id, exercise_id, set_number, weight_kg, reps, completed_at) VALUES ('erase-set', 'erase-session', 'SAM', 'erase-lift', 1, 100, 5, now());
INSERT INTO gym_set_revisions (set_id, session_id, user_id, exercise_id, set_number, weight_kg, reps, completed_at) VALUES ('erase-set-gone', 'erase-session', 'SAM', 'erase-lift', 2, 100, 5, now());
INSERT INTO gym_session_shares (session_id, user_id, token, expires_at) VALUES ('erase-session', 'SAM', 'erase-share-token', now() + interval '1 day');
INSERT INTO gym_correction_receipts (id, user_id, session_id, request_hash) VALUES ('erase-correction', 'SAM', 'erase-session', 'h');
INSERT INTO gym_log_shares (id, user_id, token, mode, scope, from_ms, until_ms, created_ms, expires_ms) VALUES ('erase-log-share', 'SAM', 'erase-log-token', 'snapshot', 'all', 0, 1, 1, 1);
INSERT INTO gym_log_share_sessions (share_id, id, started_ms, workout) VALUES ('erase-log-share', 'erase-session', 0, '{}');
INSERT INTO gym_preferences (user_id) VALUES ('SAM');
INSERT INTO gym_notes (id, user_id, position, title, body) VALUES ('erase-note', 'SAM', 0, 'T', 'B');
INSERT INTO gym_note_saves (id, user_id, note) VALUES ('erase-note-save', 'SAM', '{}');
INSERT INTO gym_exercise_updates (user_id, request_id, arguments, exercise) VALUES ('SAM', 'erase-update', '{}', '{}');
INSERT INTO gym_bodyweight (user_id, date_local, weight_kg, recorded_at) VALUES ('SAM', '2026-01-01', 80, 1);
INSERT INTO feedback (user_id, message, email) VALUES ('EVE', 'erase eve typed sam', 'erase-sam-pgtest@example.com');
INSERT INTO ai_usage (user_id, product, operation, model) VALUES ('SAM', 'gym', 'erase-pgtest', 'm');
INSERT INTO ai_budget_grants (id, account_id, source, funding_reference, period_start_ms, period_end_ms, amount_nanos) VALUES ('erase-pgtest-grant', 'SAM', 'owner', 'erase-pgtest-reference', 0, 1, 1);
INSERT INTO ai_budget_device_accounts (device_id, account_id, bound_at_ms) VALUES ('erase-pgtest-device', 'SAM', 1);
)SQL"));
    w.commit();
  }
  repo.markUserDeleted(UserId{kErased}, kClosedAt - AuthPolicy::closeGraceMs, kClosedAt);

  // A row in every table that can hold one, so a table the erasure misses is a table this test sees survive.
  std::map<std::string, int> seeded;
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    const std::vector<AccountColumn> columns = accountColumns(w);
    for (const AccountColumn& at : columns) seeded[at.table] += rowsOfTheErasedAccount(w, at, tablesOwnedByUserId(columns));
  }
  std::vector<std::string> unseeded;
  for (const auto& [table, rows] : seeded)
    if (rows == 0 && !kept.count(table)) unseeded.push_back(table);
  for (const std::string& table : unseeded) std::cerr << "  account-keyed table this test plants no row in: " << table << "\n";
  CHECK(unseeded.empty());

  CHECK_FALSE(repo.eraseAccount(UserId{kErased}, kClosedAt - 1));   // its grace still runs
  CHECK(repo.eraseAccount(UserId{kErased}, kClosedAt));
  CHECK_FALSE(repo.eraseAccount(UserId{kErased}, kClosedAt));       // nothing left to erase

  std::vector<std::string> survivors;
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    const std::vector<AccountColumn> columns = accountColumns(w);
    for (const AccountColumn& at : columns)
      if (!kept.count(at.table) && rowsOfTheErasedAccount(w, at, tablesOwnedByUserId(columns)) > 0)
        survivors.push_back(at.table + "." + at.column);
  }
  for (const std::string& survivor : survivors) std::cerr << "  survived the erasure: " << survivor << "\n";
  CHECK(survivors.empty());
  // The rows that hang only off another of the account's rows.
  CHECK_EQ(count("gym_routine_entries WHERE routine_id = 'erase-routine'"), 0);
  CHECK_EQ(count("gym_routine_entry_sets WHERE routine_id = 'erase-routine'"), 0);
  CHECK_EQ(count("gym_log_share_sessions WHERE share_id = 'erase-log-share'"), 0);
  CHECK_EQ(count("sync_spent WHERE scope_key = 'acct:SAM/gym'"), 0);
  CHECK_EQ(count("sync_results WHERE replica = 'erase-replica'"), 0);
  // What the accounting keeps, and everything of another account's.
  CHECK_EQ(count("ai_usage WHERE user_id = 'SAM' AND operation = 'erase-pgtest'"), 1);
  CHECK_EQ(count("ai_budget_grants WHERE account_id = 'SAM' AND id = 'erase-pgtest-grant'"), 1);
  CHECK_EQ(count("ai_budget_device_accounts WHERE account_id = 'SAM' AND device_id = 'erase-pgtest-device'"), 1);
  CHECK_EQ(count("account_closures WHERE account_id = 'SAM'"), 1);
  CHECK_EQ(count("users WHERE id = 'EVE'"), 1);
  CHECK_EQ(count("trees WHERE id = 't_erase_eve'"), 1);
  CHECK_EQ(count("tree_nodes WHERE tree_id = 't_erase_eve'"), 1);
  CHECK_EQ(count("node_progress WHERE tree_id = 't_erase_eve'"), 1);
  CHECK_EQ(count("journal_page WHERE user_id = 'EVE'"), 1);
  CHECK_EQ(count("feedback WHERE user_id = 'EVE' AND message = 'erase eve typed sam'"), 1);
  CHECK_EQ(count("gym_sessions WHERE user_id = 'EVE'"), 1);
  CHECK_EQ(count("gym_exercises WHERE id = 'back-squat'"), 1);

  eraseLeftovers(repo);
}

TEST(pg_auth_a_revive_that_commits_first_keeps_the_account_from_erasure) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgAuthRepository repo{pgTestPool(), nullptr, {roadmapAccountErasure()}};
  eraseLeftovers(repo);
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec(withAccounts("INSERT INTO users (id, email) VALUES ('SAM', 'erase-sam-pgtest@example.com')"));
    w.commit();
  }
  repo.markUserDeleted(UserId{kErased}, kClosedAt - AuthPolicy::closeGraceMs, kClosedAt);

  CHECK_FALSE(repo.reviveUser(UserId{kErased}, kClosedAt));          // final from closes_at on
  bool listed = false;
  for (const UserId& closed : repo.finalClosedAccounts(kClosedAt, 100000)) listed = listed || closed.str() == kErased;
  CHECK(listed);
  CHECK(repo.reviveUser(UserId{kErased}, kClosedAt - 1));
  REQUIRE(repo.findUserById(UserId{kErased}).has_value());
  CHECK_FALSE(repo.findUserById(UserId{kErased})->closesAt.has_value());
  CHECK_FALSE(repo.eraseAccount(UserId{kErased}, kClosedAt));
  for (const UserId& closed : repo.finalClosedAccounts(kClosedAt, 100000)) CHECK(closed.str() != kErased);

  eraseLeftovers(repo);
}

TEST(pg_auth_a_close_from_before_closes_at_existed_is_never_final_until_a_deploy_dates_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgAuthRepository repo{pgTestPool(), nullptr, {roadmapAccountErasure()}};
  eraseLeftovers(repo);
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec(withAccounts("INSERT INTO users (id, email, deleted_at) VALUES ('SAM', 'erase-sam-pgtest@example.com', to_timestamp(1))"));
    w.commit();
  }
  CHECK_FALSE(repo.eraseAccount(UserId{kErased}, kClosedAt));
  for (const UserId& closed : repo.finalClosedAccounts(kClosedAt, 100000)) CHECK(closed.str() != kErased);
  CHECK(repo.reviveUser(UserId{kErased}, kClosedAt));
  eraseLeftovers(repo);
}

TEST(pg_auth_two_first_sign_ins_at_one_address_both_land_on_the_one_account) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgAuthRepository repo{pgTestPool(), nullptr, {roadmapAccountErasure()}};
  eraseLeftovers(repo);
  const User first = repo.createUser(Email{kErasedEmail}, "first");
  const User second = repo.createUser(Email{kErasedEmail}, "second");
  CHECK_EQ(second.id, first.id);
  CHECK_EQ(second.name, std::string("first"));
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec_params("DELETE FROM users WHERE id = $1::uuid", first.id.str());
    w.commit();
  }
}
