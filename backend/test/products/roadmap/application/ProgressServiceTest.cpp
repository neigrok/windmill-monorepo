#include "products/roadmap/application/ProgressService.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

// A single chain r -> a. The advisory check reads only these prerequisite lists, so a bare vector stands in for a whole tree, even a cyclic one.
namespace {
const std::vector<NodeId> noPrereqs{};
const std::vector<NodeId> aPrereqs{nid("r")};

// Main is `owner`'s: `idea` opens Sub and `lost` a tree that is not there; `next` waits on `idea`. Sub is one step, `s`.
// `pointers` is what Main's room hands its writer; a caller who cannot write Main is handed none.
struct Marking {
  FakeProgressRepository repo;
  FakeTreeRepository trees{repo};
  ProgressService service{repo, trees};
  UserId owner = uid("owner");
  std::map<NodeId, TreeId> pointers{{nid("idea"), tid("sub")}, {nid("lost"), tid("gone")}};

  Marking() {
    LooseGraph sub;
    sub.createNode(nid("s"), "S", "", NodeColor::sky, at(1));
    trees.byId["sub"] = StoredTree{sub.exportState(), LegendState{}, {"Sub", {}}, 0, owner};
  }

  ProgressWrite write(const char* node, ProgressStatus status, std::uint64_t ms) const {
    const std::vector<NodeId> prerequisites = std::string(node) == "next" ? std::vector<NodeId>{nid("idea")} : std::vector<NodeId>{};
    return ProgressWrite{nid(node), status, prerequisites, at(ms), false};
  }

  std::map<NodeId, ProgressStatus> stored(const UserId& user) {
    std::map<NodeId, ProgressStatus> statuses;
    for (const auto& [node, mark] : repo.load(tid("main"), user).marks) statuses.emplace(node, mark.status);
    return statuses;
  }
};
}

TEST(progress_records_complete_but_flags_unmet_prerequisites) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);

  ProgressOutcome outcome = service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(1), false}}, StampedBy::replica, 1).outcomes.front();
  CHECK_EQ(outcome.status, ProgressStatus::complete);
  CHECK_FALSE(outcome.prerequisitesMet);

  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.completed.count(nid("a")), 1u);  // recorded despite the advisory miss
}

TEST(progress_complete_with_met_prerequisites) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);

  service.mark(tid(), {}, uid(), {ProgressWrite{nid("r"), ProgressStatus::complete, noPrereqs, at(1), false}}, StampedBy::replica, 1).outcomes.front();
  ProgressOutcome outcome = service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(2), false}}, StampedBy::replica, 2).outcomes.front();
  CHECK(outcome.prerequisitesMet);
}

TEST(progress_none_clears_the_entry) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);

  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(1), false}}, StampedBy::replica, 1).outcomes.front();
  CHECK_EQ(service.progressOf(tid(), uid()).completed.count(nid("a")), 1u);

  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::none, aPrereqs, at(2), false}}, StampedBy::replica, 2).outcomes.front();
  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.cleared.count(nid("a")), 1u);
  CHECK_EQ(progress.completed.count(nid("a")), 0u);
}

TEST(progress_clear_persists_as_a_tombstone_row) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);

  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(1), false}}, StampedBy::replica, 1).outcomes.front();
  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::none, aPrereqs, at(2), false}}, StampedBy::replica, 2).outcomes.front();

  auto entry = repo.byKey.find(FakeProgressRepository::key(tid(), uid(), nid("a")));
  CHECK(entry != repo.byKey.end());  // the clear is a stored LWW value, not a row delete
  CHECK_EQ(entry->second.status, ProgressStatus::none);
  CHECK_EQ(entry->second.at, at(2));

  // The tombstone is VISIBLE on load: a client's reconcile must tell "cleared" from "never marked".
  Progress loaded = repo.load(tid(), uid());
  CHECK(loaded.completed.empty());
  CHECK_EQ(loaded.cleared.size(), 1u);
  CHECK(loaded.cleared.count(nid("a")) == 1);
}

