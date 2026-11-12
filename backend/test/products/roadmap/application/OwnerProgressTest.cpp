#include "products/roadmap/application/OwnerProgress.h"

#include "platform/application/WriteObservation.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <trantor/utils/Logger.h>

#include <chrono>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <typeinfo>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// Owners whose one public tree `main` holds `done`, a step that opens their tree `sub`, beside `plain`. Each owner
// completed `sub` at 800 and marked `plain` at 900, so a reader is shown both steps complete when `sub` is followed
// and `plain` alone when it is not.
struct Owners {
  FakeProgressRepository marks;
  FakeTreeRepository trees{marks};
  FakeClock clock;
  OwnerProgress progress{marks, trees, clock};

  OwnersTrees seed(const UserId& owner) {
    const std::string sub = "t_sub_" + owner.str();
    const std::string main = "t_main_" + owner.str();
    LooseGraph subGraph;
    subGraph.createNode(nid("d"), "D", "", NodeColor::sky, std::nullopt, Hlc{1, 0, "seed"});
    trees.byId[sub] = StoredTree{subGraph.exportState(), LegendState{}, {sub, {}}, 0, owner};
    LooseGraph mainGraph;
    mainGraph.createNode(nid("done"), "Done", "", NodeColor::sky, std::nullopt, Hlc{1, 0, "seed"});
    mainGraph.setOpens(nid("done"), TreeId{sub}, Hlc{2, 0, "seed"});
    mainGraph.createNode(nid("plain"), "Plain", "", NodeColor::sky, std::nullopt, Hlc{1, 0, "seed"});
    trees.byId[main] = StoredTree{mainGraph.exportState(), LegendState{}, {main, {}}, 0, owner, Visibility::public_};
    marks.setStatus(TreeId{sub}, owner, nid("d"), ProgressStatus::complete, false, Hlc{800, 0, "seed"}, 800);
    marks.setStatus(TreeId{main}, owner, nid("plain"), ProgressStatus::complete, false, Hlc{900, 0, "seed"}, 900);
    return OwnersTrees{owner, {{TreeId{main}, mainGraph.stampedPointers()}}};
  }

  // The steps of each owner's `main` a reader is shown complete.
  std::map<std::string, std::set<NodeId>> completed(const ShownToReaders& shown) const {
    std::map<std::string, std::set<NodeId>> steps;
    for (const auto& [tree, progress] : shown.progress) steps.emplace(tree.str(), progress.completed);
    return steps;
  }
};

// What the follows told on-call while it lives: each `write` line as operation, door, outcome and level, each Issue
// as operation, door and exception, and every other `roadmap_` line as written.
struct Observed : FailureReporter {
  std::mutex mutex;
  std::vector<std::string> writes;
  std::vector<std::string> issues;
  std::vector<std::string> lines;
  trantor::Logger::LogLevel level = trantor::Logger::logLevel();
  Observed() {
    installWriteSink([this](const WriteCompletion& line) {
      const char* severity[] = {"debug", "info", "warn", "error"};
      std::lock_guard lock(mutex);
      writes.push_back(line.operation + " " + line.door + " " + line.outcome + " " +
                       severity[static_cast<int>(line.severity)]);
    });
    installWriteReporter(std::shared_ptr<FailureReporter>(this, [](FailureReporter*) {}));
    trantor::Logger::setLogLevel(trantor::Logger::kInfo);
    trantor::Logger::setOutputFunction(
        [this](const char* message, std::uint64_t length) {
          const std::string line(message, length);
          const std::size_t start = line.find("roadmap_");
          if (start == std::string::npos) return;
          std::lock_guard lock(mutex);
          lines.push_back(line.substr(start, line.rfind(" - ") - start));
        },
        [] {});
  }
  ~Observed() override {
    installWriteSink({});
    installWriteReporter({});
    trantor::Logger::setOutputFunction([](const char* message, std::uint64_t length) { fwrite(message, 1, length, stdout); },
                                       [] { fflush(stdout); });
    trantor::Logger::setLogLevel(level);
  }
  void report(const std::string&, const std::string&, const std::string&) override {}
  void reportWrite(const std::string& operation, const std::string&, const std::string& door, const std::string&,
                   const std::string&, const std::string& exceptionType) override {
    std::lock_guard lock(mutex);
    issues.push_back(operation + " " + door + " " + exceptionType);
  }
};

}

