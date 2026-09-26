#pragma once

#include <compare>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace wm::sync {

// A text that is not an order key, or ends given to `between` that are not ascending.
struct OrderKeyError : std::invalid_argument {
  using std::invalid_argument::invalid_argument;
};

// D-25: a jitterless base-62 order key (0-9A-Za-z) that sorts bytewise. Its head letter fixes the
// length of its integer part, and its fraction never ends in '0'.
bool isOrderKey(std::string_view key);

// A key strictly between `a` and `b`, nullopt being an open end, byte-identical to the web's
// fractionalIndex.js keyBetween. Throws OrderKeyError unless both are keys and a < b.
std::string between(const std::optional<std::string>& a, const std::optional<std::string>& b);

// A list member as a view draws it. Members sort by (key, id): the key is declared first so the
// defaulted order is that order.
struct OrderedMember {
  std::string key;
  std::string id;

  auto operator<=>(const OrderedMember&) const = default;
};

// D-25 drop position: the key of `moved` dropped just below the drawn member `above` (nullopt: at the
// top). It lies between `above`'s key and the next greater key among the stored members other than
// `moved`; at the top, before the first of them; with no greater key, after `above`. So a member that
// is stored but not drawn, as a held delete is, keeps its stored place.
std::string dropKey(const std::vector<OrderedMember>& stored, const std::vector<OrderedMember>& drawn, std::string_view moved,
                    const std::optional<std::string>& above);

}
