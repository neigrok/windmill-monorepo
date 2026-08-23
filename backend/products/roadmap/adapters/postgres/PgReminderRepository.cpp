#include "products/roadmap/adapters/postgres/PgReminderRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/domain/GraphState.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "products/roadmap/domain/SkillTree.h"
#include "products/roadmap/domain/TreeSummary.h"
#include "products/roadmap/domain/UnlockRules.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <map>
#include <string_view>
#include <utility>

namespace wm {

namespace {

// One fleet-wide lock for the sweep's work; the claimed week row is what makes it correct.
constexpr std::string_view kSweepLock = "hashtext('reminder_sweep')::bigint";

// Step whole LOCAL days, never 168 hours, or a 09:00 slot drifts an hour across a DST boundary.
// greatest() keeps a recomputed pointer from landing earlier than the one there, and ignores NULL.
constexpr std::string_view kMaterializeNextSlot =
    "WITH slot AS ("
    "  SELECT user_id, iana_tz, (now() AT TIME ZONE iana_tz) AS local_now,"
    "         (((now() AT TIME ZONE iana_tz)::date"
    "           + ((slot_dow - extract(isodow from (now() AT TIME ZONE iana_tz)::date)::int + 7) % 7)"
    "          )::timestamp + make_interval(mins => slot_minute)) AS local_slot"
    "  FROM reminder_subscription"
    "  WHERE user_id = $1::uuid AND enabled AND iana_tz <> ''"
    ") "
    "UPDATE reminder_subscription r "
    "SET next_due_at = greatest("
    "      CASE WHEN s.local_slot > s.local_now THEN (s.local_slot AT TIME ZONE s.iana_tz) "
    "           ELSE ((s.local_slot + interval '7 days') AT TIME ZONE s.iana_tz) END, "
    "      r.next_due_at) "
    "FROM slot s WHERE r.user_id = s.user_id";

// Whole LOCAL weeks from the slot just served, as many as it takes to land strictly in the future.
// Scoped to the slot served ($2): a sweep that lost the insert race matches nothing and moves nothing.
constexpr std::string_view kAdvanceNextSlot =
    "WITH served AS ("
    "  SELECT user_id, (next_due_at AT TIME ZONE iana_tz)::date AS slot_date,"
    "         (now() AT TIME ZONE iana_tz)::date AS today"
    "  FROM reminder_subscription"
    "  WHERE user_id = $1::uuid AND iana_tz <> '' AND next_due_at IS NOT NULL"
    "    AND (next_due_at AT TIME ZONE iana_tz)::date = $2::date"
    ") "
    "UPDATE reminder_subscription r "
    "SET next_due_at = ((s.slot_date + 7 * greatest(1, ceil(((s.today - s.slot_date) + 1) / 7.0)::int)"
    "                   )::timestamp + make_interval(mins => r.slot_minute)) AT TIME ZONE r.iana_tz "
    "FROM served s WHERE r.user_id = s.user_id";

constexpr std::string_view kReadinessNodeColumns =
    "node_id, label, label_hlc, color, color_hlc, created_hlc, deleted_hlc";

template <typename Row>
NodeStateEntry nodeFromRow(const Row& row) {
  NodeStateEntry node;
  node.id = NodeId{row["node_id"].template as<std::string>()};
  node.createdAt = parseHlc(row["created_hlc"].template as<std::string>());
  node.deletedAt = parseHlc(row["deleted_hlc"].template as<std::string>());
  node.label = row["label"].template as<std::string>();
  node.labelAt = parseHlc(row["label_hlc"].template as<std::string>());
  node.color = parseColor(row["color"].template as<std::string>()).value_or(NodeColor::terracotta);
  node.colorAt = parseHlc(row["color_hlc"].template as<std::string>());
  return node;
}

}

PgReminderRepository::PgReminderRepository(std::shared_ptr<PgPool> pool)
    : pool_(pool), sweepLock_(pool, std::string(kSweepLock), "reminders") {}

bool PgReminderRepository::underSweepLock(const std::function<void()>& pass) {
  return sweepLock_.underSweepLock(pass);
}

std::vector<DueUser> PgReminderRepository::dueNow(std::uint64_t nowMs, int limit) {
  // The slot comes back twice: the LOCAL date, which is the ledger's week key, and the UTC instant.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT s.user_id::text AS user_id, u.email::text AS email, "
      "to_char((s.next_due_at AT TIME ZONE s.iana_tz)::date, 'YYYY-MM-DD') AS slot_date, "
      "(extract(epoch from s.next_due_at) * 1000)::bigint AS slot_ms "
      "FROM reminder_subscription s JOIN users u ON u.id = s.user_id "
      "WHERE s.enabled AND NOT s.suppressed AND s.iana_tz <> '' AND s.next_due_at IS NOT NULL "
      // A row in `users` is itself the proven-address signal; the soft-close stamp is the only extra gate.
      "AND u.deleted_at IS NULL AND s.next_due_at <= to_timestamp($1::bigint / 1000.0) "
      "ORDER BY s.next_due_at LIMIT $2",
      static_cast<long long>(nowMs), limit);

