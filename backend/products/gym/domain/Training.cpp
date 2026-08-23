#include "products/gym/domain/Training.h"

#include <utility>

namespace wm::gym {

std::string toString(Pattern pattern) {
  switch (pattern) {
    case Pattern::squat: return "squat";
    case Pattern::hinge: return "hinge";
    case Pattern::press: return "press";
    case Pattern::pull: return "pull";
    case Pattern::carry: return "carry";
    case Pattern::core: return "core";
    case Pattern::isolation: return "isolation";
  }
  return "isolation";
}

std::string toString(Equipment equipment) {
  switch (equipment) {
    case Equipment::barbell: return "barbell";
    case Equipment::dumbbell: return "dumbbell";
    case Equipment::machine: return "machine";
    case Equipment::cable: return "cable";
    case Equipment::bodyweight: return "bodyweight";
    case Equipment::kettlebell: return "kettlebell";
  }
  return "barbell";
}

std::string toString(SetKind kind) {
  switch (kind) {
    case SetKind::warmup: return "warmup";
    case SetKind::working: return "working";
    case SetKind::drop: return "drop";
    case SetKind::failure: return "failure";
  }
  return "working";
}

Pattern parsePattern(std::string_view text) {
  if (text == "squat") return Pattern::squat;
  if (text == "hinge") return Pattern::hinge;
  if (text == "press") return Pattern::press;
  if (text == "pull") return Pattern::pull;
  if (text == "carry") return Pattern::carry;
  if (text == "core") return Pattern::core;
  if (text == "isolation") return Pattern::isolation;
  throw InvalidTraining("unknown pattern: " + std::string(text));
}

Equipment parseEquipment(std::string_view text) {
  if (text == "barbell") return Equipment::barbell;
  if (text == "dumbbell") return Equipment::dumbbell;
  if (text == "machine") return Equipment::machine;
  if (text == "cable") return Equipment::cable;
  if (text == "bodyweight") return Equipment::bodyweight;
  if (text == "kettlebell") return Equipment::kettlebell;
  throw InvalidTraining("unknown equipment: " + std::string(text));
}

SetKind parseSetKind(std::string_view text) {
  if (text == "warmup") return SetKind::warmup;
  if (text == "working") return SetKind::working;
  if (text == "drop") return SetKind::drop;
  if (text == "failure") return SetKind::failure;
  throw InvalidTraining("unknown set kind: " + std::string(text));
}

Pattern patternFromStored(std::string_view text) {
  try {
    return parsePattern(text);
  } catch (const InvalidTraining&) {
    return Pattern::isolation;
  }
}

Equipment equipmentFromStored(std::string_view text) {
  try {
    return parseEquipment(text);
  } catch (const InvalidTraining&) {
    return Equipment::barbell;
  }
}

SetKind setKindFromStored(std::string_view text) {
  try {
    return parseSetKind(text);
  } catch (const InvalidTraining&) {
    return SetKind::working;
  }
}

bool wellFormedId(std::string_view id) {
  if (id.size() < 8 || id.size() > 64) return false;
  for (char c : id) {
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

// The same well-formedness Postgres applies, applied here where the answer is still a 400: overlong
// encodings and surrogate halves are refused by the code point they decode to.
bool storableText(std::string_view text) {
  for (std::size_t at = 0; at < text.size();) {
    const unsigned char lead = static_cast<unsigned char>(text[at]);
    if (lead == 0x00) return false;
    if (lead < 0x80) {
      at += 1;
      continue;
    }
    // A continuation byte standing alone, an overlong two-byte form (0xC0/0xC1) and a lead past the
    // last plane (above 0xF4) are all decided by the lead byte alone.
    if (lead < 0xC2 || lead > 0xF4) return false;
    const std::size_t width = lead < 0xE0 ? 2 : (lead < 0xF0 ? 3 : 4);
    if (at + width > text.size()) return false;
    unsigned int point = lead & (width == 2 ? 0x1Fu : (width == 3 ? 0x0Fu : 0x07u));
    for (std::size_t step = 1; step < width; ++step) {
      const unsigned char next = static_cast<unsigned char>(text[at + step]);
      if ((next & 0xC0) != 0x80) return false;
      point = (point << 6) | (next & 0x3Fu);
    }
    if (width == 3 && point < 0x800) return false;      // an overlong three-byte form
    if (width == 4 && point < 0x10000) return false;    // an overlong four-byte form
    if (point > 0x10FFFF) return false;
    if (point >= 0xD800 && point <= 0xDFFF) return false;
    at += width;
  }
  return true;
}

std::string trimmedName(std::string text) {
  const std::string_view blanks = " \t\n\r\f\v";
  const std::size_t first = text.find_first_not_of(blanks);
  if (first == std::string::npos) return {};
  return text.substr(first, text.find_last_not_of(blanks) - first + 1);
}

double defaultStepKg(Equipment equipment) {
  switch (equipment) {
    case Equipment::barbell: return 2.5;      // the smallest plate pair
    case Equipment::dumbbell: return 2.0;     // the rack gap
    case Equipment::machine: return 5.0;      // the pin
    case Equipment::cable: return 2.5;
    case Equipment::bodyweight: return 2.5;   // a belt plate
    case Equipment::kettlebell: return 4.0;
  }
  return 2.5;
}

Exercise::Exercise(ExerciseId id, std::string name, Pattern pattern, Equipment equipment,
                   double stepKg, bool custom, std::vector<std::string> aliases)
    : id(std::move(id)), name(trimmedName(std::move(name))), pattern(pattern),
      equipment(equipment), stepKg(stepKg), custom(custom), aliases(std::move(aliases)) {
  if (this->id.empty()) throw InvalidTraining("an exercise needs an id");
  // Trimmed first, so a name of nothing but blanks is refused here.
  if (this->name.empty()) throw InvalidTraining("an exercise needs a name");
  if (this->name.size() > kMaxNameLength) throw InvalidTraining("exercise name too long");
  // A NUL truncates a name to its own head; non-UTF-8 bytes are refused by Postgres mid-transaction,
  // which would leave as a retryable 500 for a name that can never land.
  if (!storableText(this->name)) throw InvalidTraining("an exercise name must be storable text");
  // step_kg is numeric(4,2): a step of 100 overflows the column and a step under 0.01 rounds to 0.00
  // in it, so both ends are refused here rather than mid-transaction as a retryable 500.
  if (stepKg < kMinStepKg || stepKg > kMaxStepKg) throw InvalidTraining("step out of range");
}

Session::Session(SessionId id, UserId user, std::uint64_t startedAtMs,
                 std::optional<std::uint64_t> finishedAtMs, std::optional<RoutineId> routine,
                 std::optional<PlanSnapshot> plan, std::optional<ClosedBy> closedBy)
    : id(std::move(id)), user(std::move(user)), startedAtMs(startedAtMs),
      finishedAtMs(finishedAtMs), routine(std::move(routine)), plan(std::move(plan)),
      closedBy(closedBy) {
  if (!wellFormedId(this->id.str())) throw InvalidTraining("bad session id");
  if (this->user.empty()) throw InvalidTraining("a session belongs to an account");
  if (startedAtMs == 0 || startedAtMs > kMaxInstantMs)
    throw InvalidTraining("a session starts at an instant");
  if (finishedAtMs && (*finishedAtMs == 0 || *finishedAtMs > kMaxInstantMs))
    throw InvalidTraining("a session finishes at an instant");
}

Set::Set(SetId id, SessionId session, ExerciseId exercise, int setNumber, double weightKg,
         int reps, SetKind kind, std::optional<double> rpe, std::string note,
         std::uint64_t completedAtMs)
    : id(std::move(id)), session(std::move(session)), exercise(std::move(exercise)),
      setNumber(setNumber), weightKg(weightKg), reps(reps), kind(kind), rpe(rpe),
      note(std::move(note)), completedAtMs(completedAtMs) {
  if (!wellFormedId(this->id.str())) throw InvalidTraining("bad set id");
  if (this->session.empty()) throw InvalidTraining("a set belongs to a session");
  if (this->exercise.empty()) throw InvalidTraining("a set names an exercise");
  if (setNumber < 0) throw InvalidTraining("set number cannot be negative");
  if (weightKg < -500 || weightKg > 500) throw InvalidTraining("weight out of range");
  if (reps < 1 || reps > 500) throw InvalidTraining("reps out of range");
  if (rpe && (*rpe < 1 || *rpe > 10)) throw InvalidTraining("rpe out of range");
  if (this->note.size() > 4000) throw InvalidTraining("note too long");
  // Refuse what storage cannot hold rather than shortening a lifter's words in silence.
  if (!storableText(this->note)) throw InvalidTraining("a note must be storable text");
  if (completedAtMs == 0 || completedAtMs > kMaxInstantMs)
    throw InvalidTraining("a set completes at an instant");
}

// Constructed rather than assigned, so the fields a correction may NOT move are visibly copied.
Set corrected(const Set& stored, const SetFix& fix) {
  return Set{stored.id,
             stored.session,
             stored.exercise,
             stored.setNumber,
             fix.weightKg.value_or(stored.weightKg),
             fix.reps.value_or(stored.reps),
             fix.kind.value_or(stored.kind),
             fix.rpeNamed ? fix.rpe : stored.rpe,
             fix.note.value_or(stored.note),
             stored.completedAtMs};
}

std::optional<std::uint64_t> autoCloseAt(const Session& session,
                                         std::optional<std::uint64_t> lastSetAtMs,
                                         std::uint64_t nowMs) {
  if (session.finishedAtMs) return std::nullopt;
  const std::uint64_t lastActivityMs = lastSetAtMs.value_or(session.startedAtMs);
  if (nowMs < lastActivityMs + kAutoCloseMs) return std::nullopt;
  return lastActivityMs;
}

bool canFinishAt(const Session& session, std::uint64_t finishedAtMs) {
  if (finishedAtMs == 0 || finishedAtMs > kMaxInstantMs) return false;
  return finishedAtMs >= session.startedAtMs;
}

bool canStartAt(std::uint64_t startedAtMs, std::uint64_t nowMs) {
  return startedAtMs <= nowMs + kMaxClockAheadMs;
}

std::string toString(ClosedBy closedBy) {
  return closedBy == ClosedBy::stale ? "stale" : "finish";
}

std::optional<ClosedBy> closedByFromStored(std::string_view text) {
  if (text == "stale") return ClosedBy::stale;
  if (text == "finish") return ClosedBy::finish;
  return std::nullopt;
}

std::uint64_t finishAfterStaleClose(const Session& staleClosed, std::uint64_t finishedAtMs) {
  const std::uint64_t lastActivityMs = staleClosed.finishedAtMs.value_or(staleClosed.startedAtMs);
  if (finishedAtMs > lastActivityMs + kAutoCloseMs) return lastActivityMs;
  return std::max(lastActivityMs, finishedAtMs);
}

bool lateSetLands(const Session& session, std::uint64_t completedAtMs) {
  if (!session.finishedAtMs || session.closedBy != ClosedBy::stale) return false;
  return completedAtMs <= *session.finishedAtMs + kAutoCloseMs;
}

std::uint64_t shareExpiryAt(std::uint64_t nowMs) {
  if (nowMs > kMaxInstantMs - kShareLifetimeMs) return kMaxInstantMs;
  return nowMs + kShareLifetimeMs;
}

}
