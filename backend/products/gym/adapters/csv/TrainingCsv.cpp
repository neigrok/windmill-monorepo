#include "products/gym/adapters/csv/TrainingCsv.h"

#include <initializer_list>
#include <string_view>

namespace wm::gym {

namespace {
// A leading + or - is a formula only when what follows is not a plain number: negative loads are
// legal kilograms.
bool runsAsFormula(std::string_view value) {
  if (value.empty()) return false;
  const char first = value.front();
  if (first == '=' || first == '@' || first == '\t' || first == '\r' || first == '\n') return true;
  if (first != '+' && first != '-') return false;
  const std::string_view rest = value.substr(1);
  bool decimalPoint = false;
  for (const char c : rest) {
    if (c == '.' && !decimalPoint) {
      decimalPoint = true;
      continue;
    }
    if (c < '0' || c > '9') return true;
  }
  return false;
}

std::string field(std::string_view value) {
  if (runsAsFormula(value)) return field("'" + std::string(value));
  if (value.find_first_of(",\"\r\n") == std::string_view::npos) return std::string(value);
  std::string quoted = "\"";
  for (const char c : value) {
    if (c == '"') quoted += '"';
    quoted += c;
  }
  quoted += '"';
  return quoted;
}

// The separator rides on a flag, not on emptiness: an empty first cell would swallow the comma
// after it and shift the row by one column.
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

std::string toCsv(const std::vector<ExportedThreadTurn>& turns) {
  std::string csv = line({"thread_id", "title", "outcome", "changes", "routine", "created_at",
                          "turn_number", "from", "text", "said_at"});
  for (const ExportedThreadTurn& row : turns)
    csv += line({row.threadId, row.title, row.outcome, row.changes, row.routine, row.createdAt,
                 row.turnNumber, row.from, row.text, row.saidAt});
  return csv;
}

std::string toCsv(const std::vector<ExportedNote>& notes) {
  std::string csv = line({"position", "title", "body", "updated_at"});
  for (const ExportedNote& row : notes)
    csv += line({row.position, row.title, row.body, row.updatedAt});
  return csv;
}

std::string toCsv(const std::vector<ExportedBodyweight>& entries) {
  std::string csv = line({"date", "weight_kg", "recorded_at"});
  for (const ExportedBodyweight& row : entries)
    csv += line({row.date, row.weightKg, row.recordedAt});
  return csv;
}

}
