#include "products/gym/adapters/csv/TrainingCsv.h"

#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm::gym;

// Framing, and the one edit framing is allowed to make. The export's promise is that a lifter's
// words travel byte for byte; the exception is a cell a spreadsheet would run instead of show,
// which matters here because a movement name and a note are writable by any MCP client the lifter
// granted gym:write, and an Ask turn is written by a model.

namespace {
ExportedSet setRow(std::string exerciseName, std::string weightKg, std::string note) {
  return ExportedSet{"ses_1",  "2026-08-16T05:00:00Z", "", "", "st_1", "back-squat",
                     std::move(exerciseName), "1", std::move(weightKg), "5", "working", "",
                     std::move(note), "2026-08-16T05:01:00Z"};
}
}

TEST(gym_csv_frames_a_plain_row_untouched) {
  const std::string csv = toCsv({setRow("Back Squat", "100.00", "felt light")});

  CHECK_EQ(csv,
           std::string("session_id,started_at,finished_at,routine,set_id,exercise_id,exercise,"
                       "set_number,weight_kg,reps,kind,rpe,note,completed_at\r\n"
                       "ses_1,2026-08-16T05:00:00Z,,,st_1,back-squat,Back Squat,1,100.00,5,working,"
                       ",felt light,2026-08-16T05:01:00Z\r\n"));
}

TEST(gym_csv_quotes_only_what_the_framing_needs) {
  const std::string csv = toCsv({setRow("Back Squat", "100.00", "paused, then \"failed\"\r\nagain")});

  CHECK(csv.find("\"paused, then \"\"failed\"\"\r\nagain\"") != std::string::npos);
}

// The four openers a spreadsheet executes. Each keeps its own bytes after the apostrophe, so the
// value is still readable in the cell — it is shown rather than run.
TEST(gym_csv_disarms_a_cell_a_spreadsheet_would_run) {
  const std::string csv = toCsv({setRow("=cmd|' /C calc'!A0", "100.00", "@SUM(1+1)*cmd"),
                                 setRow("+1+1", "100.00", "-1+1")});

  CHECK(csv.find(",'=cmd|' /C calc'!A0,") != std::string::npos);
  CHECK(csv.find(",'@SUM(1+1)*cmd,") != std::string::npos);
  CHECK(csv.find(",'+1+1,") != std::string::npos);
  CHECK(csv.find(",'-1+1,") != std::string::npos);
  // A formula that also needs framing gets both, in that order.
  CHECK(toCsv({setRow("=HYPERLINK(\"http://evil\",\"click\")", "100.00", "")})
            .find("\"'=HYPERLINK(\"\"http://evil\"\",\"\"click\"\")\"") != std::string::npos);
}

// The rule that must NOT fire: negative loads are legal (band-assisted work) and a number is not a
// formula. Quoting these as text would break the weight column for every lifter who uses a band.
TEST(gym_csv_leaves_a_negative_load_a_number) {
  const std::string csv = toCsv({setRow("Assisted Pull-up", "-20.00", "-5 kg band"),
                                 setRow("Deadlift", "+100", "")});

  CHECK(csv.find(",-20.00,") != std::string::npos);
  CHECK(csv.find(",+100,") != std::string::npos);
  // A sign in front of prose is still a formula opener, so the note beside that load is disarmed.
  CHECK(csv.find(",'-5 kg band,") != std::string::npos);
}

TEST(gym_csv_disarms_a_thread_turn_a_model_wrote) {
  const std::string csv = toCsv(std::vector<ExportedThreadTurn>{
      {"th_1", "=1+1", "applied", "", "", "2026-08-16T05:00:00Z", "1", "ask",
       "@lookup the coach's number", "2026-08-16T05:00:01Z"}});

  CHECK(csv.find("th_1,'=1+1,applied,") != std::string::npos);
  CHECK(csv.find(",ask,'@lookup the coach's number,") != std::string::npos);
}
