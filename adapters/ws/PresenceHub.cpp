#include "adapters/ws/PresenceHub.h"

#include "adapters/json/TreeJson.h"

#include <utility>
#include <vector>

namespace wm {

namespace {
// One stable colour per actor so a peer's cursor keeps its hue for the session. Real
// display names/colours arrive with accounts (Phase 1); until then we number the guests.
const std::vector<std::string> kPalette = {
    "#e8743b", "#19a979", "#945ecf", "#13a4b4",
    "#e6c229", "#c43d5c", "#6f9654", "#5b6ee1"};

std::uint64_t seatOf(const UserId& actor) {
  std::uint64_t seat = 0;
  for (char c : actor.str())
    if (c >= '0' && c <= '9') seat = seat * 10 + static_cast<std::uint64_t>(c - '0');
  return seat;
}

std::string nameOf(const UserId& actor) {
  std::uint64_t seat = seatOf(actor);
  return seat ? "Guest " + std::to_string(seat) : "Guest";
}

std::string colorOf(const UserId& actor) {
  return kPalette[seatOf(actor) % kPalette.size()];
}

void sendTo(const drogon::WebSocketConnectionPtr& conn, const Json::Value& frame) {
  if (conn->connected()) conn->send(dump(frame));
}
}

void PresenceHub::join(const drogon::WebSocketConnectionPtr& conn, const TreeId& tree) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto& members = byTree_[tree.str()];

  UserId actor = conn->getContextRef<UserId>();
  Member self{actor, nameOf(actor), colorOf(actor), std::nullopt, std::nullopt, false};

  // Tell the newcomer who is already here (roster + any live cursor), and tell everyone
  // else the newcomer arrived. Presence frames then keep every cursor current.
  for (const auto& [other, member] : members) {
    sendTo(conn, peerFrame(tree.str(), member, "join"));
    if (member.cursor || member.selection) sendTo(conn, presenceFrame(tree.str(), member));
    sendTo(other, peerFrame(tree.str(), self, "join"));
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
    Json::Value gone = peerFrame(tree, it->second, "leave");
    members.erase(it);
    for (const auto& [other, _] : members) sendTo(other, gone);
  }
}

void PresenceHub::flush() {
  std::vector<std::pair<drogon::WebSocketConnectionPtr, Json::Value>> outbox;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [tree, members] : byTree_) {
      for (auto& [conn, member] : members) {
        if (!member.moved) continue;
        member.moved = false;
        Json::Value frame = presenceFrame(tree, member);
        for (const auto& [other, _] : members)
          if (other != conn) outbox.emplace_back(other, frame);
      }
    }
  }
  for (const auto& [conn, frame] : outbox) sendTo(conn, frame);
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
