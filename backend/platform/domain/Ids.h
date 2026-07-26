#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

namespace wm {

template <typename Tag>
class Id {
public:
  Id() = default;
  explicit Id(std::string value) : value_(std::move(value)) {}

  const std::string& str() const { return value_; }
  bool empty() const { return value_.empty(); }

  bool operator==(const Id&) const = default;
  auto operator<=>(const Id&) const = default;

private:
  std::string value_;
};

struct UserTag;

using UserId = Id<UserTag>;

using Seq = std::uint64_t;

// Hybrid logical clock stamp. Ordered by (physicalMs, counter, actor) — the default
// spaceship compares members in that declaration order, which is exactly the HLC order.
struct Hlc {
  std::uint64_t physicalMs = 0;
  std::uint32_t counter = 0;
  std::string actor;

  bool operator==(const Hlc&) const = default;
  auto operator<=>(const Hlc&) const = default;

  bool isSet() const { return physicalMs != 0 || counter != 0 || !actor.empty(); }
};

// The canonical stamp text, shared by the op log, the subgraph wire, and the golden
// corpus: "physicalMs:counter:actor". The actor keeps any ':' it contains (everything past
// the second colon), and the unset sentinel round-trips as "0:0:".
inline std::string toString(const Hlc& hlc) {
  return std::to_string(hlc.physicalMs) + ":" + std::to_string(hlc.counter) + ":" + hlc.actor;
}

inline Hlc parseHlc(std::string_view text) {
  auto first = text.find(':');
  auto second = text.find(':', first + 1);
  if (first == std::string_view::npos || second == std::string_view::npos) return Hlc{};
  Hlc hlc;
  hlc.physicalMs = std::stoull(std::string(text.substr(0, first)));
  hlc.counter = static_cast<std::uint32_t>(std::stoul(std::string(text.substr(first + 1, second - first - 1))));
  hlc.actor = std::string(text.substr(second + 1));
  return hlc;
}

// One monotone hybrid logical clock per replica (a browser tab, the server, a device). It
// mints strictly increasing stamps under a fixed actor and folds every remote stamp it
// sees, so a write minted after observing a tombstone always dominates it — the receive
// rule that keeps "keep more, lose less" true across replicas.
class HlcClock {
public:
  explicit HlcClock(std::string actor) : actor_(std::move(actor)) {}

  Hlc tick(std::uint64_t wallMs) {
    std::uint64_t ms = std::max(wallMs, lastMs_);
    counter_ = (ms == lastMs_) ? counter_ + 1 : 0;
    lastMs_ = ms;
    return Hlc{ms, counter_, actor_};
  }

  void observe(const Hlc& stamp) {
    if (!stamp.isSet()) return;
    if (stamp.physicalMs > lastMs_ || (stamp.physicalMs == lastMs_ && stamp.counter > counter_)) {
      lastMs_ = stamp.physicalMs;
      counter_ = stamp.counter;
    }
  }

  const std::string& actor() const { return actor_; }

private:
  std::string actor_;
  std::uint64_t lastMs_ = 0;
  std::uint32_t counter_ = 0;
};

}
