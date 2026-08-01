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

Exercise::Exercise(ExerciseId id, std::string name, Pattern pattern, Equipment equipment,
                   double stepKg, bool custom)
    : id(std::move(id)), name(std::move(name)), pattern(pattern), equipment(equipment),
      stepKg(stepKg), custom(custom) {
  if (this->id.empty()) throw InvalidTraining("an exercise needs an id");
  if (this->name.empty()) throw InvalidTraining("an exercise needs a name");
  if (stepKg <= 0) throw InvalidTraining("step must be a positive weight");
}

Session::Session(SessionId id, UserId user, std::uint64_t startedAtMs,
                 std::optional<std::uint64_t> finishedAtMs, std::optional<RoutineId> routine,
                 std::string planJson)
    : id(std::move(id)), user(std::move(user)), startedAtMs(startedAtMs),
      finishedAtMs(finishedAtMs), routine(std::move(routine)), planJson(std::move(planJson)) {
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
  // Postgres text stops at a NUL and would store the head of the note as if it were the whole
  // thing — refuse what storage cannot hold rather than shorten a lifter's words in silence.
  if (this->note.find('\0') != std::string::npos)
    throw InvalidTraining("a note cannot hold a NUL byte");
  if (completedAtMs == 0 || completedAtMs > kMaxInstantMs)
    throw InvalidTraining("a set completes at an instant");
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

}
