#include "products/roadmap/domain/read/FollowGraph.h"

#include <algorithm>
#include <bit>
#include <stdexcept>

namespace wm::roadmap::read {

namespace {

constexpr std::size_t kNone = static_cast<std::size_t>(-1);

bool bitAt(const std::vector<std::uint32_t>& bits, std::size_t row, std::size_t slot) {
  return (bits[row + (slot >> 5)] & (std::uint32_t{1} << (slot & 31))) != 0;
}

}

Components components(const std::vector<std::vector<std::size_t>>& adjacency) {
  const std::size_t size = adjacency.size();
  std::vector<std::size_t> reached(size, kNone);
  std::vector<std::size_t> low(size, 0);
  std::vector<bool> active(size, false);
  Components found{{}, std::vector<std::size_t>(size, 0)};
  std::vector<std::size_t> pending;
  std::size_t serial = 0;
  struct Frame {
    std::size_t vertex;
    std::size_t next;
  };
  for (std::size_t start = 0; start < size; ++start) {
    if (reached[start] != kNone) continue;
    std::vector<Frame> walk{{start, 0}};
    while (!walk.empty()) {
      Frame& frame = walk.back();
      const std::size_t vertex = frame.vertex;
      if (reached[vertex] == kNone) {
        reached[vertex] = low[vertex] = serial++;
        active[vertex] = true;
        pending.push_back(vertex);
      }
      const std::vector<std::size_t>& parents = adjacency[vertex];
      if (frame.next < parents.size()) {
        const std::size_t parent = parents[frame.next++];
        if (reached[parent] == kNone) walk.push_back({parent, 0});
        else if (active[parent]) low[vertex] = std::min(low[vertex], reached[parent]);
        continue;
      }
      walk.pop_back();
      if (!walk.empty()) low[walk.back().vertex] = std::min(low[walk.back().vertex], low[vertex]);
      if (low[vertex] != reached[vertex]) continue;
      std::vector<std::size_t> group;
      std::size_t member = kNone;
      do {
        if (pending.empty()) throw std::logic_error("Invalid roadmap component stack");
        member = pending.back();
        pending.pop_back();
        active[member] = false;
        found.componentOf[member] = found.groups.size();
        group.push_back(member);
      } while (member != vertex);
      found.groups.push_back(std::move(group));
    }
  }
  return found;
}

const char* stateName(StepState state) {
  switch (state) {
    case StepState::complete: return "complete";
    case StepState::available: return "available";
    case StepState::locked: return "locked";
  }
  return "locked";
}

FollowGraph::Closure FollowGraph::close(const std::vector<std::vector<std::size_t>>& adjacency,
                                        const std::map<std::size_t, std::size_t>& seeds, std::size_t size) {
  Closure closure;
  closure.words = (size + 31) / 32;
  Components found = components(adjacency);
  closure.componentOf = std::move(found.componentOf);
  closure.bits.assign(found.groups.size() * closure.words, 0);
  for (std::size_t component = 0; component < found.groups.size(); ++component) {
    const std::size_t row = component * closure.words;
    std::set<std::size_t> dependencies;
    for (const std::size_t vertex : found.groups[component]) {
      const auto seed = seeds.find(vertex);
      if (seed != seeds.end()) closure.bits[row + (seed->second >> 5)] |= std::uint32_t{1} << (seed->second & 31);
      for (const std::size_t parent : adjacency[vertex]) {
        const std::size_t dependency = closure.componentOf[parent];
        if (dependency != component) dependencies.insert(dependency);
      }
    }
    for (const std::size_t dependency : dependencies) {
      const std::size_t source = dependency * closure.words;
      for (std::size_t word = 0; word < closure.words; ++word) closure.bits[row + word] |= closure.bits[source + word];
    }
  }
  return closure;
}

FollowGraph::FollowGraph(const RoadmapTree& tree, std::optional<std::set<std::string>> completed,
                         std::optional<std::map<std::string, Instant>> dates)
    : tree_(tree) {
  for (const Step& step : tree.nodes) {
    if (!step.present) continue;
    slot_.emplace(step.id, ids_.size());
    ids_.push_back(step.id);
  }
  for (const Edge& edge : tree.edges)
    if (edge.present) edges_.push_back(edge);
  const auto addRaw = [this](const std::string& id) {
    if (rawSlot_.emplace(id, rawIds_.size()).second) rawIds_.push_back(id);
  };
  for (const std::string& id : ids_) addRaw(id);
  for (const Edge& edge : edges_) {
    addRaw(edge.from);
    addRaw(edge.to);
  }
  parents_.assign(rawIds_.size(), {});
  for (const Edge& edge : edges_) parents_[rawSlot_.at(edge.to)].push_back(rawSlot_.at(edge.from));

  std::map<std::size_t, std::size_t> seeds;
  for (std::size_t slot = 0; slot < ids_.size(); ++slot) seeds.emplace(rawSlot_.at(ids_[slot]), slot);
  std::vector<std::vector<std::size_t>> upToPresent(parents_.size());
  for (std::size_t vertex = 0; vertex < parents_.size(); ++vertex)
    if (!seeds.contains(vertex)) upToPresent[vertex] = parents_[vertex];
  frontier_ = close(upToPresent, seeds, ids_.size());
  const std::size_t words = frontier_.words;
  direct_.assign(ids_.size() * words, 0);

  if (completed) completed_ = std::move(*completed);
  else {
    for (const auto& [node, mark] : tree.marks) {
      const Step* step = tree.step(node);
      const Pointer* pointer = tree.pointerOn(node);
      const bool ownsBranch = step && step->branch && !step->branch->empty();
      if (mark.status == "complete" && !ownsBranch && !(pointer && pointer->present)) completed_.insert(node);
    }
  }
  if (dates) dates_ = std::move(*dates);
  else
    for (const auto& [node, mark] : tree.marks) dates_[node] = mark.at();

  std::vector<std::uint32_t> completeBits(words, 0);
  for (const std::string& id : completed_) {
    const auto slot = slot_.find(id);
    if (slot != slot_.end()) completeBits[slot->second >> 5] |= std::uint32_t{1} << (slot->second & 31);
  }
  states_.resize(ids_.size());
  unmetCounts_.resize(ids_.size());
  inDegrees_.resize(ids_.size());
  for (const std::string& id : ids_) unlocked_[id];
  for (std::size_t slot = 0; slot < ids_.size(); ++slot) {
    const std::size_t row = slot * words;
    for (const std::size_t parent : parents_[rawSlot_.at(ids_[slot])]) {
      const std::size_t source = frontier_.row(parent);
      for (std::size_t word = 0; word < words; ++word) direct_[row + word] |= frontier_.bits[source + word];
    }
    std::size_t count = 0;
    std::size_t degree = 0;
    std::size_t first = kNone;
    for (std::size_t word = 0; word < words; ++word) {
      degree += std::popcount(direct_[row + word]);
      const std::uint32_t unmetBits = direct_[row + word] & ~completeBits[word];
      count += std::popcount(unmetBits);
      if (first == kNone && unmetBits) first = word * 32 + std::countr_zero(unmetBits);
    }
    const std::string& id = ids_[slot];
    const bool complete = completed_.contains(id);
    unmetCounts_[slot] = count;
    inDegrees_[slot] = degree;
    states_[slot] = complete ? StepState::complete : count ? StepState::locked : StepState::available;
    if (!complete && count == 1 && first != kNone && ids_[first] != id) unlocked_[ids_[first]].push_back(id);
  }
}

Instant FollowGraph::dateOf(const std::string& id) const {
  const auto found = dates_.find(id);
  return found == dates_.end() ? std::nullopt : found->second;
}

StepState FollowGraph::state(const std::string& id) const { return states_[slot_.at(id)]; }

std::size_t FollowGraph::inDegree(const std::string& id) const { return inDegrees_[slot_.at(id)]; }

std::size_t FollowGraph::unmetCount(const std::string& id) const { return unmetCounts_[slot_.at(id)]; }

std::vector<Followed> FollowGraph::followed(const std::string& id) const {
  if (!slot_.contains(id)) return {};
  std::map<std::string, Followed> found;
  const std::size_t vertex = rawSlot_.at(id);
  std::set<std::size_t> seen;
  for (const std::size_t parent : parents_[vertex]) {
    if (!seen.insert(parent).second) continue;
    const std::string& from = rawIds_[parent];
    const std::size_t row = frontier_.row(parent);
    const bool throughAbsent = !slot_.contains(from);
    for (std::size_t word = 0; word < frontier_.words; ++word) {
      std::uint32_t bits = frontier_.bits[row + word];
      while (bits) {
        const std::size_t index = word * 32 + std::countr_zero(bits);
        bits &= bits - 1;
        if (index >= ids_.size()) continue;
        Followed& entry = found.try_emplace(ids_[index], Followed{ids_[index], {}, false}).first->second;
        entry.incoming.emplace_back(from, id);
        entry.throughAbsent = entry.throughAbsent || throughAbsent;
      }
    }
  }
  std::vector<Followed> ordered;
  for (auto& [prerequisite, entry] : found) ordered.push_back(std::move(entry));
  std::stable_sort(ordered.begin(), ordered.end(),
                   [this](const Followed& a, const Followed& b) { return slot_.at(a.id) < slot_.at(b.id); });
  for (Followed& entry : ordered)
    std::stable_sort(entry.incoming.begin(), entry.incoming.end(),
                     [](const auto& a, const auto& b) { return a.first < b.first; });
  return ordered;
}

std::vector<std::string> FollowGraph::unmet(const std::string& id) const {
  const auto slot = slot_.find(id);
  if (slot == slot_.end()) return {};
  std::vector<std::string> found;
  for (std::size_t index = 0; index < ids_.size(); ++index)
    if (!completed_.contains(ids_[index]) && bitAt(direct_, slot->second * frontier_.words, index))
      found.push_back(ids_[index]);
  return found;
}

const FollowGraph::Closure& FollowGraph::debt() const {
  if (debt_) return *debt_;
  std::map<std::size_t, std::size_t> seeds;
  for (const std::string& id : ids_) {
    if (completed_.contains(id)) continue;
    seeds.emplace(rawSlot_.at(id), debtIds_.size());
    debtIds_.push_back(id);
  }
  std::vector<std::vector<std::size_t>> adjacency(parents_.size());
  for (std::size_t vertex = 0; vertex < parents_.size(); ++vertex) {
    const std::string& raw = rawIds_[vertex];
    if (!(completed_.contains(raw) && slot_.contains(raw))) adjacency[vertex] = parents_[vertex];
  }
  debt_ = close(adjacency, seeds, debtIds_.size());
  return *debt_;
}

std::vector<std::string> FollowGraph::owed(const std::string& id) const {
  if (!slot_.contains(id)) return {};
  const Closure& closure = debt();
  std::vector<std::uint32_t> bits(closure.words, 0);
  for (const std::size_t parent : parents_[rawSlot_.at(id)]) {
    const std::size_t row = closure.row(parent);
    for (std::size_t word = 0; word < closure.words; ++word) bits[word] |= closure.bits[row + word];
  }
  std::vector<std::string> found;
  for (std::size_t slot = 0; slot < debtIds_.size(); ++slot)
    if (debtIds_[slot] != id && bitAt(bits, 0, slot)) found.push_back(debtIds_[slot]);
  return found;
}

std::size_t FollowGraph::owedCount(const std::string& id) const {
  if (completed_.contains(id)) return 0;
  const Closure& closure = debt();
  const std::size_t row = closure.row(rawSlot_.at(id));
  std::size_t count = 0;
  for (std::size_t word = 0; word < closure.words; ++word) count += std::popcount(closure.bits[row + word]);
  return count - 1;
}

const std::vector<std::string>& FollowGraph::unlocks(const std::string& id) const {
  static const std::vector<std::string> kNoSteps;
  const auto found = unlocked_.find(id);
  return found == unlocked_.end() ? kNoSteps : found->second;
}

StepDetail FollowGraph::detail(const std::string& id) const {
  return StepDetail{id, followed(id), unmet(id), owed(id), unlocks(id)};
}

}
