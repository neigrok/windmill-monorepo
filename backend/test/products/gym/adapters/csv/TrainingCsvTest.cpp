#include "products/gym/adapters/csv/TrainingCsv.h"

#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm::gym;

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

TEST(gym_csv_disarms_a_cell_a_spreadsheet_would_run) {
  const std::string csv = toCsv({setRow("=cmd|' /C calc'!A0", "100.00", "@SUM(1+1)*cmd"),
                                 setRow("+1+1", "100.00", "-1+1")});

  CHECK(csv.find(",'=cmd|' /C calc'!A0,") != std::string::npos);
  CHECK(csv.find(",'@SUM(1+1)*cmd,") != std::string::npos);
  CHECK(csv.find(",'+1+1,") != std::string::npos);
  CHECK(csv.find(",'-1+1,") != std::string::npos);
  CHECK(toCsv({setRow("=HYPERLINK(\"http://evil\",\"click\")", "100.00", "")})
            .find("\"'=HYPERLINK(\"\"http://evil\"\",\"\"click\"\")\"") != std::string::npos);
}

TEST(gym_csv_leaves_a_negative_load_a_number) {
  const std::string csv = toCsv({setRow("Assisted Pull-up", "-20.00", "-5 kg band"),
                                 setRow("Deadlift", "+100", "")});

  CHECK(csv.find(",-20.00,") != std::string::npos);
  CHECK(csv.find(",+100,") != std::string::npos);
  // A sign in front of prose is still a formula opener.
  CHECK(csv.find(",'-5 kg band,") != std::string::npos);
}

TEST(gym_csv_disarms_a_thread_turn_a_model_wrote) {
  const std::string csv = toCsv(std::vector<ExportedThreadTurn>{
      {"th_1", "=1+1", "applied", "", "", "2026-08-16T05:00:00Z", "1", "coach",
       "@lookup the coach's number", "2026-08-16T05:00:01Z"}});

  CHECK(csv.find("th_1,'=1+1,applied,") != std::string::npos);
  CHECK(csv.find(",coach,'@lookup the coach's number,") != std::string::npos);
}

TEST(gym_csv_exports_a_note_in_precedence_order_and_disarms_what_a_lifter_typed) {
  const std::string csv = toCsv(std::vector<ExportedNote>{
      {"0", "How I want to be talked to", "Blunt, no praise.\r\nNumbers first.",
       "2026-08-16T05:00:00Z"},
      {"1", "=SUM(A1)", "", "2026-08-16T05:00:01Z"}});

  CHECK_EQ(csv, std::string("position,title,body,updated_at\r\n"
                            "0,How I want to be talked to,\"Blunt, no praise.\r\nNumbers first.\","
                            "2026-08-16T05:00:00Z\r\n"
                            "1,'=SUM(A1),,2026-08-16T05:00:01Z\r\n"));
}

TEST(gym_csv_exports_a_weigh_in_per_day_with_the_stores_own_renderings) {
  const std::string csv = toCsv(std::vector<ExportedBodyweight>{
      {"2026-08-01", "83.00", "2026-08-01T06:02:00Z"}, {"2026-08-25", "82.40", "2026-08-25T06:14:00Z"}});

  CHECK_EQ(csv, std::string("date,weight_kg,recorded_at\r\n"
                            "2026-08-01,83.00,2026-08-01T06:02:00Z\r\n"
                            "2026-08-25,82.40,2026-08-25T06:14:00Z\r\n"));
  CHECK_EQ(toCsv(std::vector<ExportedBodyweight>{}), std::string("date,weight_kg,recorded_at\r\n"));
}
