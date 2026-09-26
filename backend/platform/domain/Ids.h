#pragma once

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <limits>
#include <optional>
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

// Ordered by (physicalMs, counter, actor): the default spaceship compares members in declaration
// order, which is the HLC order.
struct Hlc {
  std::uint64_t physicalMs = 0;
  std::uint32_t counter = 0;
  std::string actor;

  bool operator==(const Hlc&) const = default;
  auto operator<=>(const Hlc&) const = default;

  bool isSet() const { return physicalMs != 0 || counter != 0 || !actor.empty(); }
};

// "physicalMs:counter:actor". The actor keeps any ':' it contains, and the unset stamp is "0:0:".
inline std::string toString(const Hlc& hlc) {
  return std::to_string(hlc.physicalMs) + ":" + std::to_string(hlc.counter) + ":" + hlc.actor;
}

// D-1, strictly: ms below 2^53 and counter below 2^32, each in decimal without a sign or a leading
// zero, then an actor of 1-64 printable ASCII bytes (0x20-0x7E) that may hold ':'. "0:0:" is the unset
// stamp, the only one without an actor. Any other text is not a stamp.
inline std::optional<Hlc> parseHlc(std::string_view text) {
  const std::size_t first = text.find(':');
  const std::size_t second = first == std::string_view::npos ? first : text.find(':', first + 1);
  if (second == std::string_view::npos) return std::nullopt;

  auto decimal = [](std::string_view digits, std::uint64_t limit) -> std::optional<std::uint64_t> {
    if (digits.empty() || (digits.size() > 1 && digits.front() == '0')) return std::nullopt;
    std::uint64_t value = 0;
    const auto [end, error] = std::from_chars(digits.data(), digits.data() + digits.size(), value);
    if (error != std::errc{} || end != digits.data() + digits.size() || value >= limit) return std::nullopt;
    return value;
  };
  const std::optional<std::uint64_t> ms = decimal(text.substr(0, first), std::uint64_t{1} << 53);
  const std::optional<std::uint64_t> counter = decimal(text.substr(first + 1, second - first - 1), std::uint64_t{1} << 32);
  if (!ms || !counter) return std::nullopt;

  const std::string_view actor = text.substr(second + 1);
  const bool printable = std::all_of(actor.begin(), actor.end(), [](char c) { return c >= 0x20 && c <= 0x7E; });
  if (!printable || actor.size() > 64) return std::nullopt;
  const Hlc hlc{*ms, static_cast<std::uint32_t>(*counter), std::string(actor)};
  if (actor.empty() && hlc.isSet()) return std::nullopt;
  return hlc;
}

// §10.2, one per replica: mints strictly increasing stamps under a fixed actor and folds every remote
// stamp it observes, so a write minted after seeing a tombstone dominates it. The state is the pair
// (ms, counter) a replica persists; the actor belongs to the engine instance using it.
class HlcClock {
public:
  struct State {
    std::uint64_t ms = 0;
    std::uint32_t counter = 0;

    bool operator==(const State&) const = default;
  };

  explicit HlcClock(std::string actor) : actor_(std::move(actor)) {}
  HlcClock(std::string actor, State state) : actor_(std::move(actor)), state_(state) {}

  // A physical time ahead of the clock resets the counter; otherwise the counter counts on, and a
  // counter past 2^32 - 1 carries into the next millisecond.
  Hlc tick(std::uint64_t physNowMs) {
    if (physNowMs > state_.ms) {
      state_ = State{physNowMs, 0};
    } else if (state_.counter == std::numeric_limits<std::uint32_t>::max()) {
      state_ = State{state_.ms + 1, 0};
    } else {
      ++state_.counter;
    }
    return Hlc{state_.ms, state_.counter, actor_};
  }

  void observe(const Hlc& stamp) {
    if (std::pair(stamp.physicalMs, stamp.counter) > std::pair(state_.ms, state_.counter))
      state_ = State{stamp.physicalMs, stamp.counter};
  }

  const std::string& actor() const { return actor_; }
  State state() const { return state_; }

private:
  std::string actor_;
  State state_{};
};

}
