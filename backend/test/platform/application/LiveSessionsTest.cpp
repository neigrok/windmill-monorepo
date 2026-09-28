#include "platform/application/LiveSessions.h"

#include "test/testing.h"

#include <set>
#include <string>
#include <vector>

// LiveSessions: a revoked session closes exactly the connections it opened, at once and once; the heartbeat
// re-proves only a connection due for it and closes the one whose session no longer proves.

using namespace wm;

TEST(live_sessions_close_every_connection_a_revoked_session_opened_once_and_no_other) {
  LiveSessions sessions;
  std::vector<std::string> closed;
  sessions.enter({"d-ann-phone"}, 1000, [&closed] { closed.push_back("ann phone"); });
  sessions.enter({"d-ann-laptop"}, 1000, [&closed] { closed.push_back("ann laptop"); });
  const LiveSessions::Handle both = sessions.enter({"d-bob", "d-ann-phone"}, 1000, [&closed] { closed.push_back("cookie and bearer"); });
  sessions.enter({"d-bob"}, 1000, [&closed] { closed.push_back("bob"); });

  sessions.revoked({"d-ann-phone"});
  CHECK_EQ(closed, (std::vector<std::string>{"ann phone", "cookie and bearer"}));

  sessions.revoked({"d-ann-phone"});
  sessions.leave(both);
  CHECK_EQ(closed, (std::vector<std::string>{"ann phone", "cookie and bearer"}));

  sessions.revoked({"d-ann-laptop", "d-bob"});
  CHECK_EQ(closed, (std::vector<std::string>{"ann phone", "cookie and bearer", "ann laptop", "bob"}));
}

TEST(live_sessions_reprove_only_a_connection_due_and_close_the_one_whose_session_fails) {
  LiveSessions sessions;
  std::vector<std::string> closed;
  sessions.enter({"d-old"}, 1000, [&closed] { closed.push_back("old"); });
  sessions.enter({"d-gone"}, 1000, [&closed] { closed.push_back("gone"); });
  sessions.enter({"d-new"}, 1000 + LiveSessions::kReproveAfterMs, [&closed] { closed.push_back("new"); });
  const std::set<std::string> resolving{"d-old", "d-new"};
  std::vector<std::string> asked;
  auto proves = [&](const std::string& digest) {
    asked.push_back(digest);
    return resolving.contains(digest);
  };

  sessions.reprove(proves, 1000 + LiveSessions::kReproveAfterMs);
  CHECK_EQ(asked, (std::vector<std::string>{"d-old", "d-gone"}));
  CHECK_EQ(closed, (std::vector<std::string>{"gone"}));

  asked.clear();
  sessions.reprove(proves, 1000 + 2 * LiveSessions::kReproveAfterMs - 1);
  CHECK(asked.empty());

  sessions.reprove(proves, 1000 + 2 * LiveSessions::kReproveAfterMs);
  CHECK_EQ(asked, (std::vector<std::string>{"d-old", "d-new"}));
  CHECK_EQ(closed, (std::vector<std::string>{"gone"}));
}
