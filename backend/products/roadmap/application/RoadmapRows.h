#pragma once

#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/Ids.h"
#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Scope.h"
#include "platform/ports/SyncStore.h"
#include "products/roadmap/application/TreeRoom.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Tree.h"
#include "products/roadmap/domain/read/RoadmapTree.h"

#include <json/json.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

// Roadmap's records as the engine holds them (Roadmap on the sync engine §4), read as roadmap's models: the read
// domain's records every read takes, and the room the server's writes plan in, whose writes come back as the deltas a
// server-origin intent carries (engine.md §6.3). Reading is the caller's transaction's; nothing here admits.

namespace wm::roadmap {

// A person's roadmaps as their `self/roadmap` holds them: each `tree` record by id.
struct AccountRows {
  UserId owner;
  std::map<std::string, sync::Row> trees;

  const sync::Row* tree(const std::string& id) const;
  bool isAlive(const std::string& id) const;
  // Where a roadmap sits, or none for a root.
  std::optional<read::Parent> placeOf(const std::string& id) const;
  // The owning steps from the root down to `id`, empty for a root.
  std::vector<OwningStep> pathOf(const std::string& id) const;
  std::string rootOf(const std::string& id) const;
};

// One roadmap's tree scope, its owner's pointers, and one reader's marks.
struct TreeRows {
  std::string tree;
  std::optional<sync::ScopeRow> scope;
  std::optional<sync::Row> meta;
  std::vector<sync::Row> nodes;
  std::vector<sync::Row> edges;
  std::vector<sync::Row> kinds;
  std::vector<sync::Row> pointers;
  std::vector<sync::Row> marks;

  bool exists() const { return scope && !scope->dead; }
  const UserId& owner() const { return scope->owner; }
  Seq seq() const { return scope ? scope->seq : 0; }
  std::string metaText(const char* field) const;
  // §4: who may read; a root's reach is its visibility, a subtree's is private while it does not stand.
  Visibility reach() const;
  const sync::Row* node(const std::string& id) const;
};

// Reads in the caller's transaction, through the catalog's stores.
class RoadmapRows {
public:
  RoadmapRows(const sync::SyncCatalog& catalog, sync::SyncStore& store) : catalog_(catalog), store_(store) {}

  AccountRows account(sync::SyncTxn&, const UserId& owner) const;
  // A tree scope with its owner's pointers, and `reader`'s marks when one is named.
  TreeRows tree(sync::SyncTxn&, const std::string& tree, const std::optional<UserId>& reader) const;
  std::optional<sync::ScopeRow> scope(sync::SyncTxn&, const sync::ScopeKey&) const;

private:
  std::vector<sync::Row> rows(sync::SyncTxn&, const sync::ScopeKey&, const std::string& type) const;

  const sync::SyncCatalog& catalog_;
  sync::SyncStore& store_;
};

// The read domain's records of one roadmap, its place and presence as `account` holds them.
read::TreeRecords recordsOf(const TreeRows& rows, const AccountRows& account);
// A step's or a kind's present state as a reply reads it.
TreeData documentOf(const TreeRows& rows, const std::string& title);
Progress progressOf(const TreeRows& rows);

// The room a server write plans in: the tree's registers, graph and legend at their engine stamps, each step's pointer
// read from the owner's overlay, at the scope's seq. It is built inside a builder, under the scope lock.
std::unique_ptr<TreeRoom> roomOf(const TreeRows& rows, const AccountRows& account, PresenceBus& bus);

// What a room's writes come to: the deltas of the tree scope and those of the owner's overlay (pointers), each an
// intent's `d`, empty when nothing changed there. A created step or kind takes an order key after every one the
// roadmap holds; one that exists carries its born, so a revival revives.
struct RoomWrites {
  Json::Value tree{Json::arrayValue};
  Json::Value pointers{Json::arrayValue};
};
RoomWrites writesOf(const TreeRows& before, const TreeRoom& room);

// A delta of a server-origin intent, its stamps left for admission to mint: the fields it writes, its life when it
// says one, and, for a minted or derived type, the born of the record it names (none: a record it creates).
struct Written {
  std::string type;
  Json::Value id;
  Json::Value fields{Json::objectValue};
  std::optional<sync::LifeState> life;
  std::optional<sync::Stamp> born;
  bool derived = false;

  Json::Value json() const;
};
Json::Value intentIn(const std::string& scope, Json::Value deltas);

}
