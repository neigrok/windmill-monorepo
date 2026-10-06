#include "products/gym/adapters/postgres/PgNotesRepository.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

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
}

PgNotesRepository::PgNotesRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::vector<Note> PgNotesRepository::notes(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kNoteColumns) + " FROM gym_notes WHERE user_id = $1::uuid ORDER BY position",
      user.str());
  std::vector<Note> notes;
  for (const auto& row : rows) notes.push_back(noteFrom(row));
  return notes;
}

// The note as that save stored it, kept as the jsonb receipt the door wrote.
std::optional<Note> PgNotesRepository::noteSave(const UserId& user, const NoteId& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params("SELECT note::text FROM gym_note_saves WHERE id=$1 AND user_id=$2::uuid",
                                    id.str(), user.str());
  if (rows.empty()) return std::nullopt;
  const auto value = parse(rows[0][0].as<std::string>());
  return Note{NoteId{value["id"].asString()}, user, value["title"].asString(), value["body"].asString(),
              value["position"].asInt(), value["updatedAt"].asUInt64()};
}

}
