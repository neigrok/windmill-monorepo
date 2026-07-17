#pragma once

#include "domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// A tree's read authorization — the single stored visibility axis. Enforcement is binary: a
// private tree is owner-only, while unlisted and public are both readable by anyone holding
// the id. `public_` reserves a future crawl/gallery intent (no listing endpoint exists yet),
// so today it enforces exactly as `unlisted`.
enum class Visibility { private_, unlisted, public_ };

// Parse the stored column text, fail-closed: an unknown or malformed value reads as private,
// so a storage typo can only ever narrow access, never widen it.
inline Visibility parseVisibility(const std::string& text) {
  if (text == "unlisted") return Visibility::unlisted;
  if (text == "public") return Visibility::public_;
  return Visibility::private_;
}

inline std::string toString(Visibility visibility) {
  if (visibility == Visibility::unlisted) return "unlisted";
  if (visibility == Visibility::public_) return "public";
  return "private";
}

// The one read-authorization decision every read path calls. A private tree is legible only
// to its owner — caller and owner both known and equal; an unlisted or public tree is legible
// to anyone holding the id. Pure: no I/O, no room, just the three facts.
inline bool canRead(const std::optional<UserId>& caller, const std::optional<UserId>& owner,
                    Visibility visibility) {
  if (visibility != Visibility::private_) return true;
  return caller && owner && *caller == *owner;
}

}