  std::vector<DueUser> due;
  due.reserve(rows.size());
  for (const auto& row : rows) {
    DueUser user;
    user.user = UserId{row["user_id"].as<std::string>()};
    user.email = Email{row["email"].as<std::string>()};
    user.slotDate = row["slot_date"].as<std::string>();
    user.slotInstantMs = static_cast<std::uint64_t>(row["slot_ms"].as<long long>());
    due.push_back(std::move(user));
  }
  return due;
}

std::vector<TreeReadiness> PgReminderRepository::readinessFor(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result trees = txn.exec_params(
      "SELECT id, title, (extract(epoch from updated_at) * 1000)::bigint AS updated_ms "
      "FROM trees WHERE owner_id = $1::uuid AND deleted_at IS NULL ORDER BY id",
      user.str());

  // Joined through their own trees so it rides the node_progress primary key rather than scanning by user.
  std::map<TreeId, Progress> overlays;
  std::map<TreeId, std::uint64_t> markedAt;
  pqxx::result marks = txn.exec_params(
      "SELECT p.tree_id, p.node_id, p.status, "
      "(extract(epoch from p.updated_at) * 1000)::bigint AS marked_ms "
      "FROM node_progress p JOIN trees t ON t.id = p.tree_id "
      // node_progress.user_id is text while trees.owner_id is uuid, so each side is cast.
      "WHERE t.owner_id = $1::uuid AND t.deleted_at IS NULL AND p.user_id = $1::text",
      user.str());
  for (const auto& row : marks) {
    const TreeId tree{row["tree_id"].as<std::string>()};
    const NodeId node{row["node_id"].as<std::string>()};
    const std::string status = row["status"].as<std::string>();
    if (status == "complete") overlays[tree].completed.insert(node);
    else if (status == "active") overlays[tree].inProgress.insert(node);
    const auto marked = static_cast<std::uint64_t>(row["marked_ms"].as<long long>());
    markedAt[tree] = std::max(markedAt[tree], marked);
  }

  std::vector<TreeReadiness> readiness;
  readiness.reserve(trees.size());
  for (const auto& row : trees) {
    const TreeId id{row["id"].as<std::string>()};

    GraphState state;
    pqxx::result nodes = txn.exec_params(
        "SELECT " + std::string(kReadinessNodeColumns) +
            " FROM tree_nodes WHERE tree_id = $1 AND present ORDER BY node_id",
        id.str());
    for (const auto& node : nodes) state.nodes.push_back(nodeFromRow(node));
    pqxx::result edges = txn.exec_params(
        "SELECT from_id, to_id, added_hlc, removed_hlc FROM tree_edges WHERE tree_id = $1", id.str());
    for (const auto& edge : edges) {
      state.edges.push_back(EdgeStateEntry{
          Edge{NodeId{edge["from_id"].as<std::string>()}, NodeId{edge["to_id"].as<std::string>()}},
          parseHlc(edge["added_hlc"].as<std::string>()),
          parseHlc(edge["removed_hlc"].as<std::string>())});
    }

    const TreeData data = LooseGraph(state).toTreeData(id, row["title"].as<std::string>());
    const Progress& progress = overlays[id];
    const TreeStats stats = treeStats(data, progress);

    TreeReadiness tree;
    tree.id = id;
    tree.title = data.title;
    tree.lastActivityAtMs =
        std::max(static_cast<std::uint64_t>(row["updated_ms"].as<long long>()), markedAt[id]);
    tree.total = stats.total;
    tree.done = stats.done;
    try {
      // A tree that cannot be validated has nothing ready: one malformed tree must never abort a sweep.
      const SkillTree skillTree(data);
      for (const auto& [node, unlocked] : UnlockRules::derive(skillTree, progress)) {
        if (unlocked != NodeState::available) continue;
        const NodeSpec& spec = skillTree.nodeById(node);
        tree.ready.push_back(ReadyStep{node, spec.label, spec.color});
      }
    } catch (const InvalidTree&) {
      tree.ready.clear();
    }
    readiness.push_back(std::move(tree));
  }
  return readiness;
}

