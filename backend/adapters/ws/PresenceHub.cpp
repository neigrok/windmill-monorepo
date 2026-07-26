#include "adapters/ws/PresenceHub.h"

#include "adapters/json/TreeJson.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {
// One stable colour per actor, so a peer's cursor keeps its hue for the whole session. A visitor's
// name starts from the same hash but is not promised to be stable: it steps off a pairing the room
// already has, so the same person can return under a different name to a differently-filled tree.
const std::vector<std::string> kPalette = {
    "#e8743b", "#19a979", "#945ecf", "#13a4b4",
    "#e6c229", "#c43d5c", "#6f9654", "#5b6ee1"};

// A visitor is someone passing through the tree, so they get a traveller's name rather than a row
// number. 24 x 24 pairings: a crowded ring rarely doubles up, and a repeat costs nothing but a
// shared name — the colour and cursor still tell them apart.
const std::vector<std::string> kQualities = {
    "Amber", "Quiet", "Wandering", "Bright", "Distant", "Golden",
    "Restless", "Gentle", "Clever", "Wild", "Patient", "Silver",
    "Curious", "Steady", "Hidden", "Bold", "Kindly", "Nimble",
    "Solemn", "Sunlit", "Roaming", "Keen", "Humble", "Ardent"};

const std::vector<std::string> kCreatures = {
    "Heron", "Fox", "Willow", "Otter", "Sparrow", "Ember",
    "Cedar", "Falcon", "Badger", "Aspen", "Marten", "Thistle",
    "Raven", "Birch", "Hare", "Lantern", "Kestrel", "Bramble",
    "Vixen", "Alder", "Wren", "Juniper", "Stoat", "Rowan"};

// FNV-1a over the whole id, then a fmix64 finalizer. The previous splice read only the digits, so
// it collapsed every hyphenated uuid into one enormous overflowing seat number; FNV alone then
// barely moved its high bits across ids as close as u1 and u2, which handed a whole row of guests
// the same hue. The finalizer is what makes an arbitrary bit slice safe to index with.
std::uint64_t hashOf(const UserId& actor) {
  std::uint64_t hash = 1469598103934665603ull;
  for (unsigned char c : actor.str()) {
    hash ^= c;
    hash *= 1099511628211ull;
  }
  hash ^= hash >> 33;
  hash *= 0xff51afd7ed558ccdull;
  hash ^= hash >> 33;
  hash *= 0xc4ceb9fe1a85ec53ull;
  hash ^= hash >> 33;
  return hash;
}

std::string pairingName(std::size_t pairing) {
  return kQualities[pairing / kCreatures.size()] + " " + kCreatures[pairing % kCreatures.size()];
}

std::string colorOf(const UserId& actor) {
  return kPalette[(hashOf(actor) >> 16) % kPalette.size()];
}

void sendTo(const drogon::WebSocketConnectionPtr& conn, const std::string& payload) {
  if (conn->connected()) conn->send(payload);
}
}

// A stranger takes the first pairing the room is not already wearing, so a roster never shows two
// identical visitors. There are more pairings than the member cap, so the walk always lands on a
// free one — the trailing return is a guard, not a reachable outcome.
std::string PresenceHub::guestName(const UserId& actor, const std::map<drogon::WebSocketConnectionPtr, Member>& members) const {
  const std::size_t pairings = kQualities.size() * kCreatures.size();
  const std::size_t first = hashOf(actor) % pairings;
  for (std::size_t step = 0; step < pairings; ++step) {
    std::string candidate = pairingName((first + step) % pairings);
    const bool taken = std::any_of(members.begin(), members.end(),
                                   [&](const auto& entry) { return entry.second.name == candidate; });
    if (!taken) return candidate;
  }
  return pairingName(first);
}