TEST(progress_stale_mark_cannot_resurrect_a_cleared_node) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);

  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(1), false}}, StampedBy::replica, 1).outcomes.front();
  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::none, aPrereqs, at(3), false}}, StampedBy::replica, 3).outcomes.front();
  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(2), false}}, StampedBy::replica, 2).outcomes.front();  // stale replay

  Progress progress = service.progressOf(tid(), uid());
  CHECK_EQ(progress.completed.count(nid("a")), 0u);
  CHECK_EQ(progress.cleared.count(nid("a")), 1u);
}

// The marker's word rides the status value: a completion that carried it keeps it, the next mark on
// the node carries its own word or none, and a stale write cannot smuggle one in.
TEST(progress_keeps_the_out_of_order_word_on_the_mark_until_the_next_mark_replaces_it) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);

  ProgressOutcome outcome = service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(1), true}}, StampedBy::replica, 1).outcomes.front();
  CHECK_EQ(outcome.status, ProgressStatus::complete);
  CHECK_FALSE(outcome.prerequisitesMet);
  CHECK(outcome.applied);
  CHECK(outcome.outOfOrder);
  CHECK(service.progressOf(tid(), uid()).marks.at(nid("a")).outOfOrder);

  ProgressOutcome stale = service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(0), false}}, StampedBy::replica, 0).outcomes.front();
  CHECK_FALSE(stale.applied);
  CHECK(service.progressOf(tid(), uid()).marks.at(nid("a")).outOfOrder);

  ProgressOutcome again = service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(2), false}}, StampedBy::replica, 2).outcomes.front();
  CHECK(again.applied);
  CHECK_FALSE(again.outOfOrder);
  CHECK_FALSE(service.progressOf(tid(), uid()).marks.at(nid("a")).outOfOrder);
}

// A mark the caller already holds — the same status and the same outOfOrder word — says it changed nothing, and is
// still written, so its newer stamp lands; a node never marked holds `none`, and a changed word is a change.
TEST(progress_a_mark_already_held_says_unchanged_and_still_lands_its_stamp) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);
  service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, noPrereqs, at(1), false}}, StampedBy::replica, 1);

  const std::vector<ProgressOutcome> outcomes = service.mark(
      tid(), {}, uid(),
      {ProgressWrite{nid("a"), ProgressStatus::complete, noPrereqs, at(2), false},
       ProgressWrite{nid("r"), ProgressStatus::none, noPrereqs, at(2), false},
       ProgressWrite{nid("b"), ProgressStatus::complete, noPrereqs, at(2), false}},
      StampedBy::replica, 2).outcomes;
  std::vector<bool> unchanged;
  for (const ProgressOutcome& outcome : outcomes) unchanged.push_back(outcome.unchanged);
  CHECK_EQ(unchanged, (std::vector<bool>{true, true, false}));
  CHECK(service.progressOf(tid(), uid()).marks.at(nid("a")).at == at(2));

  CHECK(service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, noPrereqs, at(3), false}}, StampedBy::replica, 3).outcomes.front().unchanged);
  CHECK_FALSE(service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::complete, noPrereqs, at(4), true}}, StampedBy::replica, 4).outcomes.front().unchanged);
}

