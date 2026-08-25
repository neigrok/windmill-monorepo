#include "products/gym/adapters/postgres/PgNotesRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <cstddef>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
constexpr std::string_view kNoteColumns =
    "id, user_id, title, body, position, "
    "(extract(epoch from updated_at) * 1000)::bigint AS updated_ms";

// The column checks carry the entity's three bounds, so a stored row rebuilds without a refusal.
template <typename Row>
Note noteFrom(const Row& row) {
  return Note{NoteId{row["id"].template as<std::string>()},
              UserId{row["user_id"].template as<std::string>()},
              row["title"].template as<std::string>(),
              row["body"].template as<std::string>(),
              row["position"].template as<int>(),
              instantFrom(row["updated_ms"])};
}

// Position ascending, under the caller's own transaction.
std::vector<Note> notesOf(pqxx::work& txn, const UserId& user) {
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kNoteColumns) + " FROM gym_notes WHERE user_id = $1::uuid ORDER BY position",
      user.str());
  std::vector<Note> notes;
  for (const auto& row : rows) notes.push_back(noteFrom(row));
  return notes;
}

// The first statement of every write: the account's writes queue behind one transaction-scoped
// advisory lock, released with the commit. Row locks cannot do this — under READ COMMITTED a
// waiter's snapshot never shows the row the writer ahead of it inserted, so two appends count the
// same n and two flights of one new id both insert. Behind the lock, every later statement takes a
// fresh snapshot that holds the committed row. The key is namespaced to this table.
void lockAccount(pqxx::work& txn, const UserId& user) {
  txn.exec_params("SELECT pg_advisory_xact_lock(hashtext('gym_notes'), hashtext($1))", user.str());
}
}

PgNotesRepository::PgNotesRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::vector<Note> PgNotesRepository::notes(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return notesOf(txn, user);
}

NoteWriteOutcome PgNotesRepository::saveNote(const Note& incoming, std::uint64_t nowMs) {
  // The id is asked globally and the row moved under the owner: the primary key spans every
  // account, so an id somebody else holds is refused rather than overwritten.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockAccount(txn, incoming.user);
  pqxx::result held = txn.exec_params(
      "SELECT " + std::string(kNoteColumns) + ", (user_id = $2::uuid) AS mine "
      "FROM gym_notes WHERE id = $1",
      incoming.id.str(), incoming.user.str());
  if (!held.empty() && !held[0]["mine"].as<bool>()) return {std::nullopt, NoteWriteError::idTaken};
  if (!held.empty()) {
    // The caller's own id: the same text replays the stored row, different text is an edit.
    const Note stored = noteFrom(held[0]);
    if (stored.title == incoming.title && stored.body == incoming.body)
      return {stored, NoteWriteError::none};
    pqxx::result edited = txn.exec_params(
        "UPDATE gym_notes SET title = $3, body = $4, "
        "  updated_at = to_timestamp($5::bigint / 1000.0) "
        "WHERE id = $1 AND user_id = $2::uuid RETURNING " + std::string(kNoteColumns),
        incoming.id.str(), incoming.user.str(), incoming.title, incoming.body,
        static_cast<long long>(nowMs));
    const Note answer = noteFrom(edited[0]);
    txn.commit();
    return {answer, NoteWriteError::none};
  }

  const std::vector<Note> standing = notesOf(txn, incoming.user);
  if (standing.size() >= kMaxNotes) return {std::nullopt, NoteWriteError::full};
  // Two accounts landing one new id at once hold different locks, so the loser meets the primary
  // key here rather than at commit: no row is the same fact as the read above finding a stranger's.
  pqxx::result inserted = txn.exec_params(
      "INSERT INTO gym_notes (id, user_id, position, title, body, created_at, updated_at) "
      "VALUES ($1, $2::uuid, $3, $4, $5, to_timestamp($6::bigint / 1000.0), "
      "        to_timestamp($6::bigint / 1000.0)) "
      "ON CONFLICT (id) DO NOTHING RETURNING " + std::string(kNoteColumns),
      incoming.id.str(), incoming.user.str(), static_cast<int>(standing.size()), incoming.title,
      incoming.body, static_cast<long long>(nowMs));
  if (inserted.empty()) return {std::nullopt, NoteWriteError::idTaken};
  const Note answer = noteFrom(inserted[0]);
  txn.commit();
  return {answer, NoteWriteError::none};
}

void PgNotesRepository::deleteNote(const UserId& user, const NoteId& id) {
  // Owner-scoped, so another account's id and an absent one are the same no-op. The rows after the
  // gap move up one; the unique on (user_id, position) is deferred, so the shift lands as a whole.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockAccount(txn, user);
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_notes WHERE id = $1 AND user_id = $2::uuid RETURNING position", id.str(),
      user.str());
  if (removed.empty()) return;
  txn.exec_params("UPDATE gym_notes SET position = position - 1 "
                  "WHERE user_id = $1::uuid AND position > $2",
                  user.str(), removed[0]["position"].as<int>());
  txn.commit();
}

NotesOrderOutcome PgNotesRepository::reorderNotes(const UserId& user,
                                                  const std::vector<NoteId>& order) {
  // Decided against the rows as they stand behind the account's lock, then every position
  // rewritten in one transaction — the deferred unique lets rows swap without walking through a
  // collision.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  lockAccount(txn, user);
  const std::vector<Note> standing = notesOf(txn, user);
  if (!namesEveryNoteOnce(standing, order)) return {{}, NotesOrderError::mismatch};
  for (std::size_t at = 0; at < order.size(); ++at)
    txn.exec_params("UPDATE gym_notes SET position = $3 WHERE id = $1 AND user_id = $2::uuid",
                    order[at].str(), user.str(), static_cast<int>(at));
  std::vector<Note> reordered = notesOf(txn, user);
  txn.commit();
  return {std::move(reordered), NotesOrderError::none};
}

std::vector<ExportedNote> PgNotesRepository::exportedNotes(const UserId& user) {
  // Every value is text rendered by Postgres, the instant ISO-8601 UTC, the text byte for byte.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT position::text AS position, title, body, "
      "       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
      "         AS updated_at "
      "FROM gym_notes WHERE user_id = $1::uuid ORDER BY position",
      user.str());
  std::vector<ExportedNote> notes;
  for (const auto& row : rows)
    notes.push_back(ExportedNote{row["position"].as<std::string>(), row["title"].as<std::string>(),
                                 row["body"].as<std::string>(),
                                 row["updated_at"].as<std::string>()});
  return notes;
}

}
