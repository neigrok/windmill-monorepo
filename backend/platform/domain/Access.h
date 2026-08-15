#pragma once

#include "platform/domain/Ids.h"

#include <optional>
#include <string>

namespace wm {

// A resource's read authorization — the single stored visibility axis. Enforcement is binary: a
// private resource is owner-only, while unlisted and public are both readable by anyone holding
// the id. The third value is not a third permission but a second, narrower CONSENT layered on
// the same read: `unlisted` means "reachable by link", `public_` means "and list me" — it is what
// admits a resource to whatever public listing its product keeps, and lets its share page be
// indexed. So the two read alike and are chosen differently, deliberately.
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

// The one read-authorization decision every read path calls. A private resource is legible only
// to its owner — caller and owner both known and equal; an unlisted or public one is legible to
// anyone holding the id. Pure: no I/O, no storage, just the three facts.
inline bool canRead(const std::optional<UserId>& caller, const std::optional<UserId>& owner,
                    Visibility visibility) {
  if (visibility != Visibility::private_) return true;
  return caller && owner && *caller == *owner;
}

// The one write-authorization decision every write path calls — and the whole of it: a resource is
// its owner's to change and nobody else's. AN UNOWNED RESOURCE IS NOBODY'S TO WRITE, which is what
// closes an ownerless public row (owner NULL): it can be read by the world and edited by no one,
// so no account can take it and turn it private. Visibility is deliberately absent from this
// signature, not ignored in the body: it widens READS only, and a parameter nothing reads would
// invite the next reader to think a shared resource is a writable one. Pure, like its twin.
inline bool canWrite(const std::optional<UserId>& caller, const std::optional<UserId>& owner) {
  return caller && owner && *caller == *owner;
}

// The two truths a refused write can state, kept apart because they are different. A resource
// SOMEONE ELSE owns has an owner to ask. A resource NOBODY owns — the seeded demo, a legacy row
// nothing mints any more — belongs to no account at all, so "belongs to another account" is simply
// false there, and sends the writer looking for a person who does not exist. Every surface that
// says no to a write says it from here: the code is what a client branches on and never changes;
// the sentence is for a human and is free to.
enum class WriteRefusal { notYours, nobodysTree };

// Which refusal a (caller, owner) pair earns, or none when canWrite admits it — the gate and the
// verdict decided together, so no surface can pick the sentence for the wrong case.
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

// The truth alone, for a surface that finishes the sentence with a remedy of its own (MCP names
// the tools that still work); `sentenceOf` adds the remedy every surface can offer an unowned
// tree — read it, or fork it — and is what a surface with nothing more to say sends.
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