// What a mark did is read off its own write, so a mark another door lands as the write is on its way is the one it
// meets: a repeat of `complete` over a clear that slipped in is a change. A replica's mark that meets a later stamp
// loses and records nothing; a server's lands just after that stamp and records the stamp it took. Where the write
// cannot say what the row held, the mark is not called unchanged.
TEST(progress_a_mark_is_answered_by_its_own_write_whatever_another_door_wrote_under_it) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);
  const std::string row = FakeProgressRepository::key(tid(), uid(), nid("a"));
  const auto marked = [&](ProgressStatus status, const Hlc& stamp, StampedBy stampedBy) {
    return service.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), status, noPrereqs, stamp, false}}, stampedBy, 9);
  };
  marked(ProgressStatus::complete, at(1), StampedBy::replica);

  repo.duringBatchWrite = [&] { repo.byKey[row] = {ProgressStatus::none, at(2, "phone"), false}; };
  const ProgressReceipt restored = marked(ProgressStatus::complete, at(3), StampedBy::replica);
  CHECK((restored.outcomes == std::vector<ProgressOutcome>{{ProgressStatus::complete, true, true, false, false}}));
  CHECK((restored.recorded.marks == std::map<NodeId, ProgressMark>{{nid("a"), {ProgressStatus::complete, at(3), 9, false}}}));

  repo.duringBatchWrite = [&] { repo.byKey[row] = {ProgressStatus::none, at(50, "phone"), false}; };
  const ProgressReceipt lost = marked(ProgressStatus::complete, at(4), StampedBy::replica);
  CHECK((lost.outcomes == std::vector<ProgressOutcome>{{ProgressStatus::complete, true, false, false, false}}));
  CHECK(lost.recorded.marks.empty());
  CHECK(service.progressOf(tid(), uid()).completed.empty());

  repo.duringBatchWrite = [&] { repo.byKey[row] = {ProgressStatus::none, at(60, "phone"), false}; };
  const ProgressReceipt landed = marked(ProgressStatus::complete, at(5, "srv"), StampedBy::server);
  CHECK((landed.outcomes == std::vector<ProgressOutcome>{{ProgressStatus::complete, true, true, false, false}}));
  CHECK((landed.recorded.marks ==
         std::map<NodeId, ProgressMark>{{nid("a"), {ProgressStatus::complete, Hlc{60, 1, "srv"}, 9, false}}}));
  repo.duringBatchWrite = nullptr;

  struct Unseen : FakeProgressRepository {
    std::vector<ProgressWritten> setStatuses(const TreeId& tree, const UserId& user, const std::vector<ProgressUpdate>& updates,
                                             StampedBy stampedBy, std::uint64_t receivedAtMs) override {
      std::vector<ProgressWritten> written = FakeProgressRepository::setStatuses(tree, user, updates, stampedBy, receivedAtMs);
      for (ProgressWritten& did : written) did.held.reset();
      return written;
    }
  } unseen;
  ProgressService blind(unseen, trees);
  CHECK((blind.mark(tid(), {}, uid(), {ProgressWrite{nid("a"), ProgressStatus::none, noPrereqs, at(1), false}},
                    StampedBy::server, 9).outcomes ==
         std::vector<ProgressOutcome>{{ProgressStatus::none, true, true, false, false}}));
}

TEST(progress_batch_carries_the_out_of_order_word_per_write) {
  FakeProgressRepository repo;
  FakeTreeRepository trees;
  ProgressService service(repo, trees);

  std::vector<ProgressOutcome> outcomes = service.mark(
      tid(), {}, uid(),
      {ProgressWrite{nid("a"), ProgressStatus::complete, aPrereqs, at(1), true},
       ProgressWrite{nid("r"), ProgressStatus::none, noPrereqs, at(2), false}},
      StampedBy::replica, 2).outcomes;
  REQUIRE_EQ(outcomes.size(), 2u);
  CHECK_FALSE(outcomes[0].prerequisitesMet);
  CHECK(outcomes[0].outOfOrder);
  CHECK(outcomes[1].prerequisitesMet);
  CHECK_FALSE(outcomes[1].outOfOrder);

  Progress progress = service.progressOf(tid(), uid());
  CHECK(progress.marks.at(nid("a")).outOfOrder);
  CHECK_FALSE(progress.marks.at(nid("r")).outOfOrder);
}

