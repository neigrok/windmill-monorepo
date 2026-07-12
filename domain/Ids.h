#pragma once

#include <cstdint>
#include <string>
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

struct TreeTag;
struct NodeTag;
struct UserTag;
struct KindTag;

using TreeId = Id<TreeTag>;
using NodeId = Id<NodeTag>;
using UserId = Id<UserTag>;
using KindId = Id<KindTag>;

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

}