std::uint64_t PgReminderRepository::lastActiveAtMs(const UserId& user) {
  // Their freshest session use, or their freshest tree edit.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT greatest("
      "  coalesce((SELECT max(last_seen_ms) FROM sessions WHERE user_id = $1::uuid), 0), "
      "  coalesce((SELECT (extract(epoch from max(updated_at)) * 1000)::bigint FROM trees "
      "            WHERE owner_id = $1::uuid AND deleted_at IS NULL), 0)) AS active_ms",
      user.str());
  return static_cast<std::uint64_t>(rows[0]["active_ms"].as<long long>());
}

std::uint64_t PgReminderRepository::accountCreatedAtMs(const UserId& user) {
  // The new-account grace measures the account's age, never the age of its oldest tree.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT coalesce((extract(epoch from created_at) * 1000)::bigint, 0) AS born_ms "
      "FROM users WHERE id = $1::uuid",
      user.str());
  if (rows.empty()) return 0;
  return static_cast<std::uint64_t>(rows[0]["born_ms"].as<long long>());
}

bool PgReminderRepository::claimWeek(const UserId& user, const std::string& slotDate,
                                     const ReminderDecision& decision) {
  // The (user_id, slot_date) primary key is the mutex: whoever inserts owns the week, everyone else
  // falls silent. Both halves name the slot being served, so neither moves a pointer already moved on.
  // The EXISTS re-asks inside the transaction what dueNow asked minutes ago.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  std::optional<std::string> treeId;
  if (decision.outcome == ReminderOutcome::send) treeId = decision.content.treeId.str();
  pqxx::result claimed = txn.exec_params(
      "INSERT INTO reminder_week (user_id, slot_date, decision, reason, tree_id, ready_count) "
      "SELECT $1::uuid, $2::date, $3::text, $4::text, $5::text, $6::int "
      "WHERE EXISTS (SELECT 1 FROM reminder_subscription s JOIN users u ON u.id = s.user_id "
      "              WHERE s.user_id = $1::uuid AND s.enabled AND NOT s.suppressed "
      "                AND u.deleted_at IS NULL) "
      "ON CONFLICT (user_id, slot_date) DO NOTHING RETURNING user_id",
      user.str(), slotDate,
      decision.outcome == ReminderOutcome::send ? "sent" : "skipped",
      skipReasonName(decision.reason), treeId, decision.content.readyCount);
  txn.exec_params(std::string(kAdvanceNextSlot), user.str(), slotDate);
  txn.commit();
  return !claimed.empty();
}

void PgReminderRepository::closeWeek(const UserId& user, const std::string& slotDate,
                                     WeekOutcome outcome) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (outcome == WeekOutcome::delivered) {
    // The one stamp meaning a person received something; its absence is ambiguous, so a claimed row is never retried.
    txn.exec_params(
        "UPDATE reminder_week SET sent_at = now() WHERE user_id = $1::uuid AND slot_date = $2::date",
        user.str(), slotDate);
    txn.commit();
    return;
  }
  // The week stays claimed either way: re-sending would eventually double-mail somebody.
  txn.exec_params(
      "UPDATE reminder_week SET decision = 'skipped', reason = $3::text "
      "WHERE user_id = $1::uuid AND slot_date = $2::date",
      user.str(), slotDate, outcome == WeekOutcome::held ? "held" : "send-failed");
  txn.commit();
}