// The writer's node that opens a standing tree follows it: neither a completion nor a clear of it is written.
TEST(a_writers_mark_on_a_node_that_follows_its_tree_is_refused_and_the_other_marks_are_recorded) {
  Marking m;

  const ProgressReceipt receipt = m.service.mark(
      tid("main"), m.pointers, m.owner,
      {m.write("idea", ProgressStatus::complete, 10), m.write("plain", ProgressStatus::complete, 11),
       m.write("idea", ProgressStatus::none, 12), m.write("ghost", ProgressStatus::none, 13)},
      StampedBy::replica, 20);

  CHECK(receipt.outcomes ==
        (std::vector<ProgressOutcome>{{.status = ProgressStatus::none, .prerequisitesMet = false, .applied = false, .refused = true},
                                      {ProgressStatus::complete, true, true, false},
                                      {.status = ProgressStatus::none, .prerequisitesMet = false, .applied = false, .refused = true},
                                      {ProgressStatus::none, true, true, false, true}}));
  CHECK(m.stored(m.owner) == (std::map<NodeId, ProgressStatus>{{nid("ghost"), ProgressStatus::none},
                                                               {nid("plain"), ProgressStatus::complete}}));
  REQUIRE_EQ(receipt.recorded.marks.size(), 2u);
  CHECK_EQ(receipt.recorded.marks.at(nid("plain")).at, at(11));
  CHECK_EQ(receipt.recorded.marks.at(nid("plain")).markedAt, std::uint64_t{20});
  CHECK(receipt.recorded.completed == std::set<NodeId>{nid("plain")});
  CHECK_EQ(m.trees.openedReads, (std::vector<std::set<TreeId>>{{tid("gone"), tid("sub")}}));
}

TEST(marks_that_are_all_refused_leave_the_stored_marks_as_they_were) {
  Marking m;
  m.repo.setStatus(tid("main"), m.owner, nid("idea"), ProgressStatus::complete, false, at(1), 1);
  const std::map<std::string, FakeProgressRepository::Entry> before = m.repo.byKey;

  const ProgressReceipt receipt = m.service.mark(
      tid("main"), m.pointers, m.owner, {m.write("idea", ProgressStatus::none, 10), m.write("idea", ProgressStatus::complete, 11)}, StampedBy::replica, 20);

  CHECK(receipt.outcomes == (std::vector<ProgressOutcome>{{.status = ProgressStatus::none, .prerequisitesMet = false, .applied = false, .refused = true},
                                                          {.status = ProgressStatus::none, .prerequisitesMet = false, .applied = false, .refused = true}}));
  CHECK(receipt.recorded.marks.empty());
  CHECK(m.repo.byKey == before);
}

// A step behind such a node waits on the opened tree: a mark the node holds does not meet it, and the tree's completion does.
TEST(an_advisory_for_the_trees_writer_reads_the_followed_completed_set) {
  Marking m;
  m.repo.setStatus(tid("main"), m.owner, nid("idea"), ProgressStatus::complete, false, at(1), 1);

  const ProgressReceipt open = m.service.mark(tid("main"), m.pointers, m.owner, {m.write("next", ProgressStatus::complete, 10)}, StampedBy::replica, 20);
  m.repo.setStatus(tid("main"), m.owner, nid("idea"), ProgressStatus::none, false, at(11), 11);
  m.repo.setStatus(tid("sub"), m.owner, nid("s"), ProgressStatus::complete, false, at(12), 12);
  const ProgressReceipt complete = m.service.mark(tid("main"), m.pointers, m.owner, {m.write("next", ProgressStatus::complete, 13)}, StampedBy::replica, 20);

  CHECK(open.outcomes == (std::vector<ProgressOutcome>{{ProgressStatus::complete, false, true, false}}));
  CHECK(complete.outcomes == (std::vector<ProgressOutcome>{{ProgressStatus::complete, true, true, false, true}}));
}

// A caller who cannot write the tree is handed no pointer, as is anyone marking a tree that holds none.
TEST(marks_handed_no_pointer_are_all_ordinary_judged_on_the_callers_own_marks_and_nothing_is_read) {
  Marking m;
  m.repo.setStatus(tid("sub"), m.owner, nid("s"), ProgressStatus::complete, false, at(1), 1);
  const UserId reader = uid("reader");

  const ProgressReceipt unmet = m.service.mark(tid("main"), {}, reader, {m.write("next", ProgressStatus::complete, 10)}, StampedBy::replica, 20);
  const ProgressReceipt met = m.service.mark(
      tid("main"), {}, reader, {m.write("next", ProgressStatus::complete, 11), m.write("idea", ProgressStatus::complete, 12)}, StampedBy::replica, 20);
  const ProgressReceipt cleared = m.service.mark(tid("main"), {}, reader, {m.write("idea", ProgressStatus::none, 13)}, StampedBy::replica, 20);

  CHECK(unmet.outcomes == (std::vector<ProgressOutcome>{{ProgressStatus::complete, false, true, false}}));
  CHECK(met.outcomes == (std::vector<ProgressOutcome>{{ProgressStatus::complete, true, true, false, true},
                                                      {ProgressStatus::complete, true, true, false}}));
  CHECK(cleared.outcomes == (std::vector<ProgressOutcome>{{ProgressStatus::none, true, true, false}}));
  CHECK(m.stored(reader) == (std::map<NodeId, ProgressStatus>{{nid("idea"), ProgressStatus::none},
                                                              {nid("next"), ProgressStatus::complete}}));
  CHECK(m.trees.openedReads.empty());
}

