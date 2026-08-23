#include "platform/domain/Access.h"

#include "test/testing.h"

#include <optional>

using namespace wm;

namespace {
std::optional<UserId> some(const char* id) { return std::optional<UserId>(UserId{id}); }
const std::optional<UserId> none;
}

TEST(parse_visibility_maps_the_three_known_values) {
  CHECK(parseVisibility("private") == Visibility::private_);
  CHECK(parseVisibility("unlisted") == Visibility::unlisted);
  CHECK(parseVisibility("public") == Visibility::public_);
}

TEST(parse_visibility_fails_closed_on_anything_unknown) {
  CHECK(parseVisibility("") == Visibility::private_);
  CHECK(parseVisibility("Public") == Visibility::private_);   // case-sensitive
  CHECK(parseVisibility("world") == Visibility::private_);
  CHECK(parseVisibility("PRIVATE") == Visibility::private_);
}

TEST(to_string_round_trips_every_value) {
  CHECK_EQ(toString(Visibility::private_), std::string("private"));
  CHECK_EQ(toString(Visibility::unlisted), std::string("unlisted"));
  CHECK_EQ(toString(Visibility::public_), std::string("public"));
  CHECK(parseVisibility(toString(Visibility::private_)) == Visibility::private_);
  CHECK(parseVisibility(toString(Visibility::unlisted)) == Visibility::unlisted);
  CHECK(parseVisibility(toString(Visibility::public_)) == Visibility::public_);
}

TEST(can_read_a_private_tree_only_when_caller_is_the_owner) {
  CHECK(canRead(some("u1"), some("u1"), Visibility::private_));         // owner reads its own
  CHECK_FALSE(canRead(some("u2"), some("u1"), Visibility::private_));   // a stranger cannot
  CHECK_FALSE(canRead(none, some("u1"), Visibility::private_));         // anonymous cannot
  CHECK_FALSE(canRead(some("u1"), none, Visibility::private_));         // an unowned private tree is nobody's
  CHECK_FALSE(canRead(none, none, Visibility::private_));               // neither known
}

TEST(can_read_an_unlisted_tree_for_anyone_holding_the_id) {
  CHECK(canRead(some("u1"), some("u1"), Visibility::unlisted));  // owner
  CHECK(canRead(some("u2"), some("u1"), Visibility::unlisted));  // a stranger
  CHECK(canRead(none, some("u1"), Visibility::unlisted));        // anonymous
  CHECK(canRead(none, none, Visibility::unlisted));              // unowned, still readable by id
}

TEST(can_read_a_public_tree_for_anyone_holding_the_id) {
  CHECK(canRead(some("u1"), some("u1"), Visibility::public_));
  CHECK(canRead(some("u2"), some("u1"), Visibility::public_));
  CHECK(canRead(none, some("u1"), Visibility::public_));
  CHECK(canRead(none, none, Visibility::public_));
}

TEST(can_write_only_when_caller_is_the_owner) {
  CHECK(canWrite(some("u1"), some("u1")));         // the owner, and only the owner
  CHECK_FALSE(canWrite(some("u2"), some("u1")));   // a stranger cannot
  CHECK_FALSE(canWrite(none, some("u1")));         // anonymous cannot
  CHECK_FALSE(canWrite(none, none));               // neither known
}

// The seeded demo tree is owner-NULL and public: readable by the world, writable by nobody.
TEST(can_write_is_false_for_an_unowned_tree_at_every_visibility) {
  for (Visibility visibility : {Visibility::private_, Visibility::unlisted, Visibility::public_}) {
    CHECK(canRead(some("u1"), none, visibility) == (visibility != Visibility::private_));
    CHECK_FALSE(canWrite(some("u1"), none));
    CHECK_FALSE(canWrite(none, none));
  }
}

// canWrite is strictly narrower than canRead: everything writable is readable, and the two agree only on a private tree's owner.
TEST(everything_writable_is_readable) {
  const std::optional<UserId> callers[] = {none, some("u1"), some("u2")};
  const std::optional<UserId> owners[] = {none, some("u1")};
  for (const std::optional<UserId>& caller : callers)
    for (const std::optional<UserId>& owner : owners)
      for (Visibility visibility : {Visibility::private_, Visibility::unlisted, Visibility::public_})
        if (canWrite(caller, owner)) CHECK(canRead(caller, owner, visibility));
}

// A refused write states one of two truths: an unowned resource is nobody's, never "another account's".
TEST(write_refusal_is_none_for_the_owner_and_names_the_right_truth_otherwise) {
  CHECK_FALSE(writeRefusalFor(some("u1"), some("u1")).has_value());
  CHECK(writeRefusalFor(some("u2"), some("u1")) == WriteRefusal::notYours);
  CHECK(writeRefusalFor(none, some("u1")) == WriteRefusal::notYours);
  CHECK(writeRefusalFor(some("u1"), none) == WriteRefusal::nobodysTree);
  CHECK(writeRefusalFor(none, none) == WriteRefusal::nobodysTree);
}

TEST(write_refusal_codes_and_sentences_are_stable_and_distinct) {
  CHECK_EQ(std::string(codeOf(WriteRefusal::notYours)), std::string("not-yours"));
  CHECK_EQ(std::string(codeOf(WriteRefusal::nobodysTree)), std::string("nobodys-tree"));
  CHECK_EQ(std::string(truthOf(WriteRefusal::notYours)), std::string("this tree belongs to another account"));
  CHECK_EQ(std::string(truthOf(WriteRefusal::nobodysTree)),
           std::string("no account owns this tree, so it cannot be edited"));
  CHECK_EQ(sentenceOf(WriteRefusal::notYours), std::string("this tree belongs to another account"));
  CHECK_EQ(sentenceOf(WriteRefusal::nobodysTree),
           std::string("no account owns this tree, so it cannot be edited — you can still read it, or "
                       "fork it into a roadmap of your own"));
}
