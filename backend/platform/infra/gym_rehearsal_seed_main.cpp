#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/postgres/PgAuthRepository.h"
#include "products/gym/adapters/http/CoachImage.h"
#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/adapters/postgres/PgBodyweightRepository.h"
#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgNotesRepository.h"
#include "products/gym/adapters/postgres/PgPreferencesRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"
#include "products/gym/application/ProgramService.h"

#include <drogon/drogon.h>

#include <cstdlib>
#include <iostream>
#include <stdexcept>

namespace {
using namespace wm;
using namespace wm::gym;

constexpr std::uint64_t kNow = 1'790'856'000'000;
constexpr std::uint64_t kDay = 24ull * 60 * 60 * 1000;

struct SeedClock : Clock {
  std::uint64_t now = kNow;
  std::uint64_t nowMs() override { return now; }
};

void require(bool condition, const std::string& operation) {
  if (!condition) throw std::runtime_error("seed refused: " + operation);
}

std::string id(const std::string& kind, int account, int row = 0, int item = 0) {
  return kind + "_rehearsal_" + std::to_string(account) + "_" + std::to_string(row) + "_" + std::to_string(item);
}

}

int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--help") {
      std::cout << "windmill_gym_rehearsal_seed (DATABASE_URL must name an empty throwaway database with schema.sql)\n";
      return 0;
    }
    if (argc != 1) throw std::runtime_error("seed takes no arguments");
    const char* database = std::getenv("DATABASE_URL");
    if (!database || !*database) throw std::runtime_error("DATABASE_URL is required");
    configureJsonReplies(drogon::app());
    auto pool = std::make_shared<PgPool>(database, 1);
    {
      PgLease connection{*pool};
      pqxx::work transaction{*connection};
      require(transaction.exec("SELECT count(*) FROM users")[0][0].as<int>() == 0,
              "database must have no accounts");
      require(transaction.exec("SELECT count(*) FROM information_schema.columns WHERE table_name='gym_sessions' AND column_name='seq'")[0][0].as<int>() == 0,
              "seed before applying gym_sync.sql; uses today's repositories");
    }
    PgAuthRepository accounts{pool};
    PgCatalogRepository catalog{pool};
    PgProgramRepository program{pool};
    PgLogRepository log{pool};
    PgNotesRepository notes{pool};
    PgBodyweightRepository bodyweight{pool};
    PgPreferencesRepository preferences{pool};
    PgAskThreadRepository threads{pool};
    SeedClock clock;
    ProgramService plans{program, clock};
    for (int account = 1; account <= 5; ++account) {
      const User user = accounts.createUser(Email{"gym-rehearsal-" + std::to_string(account) + "@example.invalid"},
                                           "Rehearsal " + std::to_string(account));
      Json::Value report(Json::objectValue);
      report["account"] = user.id.str();
      report["fixture"] = account;
      if (account == 5) {
        report["kind"] = "empty";
        std::cout << dump(report) << '\n';
        continue;
      }
      if (account == 4) {
        const Note insight{NoteId{id("note", account)}, user.id, "Deleted insight", "Receipt outlives the note."};
        require(notes.saveInsight(insight, kNow - kDay).error == NoteWriteError::none, "spent-only note save");
        notes.deleteNote(user.id, insight.id);
        report["kind"] = "spent-note-only";
        std::cout << dump(report) << '\n';
        continue;
      }
      const Exercise custom{ExerciseId{id("ex", account)}, "Banded pull-up", Pattern::pull,
                            Equipment::bodyweight, 1.25, true};
      require(catalog.insertExercise(user.id, custom).error == ExerciseInsertError::none, "custom movement");
      require(catalog.renameExercise(user.id, custom.id, "Assisted pull-up").has_value(), "custom rename");
      require(catalog.renameExercise(user.id, custom.id, "Band-assisted pull-up").has_value(), "custom aliases");
      require(catalog.renameExercise(user.id, ExerciseId{"bench-press"}, "Paused bench").has_value(), "seed rename");
      require(catalog.renameExercise(user.id, ExerciseId{"back-squat"}, "Low-bar squat").has_value(), "alias-only seed rename");
      require(catalog.renameExercise(user.id, ExerciseId{"back-squat"}, "Back Squat").has_value(), "alias-only seed reset");
      std::vector<RoutineEntry> entries{
          {1, ExerciseId{"bench-press"}, {{5, 60.0}, {5, 80.0}, {std::nullopt, std::nullopt}}, 180},
          {2, ExerciseId{"back-squat"}, {}, std::nullopt},
          {3, custom.id, {{8, -20.0}, {std::nullopt, -15.0}}, 90}};
      Routine main{RoutineId{id("rt", account, 1)}, user.id, "Strength A", account, entries};
      require(program.insertRoutine(main, ProposalDoor::mcp, kNow - 120 * kDay).error == RoutineWriteError::none,
              "main routine");
      Routine other{RoutineId{id("rt", account, 2)}, user.id, "Strength B", account + 10,
                    {{1, ExerciseId{"back-squat"}, {{5, 80.0}, {5, 85.0}}, 150}}};
      require(program.insertRoutine(other, std::nullopt, kNow - 100 * kDay).error == RoutineWriteError::none,
              "second routine");
      Routine removed{RoutineId{id("rt", account, 3)}, user.id, "Retired day", account + 20, entries};
      require(program.insertRoutine(removed, std::nullopt, kNow - 150 * kDay).error == RoutineWriteError::none,
              "deleted routine creation");
      require(program.deleteRoutine(user.id, removed.id), "routine deletion");

      for (int workout = 1; workout <= 8; ++workout) {
        const std::uint64_t started = kNow - (90 - workout * 7) * kDay + account * 60'000;
        const SessionId sessionId{id("ses", account, workout)};
        const Session session{sessionId, user.id, started, started + 3'600'000, main.id,
                              snapshotOf(main), ClosedBy::finish};
        std::vector<Set> performed{
            {SetId{id("set", account, workout, 1)}, sessionId, ExerciseId{"bench-press"}, 0,
             40.0, 10, SetKind::warmup, std::nullopt, "Warm-up", started + 60'000},
            {SetId{id("set", account, workout, 2)}, sessionId, ExerciseId{"bench-press"}, 0,
             70.0 + workout * 2.5, 5, SetKind::working, 7.5, "Paused · controlled", started + 120'000},
            {SetId{id("set", account, workout, 3)}, sessionId, ExerciseId{"bench-press"}, 0,
             70.0 + workout * 2.5, 4, SetKind::working, std::nullopt, "", started + 180'000},
            {SetId{id("set", account, workout, 4)}, sessionId, custom.id, 0,
             -20.0, 8, SetKind::working, 8.0, "Assisted", started + 240'000},
            {SetId{id("set", account, workout, 5)}, sessionId, ExerciseId{"back-squat"}, 0,
             60.0, 12, SetKind::drop, std::nullopt, "Back-off", started + 300'000}};
        require(log.importSession(session, SetBatch{sessionId, performed, kNow, true}).error == BatchLogError::none,
                "historical import");
        if (workout == 1) {
          auto corrected = performed[1];
          corrected.weightKg = 75;
          corrected.reps = 6;
          require(log.updateSet(user.id, corrected).has_value(), "corrected set revision");
          log.deleteSet(user.id, sessionId, performed[2].id);
        }
        if (workout == 2) {
          auto corrected = log.setsOf(sessionId);
          std::vector<CorrectionSetIn> corrections;
          for (auto& set : corrected) {
            if (set.id == performed[1].id) set.note = "Correction: bar included";
            corrections.push_back({set, true, true});
          }
          const SessionCorrectionIn correction{id("corr", account, workout), started,
              started + 3'540'000, "Strength A · corrected", corrections};
          require(log.correctSession(user.id, sessionId, correction, kNow).error == CorrectionError::none,
                  "whole-session correction receipt");
        }
        if (workout == 3) require(log.deleteSession(user.id, sessionId), "deleted imported workout");
        if (workout == 4) {
          require(log.insertShare({sessionId, user.id, id("share", account, workout), kMaxInstantMs}, kNow).has_value(),
                  "workout share");
        }
      }
      const Session stale{SessionId{id("ses", account, 9)}, user.id, kNow - 7 * kDay,
                          std::nullopt, other.id, snapshotOf(other)};
      log.insertSession(stale);
      require(log.insertSet({SetId{id("set", account, 9, 1)}, stale.id, ExerciseId{"back-squat"}, 0,
                             82.5, 5, SetKind::working, 8.0, "Left running", stale.startedAtMs + 60'000}).error == SetInsertError::none,
              "stale open session");

      const ThreadId threadId{id("thr", account)};
      require(threads.openThread(user.id, threadId, "Training constraints", kNow - kDay).error == ThreadOpenError::none,
              "Coach thread");
      threads.appendTurns(user.id, threadId,
          {{true, "I train three days a week; keep the sessions under an hour.", kNow - kDay},
           {false, "A revised plan is waiting for your review.", kNow - kDay + 1}});
      const unsigned char pngBytes[] = {
          0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
          0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x04,0x00,0x00,0x00,0xb5,0x1c,0x0c,
          0x02,0x00,0x00,0x00,0x0b,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0xf8,0xff,0x1f,0x00,
          0x03,0x00,0x01,0xff,0xfc,0x25,0xdc,0x51,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,
          0xae,0x42,0x60,0x82};
      const std::string png(reinterpret_cast<const char*>(pngBytes), sizeof pngBytes);
      const auto image = decodeCoachImage(id("img", account), "image/png", png);
      require(image.has_value(), "Coach image decode");
      require(threads.putImage(user.id, threadId, *image) == ImageWriteError::none, "Coach image repository");
      auto proposed = entries;
      proposed[0].restSeconds = 150;
      const ProposalSource mcp{ProposalDoor::mcp, "rehearsal-agent", "Training partner", std::nullopt};
      require(plans.propose(user.id, {ProposalId{id("prop", account, 1)}, main.id, std::nullopt,
                  "Shorten rests", proposed, mcp}).error == ProposalMintError::none, "first proposal");
      proposed[0].restSeconds = 120;
      require(plans.propose(user.id, {ProposalId{id("prop", account, 2)}, main.id, "Strength A · efficient",
                  "A more efficient session", proposed, mcp}).error == ProposalMintError::none, "superseding proposal");
      require(plans.propose(user.id, {ProposalId{id("prop", account, 3)}, other.id, "Strength B · easy",
                  "Recovery day", other.entries, {ProposalDoor::ask, "", "Coach", threadId}}).error == ProposalMintError::none,
                  "Coach proposal");
      require(plans.dismiss(user.id, ProposalId{id("prop", account, 3)}).error == ProposalSettleError::none,
              "dismissed proposal");
      require(plans.proposeRemoval(user.id, ProposalId{id("prop", account, 4)}, other.id,
                  "Remove the spare day", {ProposalDoor::ask, "", "Coach", threadId}).error == ProposalMintError::none,
                  "removal proposal");

      for (int note = 1; note <= 3; ++note) {
        const Note incoming{NoteId{id("note", account, note)}, user.id,
                            "Constraint " + std::to_string(note), "Keep my training sustainable — three days per week."};
        require(notes.saveInsight(incoming, kNow - note * kDay).error == NoteWriteError::none, "notes and receipts");
      }
      notes.deleteNote(user.id, NoteId{id("note", account, 2)});
      require(notes.saveNote({NoteId{id("note", account, 1)}, user.id, "Training goal",
                              "Build strength; no max attempts."}, kNow).error == NoteWriteError::none,
              "edited note receipt");
      require(notes.reorderNotes(user.id, {NoteId{id("note", account, 3)}, NoteId{id("note", account, 1)}}).error == NotesOrderError::none,
              "note precedence");
      for (int day = 1; day <= 14; ++day) {
        const std::string date = "2026-09-" + std::string(day < 10 ? "0" : "") + std::to_string(day);
        bodyweight.save({user.id, date, 78.0 + account + day * 0.03, kNow - (30 - day) * kDay});
      }
      bodyweight.save({user.id, "2026-09-07", 79.25 + account, kNow});
      preferences.savePreferences({user.id, account == 2 ? Unit::lb : Unit::kg,
                                   account == 3 ? std::nullopt : std::optional<int>{150}, true, true, false});
      require(log.createLogShare({id("logshare", account, 1), user.id, id("logtoken", account, 1),
                  LogShareMode::snapshot, false, 0, kMaxInstantMs, kNow, kMaxInstantMs}).has_value(), "snapshot log share");
      require(log.createLogShare({id("logshare", account, 2), user.id, id("logtoken", account, 2),
                  LogShareMode::live, true, kNow - 120 * kDay, kNow, kNow, kMaxInstantMs}).has_value(), "live range log share");
      report["kind"] = "training-history";
      report["sessions"] = 8;
      report["sets"] = 35;
      report["proposals"] = 4;
      report["notes"] = 2;
      report["weighins"] = 14;
      std::cout << dump(report) << '\n';
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "gym rehearsal seed: " << error.what() << '\n';
    return 1;
  }
}