// A follow that runs past its budget or fails puts its owner in a cool-off that every door honours for five minutes:
// no follow is tried, the reply shows the owner unread at once. A try after it that fails again says so again; the
// first that answers ends it with one line counting the replies it degraded, and a follow that answers is otherwise
// silent.
TEST(an_owner_whose_follow_fails_or_runs_out_is_left_unread_by_every_door_for_five_minutes_and_the_answer_ends_it) {
  Observed observed;
  Owners h;
  const UserId ada{"ada"};
  const std::vector<OwnersTrees> owners{h.seed(ada)};
  const auto shownAt = [&](const char* door) { return h.progress.shownToReaders(owners, kReaderFollowBudget, door); };
  const std::set<NodeId> unread{nid("plain")};
  const std::set<NodeId> followed{nid("done"), nid("plain")};

  h.trees.duringOpenedRead = [] { throw FollowTimedOut{}; };
  const ShownToReaders timedOut = shownAt("rest");
  const ShownToReaders coolingAtTheGallery = shownAt("gallery");
  h.clock.now += 5 * 60 * 1000 - 1;
  const ShownToReaders coolingToTheEnd = shownAt("rest");
  h.clock.now += 1;
  h.trees.duringOpenedRead = [] { throw std::runtime_error("connection reset mid-read"); };
  const ShownToReaders failed = shownAt("rest");
  h.trees.duringOpenedRead = {};
  const ShownToReaders coolingAgain = shownAt("rest");
  h.clock.now += 5 * 60 * 1000;
  const ShownToReaders answered = shownAt("gallery");
  const ShownToReaders answeredAgain = shownAt("rest");

  CHECK(timedOut.tally == (FollowTally{.timedOut = 1}));
  CHECK(coolingAtTheGallery.tally == (FollowTally{.coolingOff = 1}));
  CHECK(coolingToTheEnd.tally == (FollowTally{.coolingOff = 1}));
  CHECK(failed.tally == (FollowTally{.failed = 1}));
  CHECK(coolingAgain.tally == (FollowTally{.coolingOff = 1}));
  CHECK(answered.tally == (FollowTally{.followed = 1}));
  CHECK(answeredAgain.tally == (FollowTally{.followed = 1}));
  for (const ShownToReaders* degraded : {&timedOut, &coolingAtTheGallery, &coolingToTheEnd, &failed, &coolingAgain})
    CHECK(h.completed(*degraded) == (std::map<std::string, std::set<NodeId>>{{"t_main_ada", unread}}));
  CHECK(h.completed(answered) == (std::map<std::string, std::set<NodeId>>{{"t_main_ada", followed}}));
  CHECK(h.completed(answeredAgain) == h.completed(answered));
  CHECK_EQ(h.trees.openedOwners, (std::vector<UserId>{ada, ada, ada, ada}));
  CHECK_EQ(observed.writes, (std::vector<std::string>{"roadmap.progress.follow rest timeout warn",
                                                      "roadmap.progress.follow rest failed error"}));
  CHECK_EQ(observed.issues,
           (std::vector<std::string>{std::string("roadmap.progress.follow rest ") + typeid(std::runtime_error).name()}));
  CHECK_EQ(observed.lines, (std::vector<std::string>{"roadmap_progress_follow_recovered door=gallery degraded_replies=5"}));
}

