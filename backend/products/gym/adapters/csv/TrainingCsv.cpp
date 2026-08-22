#include "products/gym/adapters/csv/TrainingCsv.h"

#include <initializer_list>
#include <string_view>

namespace wm::gym {

namespace {
// A spreadsheet runs a cell that opens with =, + or @ instead of showing it, and the cell's author
// is not always the person who opens the file: a movement name and a note are both writable by any
// MCP client the lifter granted gym:write, and an Ask turn is composed by a model reading text the
// lifter pasted. So the few cells that would EXECUTE carry a leading apostrophe, which every
// spreadsheet reads as "what follows is text" — the one edit this file makes, named here because
// the promise below is otherwise absolute.
//
// A negative number is deliberately NOT one of those cells. Loads are kg and negative is legal
// (band-assisted work logs that way), -20 is a number to a spreadsheet and not a formula, and
// quoting it as text would break the weight column for every lifter who uses a band. So a leading
// sign is a formula only when what follows it is not a plain number: `-20.00` travels untouched,
// `-1+1` and `-cmd|' /C calc'!A0` do not.
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

// Quoted only where the framing needs it, so the common file stays the readable one: a weight, a
// rep count and a movement name go through untouched and only a note with a comma or a newline in
// it pays for the quotes.
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

std::string toCsv(const std::vector<ExportedThreadTurn>& turns) {
  std::string csv = line({"thread_id", "title", "outcome", "changes", "routine", "created_at",
                          "turn_number", "from", "text", "said_at"});
  for (const ExportedThreadTurn& row : turns)
    csv += line({row.threadId, row.title, row.outcome, row.changes, row.routine, row.createdAt,
                 row.turnNumber, row.from, row.text, row.saidAt});
  return csv;
}

}