TEST(a_call_with_no_mark_to_judge_reads_and_writes_nothing) {
  Marking m;

  const ProgressReceipt receipt = m.service.mark(tid("main"), m.pointers, m.owner, {}, StampedBy::replica, 20);

  CHECK(receipt.outcomes.empty());
  CHECK(receipt.recorded.marks.empty());
  CHECK_FALSE(receipt.cameToARefusal());
  CHECK(m.trees.openedReads.empty());
  CHECK(m.repo.byKey.empty());
}

// What the write line says is read off what was recorded: a mark that lost to a later stamp recorded nothing either.
TEST(a_receipt_comes_to_a_refusal_when_no_mark_was_recorded_and_one_was_refused) {
  Marking m;
  m.repo.setStatus(tid("main"), m.owner, nid("plain"), ProgressStatus::complete, false, at(100), 100);

  const ProgressReceipt refusedAndLost = m.service.mark(
      tid("main"), m.pointers, m.owner, {m.write("idea", ProgressStatus::complete, 10), m.write("plain", ProgressStatus::none, 11)}, StampedBy::replica, 20);
  const ProgressReceipt lost = m.service.mark(tid("main"), m.pointers, m.owner, {m.write("plain", ProgressStatus::none, 12)}, StampedBy::replica, 20);
  const ProgressReceipt refusedAndRecorded = m.service.mark(
      tid("main"), m.pointers, m.owner, {m.write("idea", ProgressStatus::complete, 13), m.write("next", ProgressStatus::none, 14)}, StampedBy::replica, 20);

  CHECK(refusedAndLost.outcomes ==
        (std::vector<ProgressOutcome>{{.status = ProgressStatus::none, .prerequisitesMet = false, .applied = false, .refused = true}, {ProgressStatus::none, true, false, false}}));
  CHECK(refusedAndLost.cameToARefusal());
  CHECK_FALSE(lost.cameToARefusal());
  CHECK_FALSE(refusedAndRecorded.cameToARefusal());
  CHECK(m.stored(m.owner) == (std::map<NodeId, ProgressStatus>{{nid("next"), ProgressStatus::none},
                                                               {nid("plain"), ProgressStatus::complete}}));
}

TEST(a_mark_on_a_node_whose_pointer_is_not_valid_is_recorded_for_the_trees_writer) {
  Marking m;
  m.trees.byId["gone"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Theirs", {}}, 0, uid("someone-else")};

  const ProgressReceipt theirs = m.service.mark(tid("main"), m.pointers, m.owner, {m.write("lost", ProgressStatus::complete, 10)}, StampedBy::replica, 20);
  m.trees.softDelete(tid("sub"));
  const ProgressReceipt deleted = m.service.mark(tid("main"), m.pointers, m.owner, {m.write("idea", ProgressStatus::complete, 11)}, StampedBy::replica, 20);

  CHECK(theirs.outcomes == (std::vector<ProgressOutcome>{{ProgressStatus::complete, true, true, false}}));
  CHECK(deleted.outcomes == (std::vector<ProgressOutcome>{{ProgressStatus::complete, true, true, false}}));
  CHECK(m.stored(m.owner) == (std::map<NodeId, ProgressStatus>{{nid("idea"), ProgressStatus::complete},
                                                               {nid("lost"), ProgressStatus::complete}}));
}
