#include "products/gym/domain/Correction.h"
#include "test/testing.h"

using namespace wm::gym;

TEST(gym_correction_validates_complete_shape_before_deriving_revisions) {
  const Session session{SessionId{"ses_correct01"}, wm::UserId{"owner"}, 1000, 3000};
  const Set set{SetId{"set_correct01"}, session.id, ExerciseId{"bench-press"}, 1, 80, 8,
                SetKind::working, 8, "note", 2000};
  SessionCorrectionIn request{"fix_correct01", 1000, 3000, "Workout", {{set, true, true}}};
  const auto unchanged = SessionCorrectionBatch{session, {set}, request, 4000};
  CHECK_EQ(unchanged.sets, std::vector<Set>{set});
  CHECK(unchanged.replaced.empty());
  CHECK(unchanged.removed.empty());
  for (int invalid = 0; invalid < 6; ++invalid) {
    auto bad = request;
    if (invalid == 0) bad.sets.clear();
    if (invalid == 1) bad.sets.push_back(bad.sets[0]);
    if (invalid == 2) bad.sets[0].set.exercise = ExerciseId{"back-squat"};
    if (invalid == 3) bad.sets[0].set.completedAtMs = 3001;
    if (invalid == 4) bad.finishedAtMs = 4001;
    if (invalid == 5) bad.sets[0].set.weightKg = 80.001;
    bool refused = false;
    try { SessionCorrectionBatch correction{session, {set}, bad, 4000}; }
    catch (const InvalidTraining&) { refused = true; }
    CHECK(refused);
  }
}
