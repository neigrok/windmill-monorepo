#pragma once

#include "platform/adapters/json/JsonText.h"
#include "platform/subscriptions/Feed.h"

#include <fstream>
#include <functional>
#include <initializer_list>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm::subscriptions::test {

// An example of a golden fixture in packages/api-contract/subscriptions: its name, its body and, for a feed page,
// the request it answers.
inline Json::Value contractExample(const std::string& file, const std::string& name) {
  std::ifstream in(std::string(WM_SUBSCRIPTIONS_CONTRACT_DIR) + "/" + file);
  std::stringstream text;
  text << in.rdbuf();
  const std::optional<Json::Value> examples = parseWhole(text.str());
  if (!examples) throw std::runtime_error(file + " is not JSON");
  for (const Json::Value& example : (*examples)["examples"])
    if (example["name"].asString() == name) return example;
  throw std::runtime_error(file + " holds no example " + name);
}

inline Json::Value entitlementExample(const std::string& name) {
  return contractExample("entitlement.json", name)["body"];
}

// The feed's pages of one ledger, keyed by the cursor each is read after, as the service serves them. A read with no
// page there is a service that cannot be reached. Every read is recorded, and `onRead` sees it before it is answered.
class FakeFeed : public SubscriptionFeed {
public:
  // The recorded pages, each served after the cursor its request names.
  void serve(std::initializer_list<const char*> names) {
    for (const char* name : names) {
      const Json::Value example = contractExample("feed.json", name);
      serve(example["request"]["after"].asUInt64(), example["body"]);
    }
  }

  void serve(Seq after, const Json::Value& body) {
    std::lock_guard lock{mutex_};
    pages_.insert_or_assign(after, body);
  }

  void stopServing(Seq after) {
    std::lock_guard lock{mutex_};
    pages_.erase(after);
  }

  std::vector<std::pair<Seq, int>> reads() {
    std::lock_guard lock{mutex_};
    return reads_;
  }

  FeedPage page(Seq after, int limit) override {
    if (onRead) onRead(after);
    std::lock_guard lock{mutex_};
    reads_.emplace_back(after, limit);
    const auto found = pages_.find(after);
    if (found == pages_.end()) throw FeedUnavailable("network");
    return FeedPage{found->second};
  }

  std::function<void(Seq)> onRead;

private:
  std::mutex mutex_;
  std::map<Seq, Json::Value> pages_;
  std::vector<std::pair<Seq, int>> reads_;
};

// A recorded page as it reads from the ledger a backup restored: the same events under the restored ledger's epoch,
// up to the newest seq the backup holds.
inline Json::Value restored(const char* name, Seq latestSeq) {
  Json::Value body = contractExample("feed.json", name)["body"];
  body["epoch"] = contractExample("feed.json", "ledger_restored")["body"]["epoch"];
  body["latestSeq"] = Json::UInt64(latestSeq);
  return body;
}

}
