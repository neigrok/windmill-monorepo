#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// A tree's read authorization — the single stored visibility axis. Enforcement is binary: a
// private tree is owner-only, while unlisted and public are both readable by anyone holding
// the id. The third value is not a third permission but a second, narrower CONSENT layered on
// the same read: `unlisted` means "reachable by link", `public_` means "and list me" — it is
// what puts a tree on the gallery wall (domain/Gallery.h) and lets its share page be indexed.
// So the two read alike and are chosen differently, deliberately.
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

// The one write-authorization decision every write path calls — and the whole of it: a tree is
// its owner's to change and nobody else's. AN UNOWNED TREE IS NOBODY'S TO WRITE, which is what
// closes the seeded demo tree (owner NULL, public): it can be read by the world and edited by
// no one, so no account can take it and turn it private. Visibility is deliberately absent from
// this signature, not ignored in the body: it widens READS only, and a parameter nothing reads
// would invite the next reader to think a shared tree is a writable one. Pure, like its twin.
inline bool canWrite(const std::optional<UserId>& caller, const std::optional<UserId>& owner) {
  return caller && owner && *caller == *owner;
}

}
