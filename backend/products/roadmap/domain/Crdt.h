#pragma once

#include "platform/domain/Ids.h"

#include <utility>

namespace wm {

// A last-writer-wins register: the value carried by the highest HLC stamp wins. A merge answers whether it took.
template <typename T>
struct Lww {
  T value{};
  Hlc stamp{};

  bool merge(T incoming, const Hlc& at) {
    if (!(at > stamp)) return false;
    value = std::move(incoming);
    stamp = at;
    return true;
  }

  bool operator==(const Lww&) const = default;
};

// A single element of an add-biased LWW-element-set: present iff it was added and no
// strictly-later remove has cancelled it (a tie between add and remove favours add). An add or a remove answers
// whether it took.
struct ElementSet {
  Hlc addedAt{};
  Hlc removedAt{};

  bool add(const Hlc& at) {
    if (!(at > addedAt)) return false;
    addedAt = at;
    return true;
  }
  bool remove(const Hlc& at) {
    if (!(at > removedAt)) return false;
    removedAt = at;
    return true;
  }
  bool present() const { return addedAt.isSet() && !(removedAt > addedAt); }
};

}