std::optional<ReminderSettings> PgReminderRepository::settingsFor(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT enabled, iana_tz, slot_dow, slot_minute, suppressed "
      "FROM reminder_subscription WHERE user_id = $1::uuid",
      user.str());
  if (rows.empty()) return std::nullopt;

  const auto& row = rows[0];
  ReminderSettings settings;
  settings.enabled = row["enabled"].as<bool>();
  settings.timezone = row["iana_tz"].as<std::string>();
  settings.slotDow = row["slot_dow"].as<int>();
  settings.slotMinute = row["slot_minute"].as<int>();
  settings.suppressed = row["suppressed"].as<bool>();
  return settings;
}

bool PgReminderRepository::upsertSettings(const UserId& user, bool enabled,
                                          const std::string& ianaTz) {
  // Validate the zone name first: a rejected name inside the write below would poison the transaction.
  if (!ianaTz.empty()) {
    try {
      PgLease probeConn{*pool_};
      pqxx::work probe{*probeConn};
      probe.exec_params("SELECT now() AT TIME ZONE $1", ianaTz);
      probe.commit();
    } catch (const pqxx::sql_error&) {
      return false;
    }
  }

  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO reminder_subscription (user_id, enabled, iana_tz) VALUES ($1::uuid, $2, $3) "
      "ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, iana_tz = EXCLUDED.iana_tz",
      user.str(), enabled, ianaTz);
  // Off, or nowhere in particular: no slot can be known, so the row simply never comes up due.
  txn.exec_params(
      "UPDATE reminder_subscription SET next_due_at = NULL "
      "WHERE user_id = $1::uuid AND (NOT enabled OR iana_tz = '')",
      user.str());
  txn.exec_params(std::string(kMaterializeNextSlot), user.str());
  txn.commit();
  return true;
}

bool PgReminderRepository::stopMailing(const Email& address) {
  // Idempotent: it writes a constant, so a redelivered webhook performs the identical write.
  // Inserts when there is no row, and leaves `enabled` as its owner set it. users.email is citext.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result changed = txn.exec_params(
      "INSERT INTO reminder_subscription (user_id, suppressed) "
      "SELECT id, true FROM users WHERE email = $1::citext AND deleted_at IS NULL "
      "ON CONFLICT (user_id) DO UPDATE SET suppressed = true RETURNING user_id",
      address.value);
  txn.commit();
  return !changed.empty();
}

void PgReminderRepository::liftSuppression(const UserId& user) {
  // `enabled` is untouched here; a row that never existed has nothing to lift, so an UPDATE is exact.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE reminder_subscription SET suppressed = false WHERE user_id = $1::uuid",
                  user.str());
  txn.commit();
}

void PgReminderRepository::setPauseDigest(const UserId& user, const std::string& digest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE reminder_subscription SET pause_digest = $2 WHERE user_id = $1::uuid",
                  user.str(), digest);
  txn.commit();
}

std::optional<UserId> PgReminderRepository::userByPauseDigest(const std::string& digest) {
  if (digest.empty()) return std::nullopt;  // the never-set sentinel must never resolve to anyone
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT user_id::text AS user_id FROM reminder_subscription WHERE pause_digest = $1", digest);
  if (rows.empty()) return std::nullopt;
  return UserId{rows[0]["user_id"].as<std::string>()};
}

void PgReminderRepository::pause(const UserId& user) {
  // Clear the digest too: a pause link is a bearer credential with no expiry of its own.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "UPDATE reminder_subscription SET enabled = false, next_due_at = NULL, pause_digest = '' "
      "WHERE user_id = $1::uuid",
      user.str());
  txn.commit();
}

}
