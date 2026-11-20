#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// Read authorization is binary: private is owner-only, unlisted and public are both readable by
// anyone holding the id. `public_` adds listing consent and lets the tree's share page be indexed.
enum class Visibility { private_, unlisted, public_ };

// Fail-closed: an unknown or malformed value reads as private.
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

// The account that owns every roadmap that had no owner before roadmap's move onto the sync engine, the public demo among
// them (roadmap-on-the-engine.md §7). Its address takes no mail, so nobody signs in as it: nobody writes what it owns, and
// the gallery, which lists people's roadmaps, lists none of its.
inline const UserId kHouseAccount{std::string("00000000-0000-4000-8000-00000000d3e0")};
inline const std::string kHouseEmail = "house@windmill.invalid";

// The read-authorization decision every tree read path calls.
inline bool canRead(const std::optional<UserId>& caller, const std::optional<UserId>& owner,
                    Visibility visibility) {
  if (visibility != Visibility::private_) return true;
  return caller && owner && *caller == *owner;
}

// The write-authorization decision every tree document write calls. Visibility widens reads only and
// must stay out of this signature.
inline bool canWrite(const std::optional<UserId>& caller, const std::optional<UserId>& owner) {
  return caller && owner && *caller == *owner;
}

// The code is what a client branches on and never changes; the sentence is for a human.
enum class WriteRefusal { notYours, nobodysTree };

// Which refusal a (caller, owner) pair earns, or none when canWrite admits it.
inline std::optional<WriteRefusal> writeRefusalFor(const std::optional<UserId>& caller,
                                                   const std::optional<UserId>& owner) {
  if (canWrite(caller, owner)) return std::nullopt;
  if (!owner) return WriteRefusal::nobodysTree;
  return WriteRefusal::notYours;
}

inline const char* codeOf(WriteRefusal refusal) {
  if (refusal == WriteRefusal::nobodysTree) return "nobodys-tree";
  return "not-yours";
}

// The truth alone, for a surface that adds a remedy of its own; `sentenceOf` adds the generic one.
inline const char* truthOf(WriteRefusal refusal) {
  if (refusal == WriteRefusal::nobodysTree) return "no account owns this tree, so it cannot be edited";
  return "this tree belongs to another account";
}

inline std::string sentenceOf(WriteRefusal refusal) {
  if (refusal == WriteRefusal::nobodysTree)
    return std::string(truthOf(refusal)) + " — you can still read it, or fork it into a roadmap of your own";
  return truthOf(refusal);
}

}