void PresenceHub::join(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto& members = byTree_[tree.str()];

  // A resubscribe is how a client re-baselines after a gap, so the same connection arrives here
  // more than once. It is already in the room: announcing it again would burn a second name it
  // never keeps, and hand anyone flooding subscribes a whole roster's worth of fan-out per frame.
  if (members.count(conn)) return;

  // Past the cap a newcomer is neither tracked nor announced: it adds no fan-out and, in
  // trade, sees no peers. Bounds both membership and per-flush cost on a crowded tree.
  if (members.size() >= kMaxMembersPerTree) return;

  const Principal& principal = conn->getContextRef<Principal>();
  UserId actor = principal.user;
  // An account wears the name it chose even if a peer shares it — only a stranger we are naming
  // ourselves gets rotated off a collision.
  std::string name = principal.name.empty() ? guestName(actor, members) : principal.name;
  Member self{actor, std::move(name), colorOf(actor), std::nullopt, std::nullopt, false};

  // Tell the newcomer who is already here (roster + any live cursor), and tell everyone
  // else the newcomer arrived. The arrival frame is one broadcast, so serialize it once
  // and reuse the buffer; the roster frames are distinct and dumped in place.
  std::string arrival = dump(peerFrame(tree.str(), self, "join"));
  for (const auto& [other, member] : members) {
    sendTo(conn, dump(peerFrame(tree.str(), member, "join")));
    if (member.cursor || member.selection) sendTo(conn, dump(presenceFrame(tree.str(), member)));
    sendTo(other, arrival);
  }
  members.emplace(conn, std::move(self));
}

void PresenceHub::update(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree, const Json::Value& frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto tree_it = byTree_.find(tree.str());
  if (tree_it == byTree_.end()) return;
  auto member_it = tree_it->second.find(conn);
  if (member_it == tree_it->second.end()) return;  // presence requires an active subscription

  Member& member = member_it->second;
  if (frame.isMember("cursor") && frame["cursor"].isObject()) {
    member.cursor = Vec2{frame["cursor"].get("x", 0.0).asDouble(), frame["cursor"].get("y", 0.0).asDouble()};
  }
  if (frame.isMember("selection")) {
    std::string selection = frame["selection"].asString();
    member.selection = selection.empty() ? std::nullopt : std::optional<std::string>(selection);
  }
  member.moved = true;
}

void PresenceHub::leave(const drogon::WebSocketConnectionPtr& conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto& [tree, members] : byTree_) {
    auto it = members.find(conn);
    if (it == members.end()) continue;
    std::string gone = dump(peerFrame(tree, it->second, "leave"));
    members.erase(it);
    for (const auto& [other, _] : members) sendTo(other, gone);
  }
}

void PresenceHub::flush() {
  std::vector<std::pair<drogon::WebSocketConnectionPtr, std::shared_ptr<std::string>>> outbox;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [tree, members] : byTree_) {
      for (auto& [conn, member] : members) {
        if (!member.moved) continue;
        member.moved = false;
        // Serialize the moved actor's frame once, then hand the same buffer to every peer.
        auto frame = std::make_shared<std::string>(dump(presenceFrame(tree, member)));
        for (const auto& [other, _] : members)
          if (other != conn) outbox.emplace_back(other, frame);
      }
    }
  }
  for (const auto& [conn, frame] : outbox) sendTo(conn, *frame);
}

Json::Value PresenceHub::presenceFrame(const std::string& tree, const Member& member) const {
  Json::Value frame(Json::objectValue);
  frame["t"] = "presence";
  frame["treeId"] = tree;
  frame["actor"] = member.actor.str();
  Json::Value profile(Json::objectValue);
  profile["name"] = member.name;
  profile["color"] = member.color;
  frame["profile"] = profile;
  if (member.cursor) {
    Json::Value cursor(Json::objectValue);
    cursor["x"] = member.cursor->x;
    cursor["y"] = member.cursor->y;
    frame["cursor"] = cursor;
  }
  if (member.selection) frame["selection"] = *member.selection;
  return frame;
}

Json::Value PresenceHub::peerFrame(const std::string& tree, const Member& member, const char* event) const {
  Json::Value frame(Json::objectValue);
  frame["t"] = "peer";
  frame["treeId"] = tree;
  frame["event"] = event;
  frame["actor"] = member.actor.str();
  Json::Value profile(Json::objectValue);
  profile["name"] = member.name;
  profile["color"] = member.color;
  frame["profile"] = profile;
  return frame;
}

}
