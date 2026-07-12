#pragma once

#include "domain/Ids.h"

#include <utility>

namespace wm {

// A last-writer-wins register: the value carried by the highest HLC stamp wins.
template <typename T>
struct Lww {
  T value{};
  Hlc stamp{};

  void merge(T incoming, const Hlc& at) {
    if (at > stamp) {
      value = std::move(incoming);
      stamp = at;
    }
  }
};

// A single element of an add-biased LWW-element-set: present iff it was added and no
// strictly-later remove has cancelled it (a tie between add and remove favours add).
struct ElementSet {
  Hlc addedAt{};
  Hlc removedAt{};

  void add(const Hlc& at) { if (at > addedAt) addedAt = at; }
  void remove(const Hlc& at) { if (at > removedAt) removedAt = at; }
  bool present() const { return addedAt.isSet() && !(removedAt > addedAt); }
};

}
