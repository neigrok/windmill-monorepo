#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// Read authorization is binary: private is owner-only, unlisted and public are both readable by
// anyone holding the id. `public_` adds only a listing consent — it admits the resource to its
// product's public listing and lets its share page be indexed.
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

// The one read-authorization decision every read path calls.
inline bool canRead(const std::optional<UserId>& caller, const std::optional<UserId>& owner,
                    Visibility visibility) {
  if (visibility != Visibility::private_) return true;
  return caller && owner && *caller == *owner;
}

// The one write-authorization decision every write path calls. Visibility widens reads only and
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
