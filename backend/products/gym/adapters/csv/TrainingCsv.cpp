#include "products/gym/adapters/csv/TrainingCsv.h"

#include <initializer_list>
#include <string_view>

namespace wm::gym {

namespace {
// Quoted only where the framing needs it, so the common file stays the readable one: a weight, a
// rep count and a movement name go through untouched and only a note with a comma or a newline in
// it pays for the quotes.
std::string field(std::string_view value) {
  if (value.find_first_of(",\"\r\n") == std::string_view::npos) return std::string(value);
  std::string quoted = "\"";
  for (const char c : value) {
    if (c == '"') quoted += '"';
    quoted += c;
  }
  quoted += '"';
  return quoted;
}

// The header goes through this too, so the names and the rows can never be framed by two different
// rules. The separator rides on a flag rather than on "is the line empty yet", which is the same
// bug in miniature that the export exists to avoid: an empty first cell would swallow the comma
// after it and shift every column of that row by one.
std::string line(std::initializer_list<std::string_view> values) {
  std::string out;
  bool first = true;
  for (std::string_view value : values) {
    if (!first) out += ',';
    first = false;
    out += field(value);
  }
  out += "\r\n";
  return out;
}
}

std::string toCsv(const std::vector<ExportedSet>& sets) {
  std::string csv = line({"session_id", "started_at", "finished_at", "routine", "set_id",
                          "exercise_id", "exercise", "set_number", "weight_kg", "reps", "kind",
                          "rpe", "note", "completed_at"});
  for (const ExportedSet& row : sets)
    csv += line({row.sessionId, row.startedAt, row.finishedAt, row.routineName, row.setId,
                 row.exerciseId, row.exerciseName, row.setNumber, row.weightKg, row.reps, row.kind,
                 row.rpe, row.note, row.completedAt});
  return csv;
}

}
