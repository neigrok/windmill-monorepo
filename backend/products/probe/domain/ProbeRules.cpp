#include "products/probe/domain/ProbeRules.h"

#include "platform/domain/sync/Wire.h"

namespace wm::probe {

using namespace sync;

bool isOpen(const Row& run) {
  if (!run.alive()) return false;
  const auto ended = run.lattice.f.find("endedAt");
  return ended == run.lattice.f.end() || ended->second.value.isNull();
}

void requireStartedRuns(const std::vector<Change>& changes) {
  for (const Change& change : changes) {
    if (change.type->name == "run" && change.op == Op::create && change.source != Source::command) throw Refusal(code::invalid);
  }
}

std::vector<Delta> lapsDyingWithRuns(const std::vector<Change>& changes, const std::vector<Row>& laps) {
  std::vector<Delta> deaths;
  for (const Change& change : changes) {
    if (change.type->name != "run" || !change.wasAlive() || change.after.alive()) continue;
    for (const Row& lap : laps) {
      const auto run = lap.lattice.f.find("runId");
      if (!lap.alive() || run == lap.lattice.f.end() || run->second.value != change.after.id.json()) continue;
      Delta death{.t = "lap", .id = lap.id};
      death.lattice.born = lap.lattice.born;
      death.lattice.life = Life(LifeState::dead, Stamp{});
      deaths.push_back(std::move(death));
    }
  }
  return deaths;
}

std::vector<Delta> copyOfTree(const std::vector<Row>& sourceRows) {
  std::vector<Delta> copy;
  for (const Row& row : sourceRows) {
    if (row.t == "meta") {
      const auto title = row.lattice.f.find("title");
      if (title == row.lattice.f.end()) continue;
      Delta meta{.t = row.t, .id = row.id};
      meta.lattice.f.emplace("title", title->second);
      copy.push_back(std::move(meta));
      continue;
    }
    if ((row.t != "tag" && row.t != "link") || !row.alive()) continue;
    Delta record{.t = row.t, .id = row.id};
    record.lattice.life = row.lattice.life;
    if (row.lattice.born) record.lattice.born = row.lattice.life->stamp;
    record.lattice.f = row.lattice.f;
    copy.push_back(std::move(record));
  }
  return copy;
}

}