// Two requests that follow one owner at once and both fail put the owner in one cool-off, told once: the request that
// failed second finds it begun and writes neither a line nor an Issue.
TEST(a_follow_that_fails_after_a_racing_one_began_its_owners_cool_off_writes_no_second_line_or_issue) {
  Observed observed;
  Owners h;
  const UserId ada{"ada"};
  const std::vector<OwnersTrees> owners{h.seed(ada)};
  bool raced = false;
  std::optional<ShownToReaders> racing;
  h.trees.duringOpenedRead = [&] {
    if (!std::exchange(raced, true)) racing = h.progress.shownToReaders(owners, kReaderFollowBudget, "gallery");
    throw std::runtime_error("connection reset mid-read");
  };

  const ShownToReaders first = h.progress.shownToReaders(owners, kReaderFollowBudget, "rest");

  REQUIRE(racing.has_value());
  CHECK(racing->tally == (FollowTally{.failed = 1}));
  CHECK(first.tally == (FollowTally{.failed = 1}));
  CHECK_EQ(observed.writes, (std::vector<std::string>{"roadmap.progress.follow gallery failed error"}));
  CHECK_EQ(observed.issues,
           (std::vector<std::string>{std::string("roadmap.progress.follow gallery ") + typeid(std::runtime_error).name()}));
}

// One owner's slow follow costs that owner alone: the others are followed in turn, each within its own budget, until
// the request's cap. An owner the cap cuts short or never reaches is shown unread for that request only, with no line
// and no cool-off, and is followed in full by the next.
TEST(a_slow_owner_degrades_that_owner_alone_and_the_requests_cap_leaves_the_owners_it_does_not_reach_unread_this_once) {
  Observed observed;
  Owners h;
  const UserId ada{"ada"};
  const UserId bo{"bo"};
  const UserId cy{"cy"};
  const UserId dee{"dee"};
  const std::vector<OwnersTrees> owners{h.seed(ada), h.seed(bo), h.seed(cy), h.seed(dee)};
  h.trees.duringOpenedRead = [&] {
    const UserId& owner = h.trees.openedOwners.back();
    const std::optional<std::chrono::milliseconds> budget = h.trees.openedBudgets.back();
    if (owner == ada) {
      h.clock.now += 750;
      throw FollowTimedOut{};
    }
    if (owner == bo) h.clock.now += 700;
    if (owner == cy && budget < kReaderFollowBudget) {
      h.clock.now += static_cast<std::uint64_t>(budget->count());
      throw FollowTimedOut{};
    }
  };
  const std::set<NodeId> unread{nid("plain")};
  const std::set<NodeId> followed{nid("done"), nid("plain")};

  const ShownToReaders capped = h.progress.shownToReaders(owners, std::chrono::milliseconds{1500}, "gallery");
  const std::vector<std::optional<std::chrono::milliseconds>> cappedBudgets = h.trees.openedBudgets;
  const ShownToReaders next = h.progress.shownToReaders(owners, std::chrono::milliseconds{1500}, "gallery");

  CHECK(capped.tally == (FollowTally{.followed = 1, .timedOut = 1, .pastCap = 2}));
  CHECK(h.completed(capped) == (std::map<std::string, std::set<NodeId>>{
                                   {"t_main_ada", unread}, {"t_main_bo", followed}, {"t_main_cy", unread}, {"t_main_dee", unread}}));
  CHECK_EQ(cappedBudgets, (std::vector<std::optional<std::chrono::milliseconds>>{
                              std::chrono::milliseconds{750}, std::chrono::milliseconds{750}, std::chrono::milliseconds{50}}));
  CHECK(next.tally == (FollowTally{.followed = 3, .coolingOff = 1}));
  CHECK(h.completed(next) == (std::map<std::string, std::set<NodeId>>{
                                 {"t_main_ada", unread}, {"t_main_bo", followed}, {"t_main_cy", followed}, {"t_main_dee", followed}}));
  CHECK_EQ(h.trees.openedOwners, (std::vector<UserId>{ada, bo, cy, bo, cy, dee}));
  CHECK_EQ(observed.writes, (std::vector<std::string>{"roadmap.progress.follow gallery timeout warn"}));
  CHECK_EQ(observed.issues, std::vector<std::string>{});
  CHECK_EQ(observed.lines, std::vector<std::string>{});
}
