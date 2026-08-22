#include "platform/application/MailSweep.h"

#include "platform/application/RetentionSweep.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

// The skeleton, proved once over a product small enough to fit in this file. Every real sweep
// derives from the same base, so what is pinned here — the lock, the rehearsal, the lost claim,
// the arming gate, the pause credential's ordering, the per-user guard — is pinned for all of them,
// and each product's own test is free to be about the product.

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;

struct FakeMutex : SweepMutex {
  bool lockFree = true;
  int locksTaken = 0;
  int locksReleased = 0;

  // RAII, like the Postgres one: the port promises the lock is handed back BEFORE a throwing pass
  // reaches its caller, and a fake that counted the release after pass() could not tell whether the
  // real one keeps that promise.
  struct Handback {
    ~Handback() { ++released; }
    int& released;
  };

  bool underSweepLock(const std::function<void()>& pass) override {
    if (!lockFree) return false;
    ++locksTaken;
    Handback handback{locksReleased};
    pass();
    return true;
  }
};

struct Slot {
  UserId user;
  std::string key;
};

// A decision small enough to read at a glance: what to do, and whether the load blew up first.
struct Call {
  bool send = false;
  bool unreadable = false;
};

struct Closed {
  std::string key;
  ClosedAs as;
};

// The pretend product: its ledger and its mailer in one place, with every knob a case below turns
// exposed as a plain field.
class TinySweep : public MailSweep<Slot, Call> {
public:
  TinySweep(FakeMutex& mutex, TokenGenerator& tokens, MailArming arming)
      : MailSweep(mutex, tokens, std::move(arming)) {}

  int askedLimit = 0;
  std::vector<Slot> due;
  std::set<std::string> sendable;         // users whose decision is a send
  std::set<std::string> unreadable;       // users whose decideFor answers "could not load"
  std::set<std::string> throwing;         // users whose decideFor throws outright
  bool dueNowThrows = false;              // the batch itself cannot be read
  std::set<std::string> ownedElsewhere;   // users whose claim loses the race
  std::set<std::string> refused;          // users whose mailer says no
  std::vector<std::string> claims;
  std::vector<Closed> closes;
  std::vector<std::pair<std::string, std::string>> mailed;   // (user, pause secret)
  std::map<std::string, std::string> pauseDigests;

private:
  std::string name() const override { return "tiny"; }
  int batch() const override { return 7; }
  std::vector<Slot> dueNow(std::uint64_t, int limit) override {
    askedLimit = limit;
    if (dueNowThrows) throw std::runtime_error("the due query is on fire");
    return due;
  }
  Call decideFor(const Slot& slot, std::uint64_t) override {
    if (throwing.count(slot.user.str())) throw std::runtime_error("the facts are on fire");
    if (unreadable.count(slot.user.str())) return Call{false, true};
    return Call{sendable.count(slot.user.str()) > 0, false};
  }
  SweepVerdict verdictOf(const Call& call) const override {
    if (call.unreadable) return SweepVerdict::unreadable;
    return call.send ? SweepVerdict::send : SweepVerdict::skip;
  }
  bool claim(const Slot& slot, const Call&) override {
    claims.push_back(slot.key);
    return ownedElsewhere.count(slot.user.str()) == 0;
  }
  void close(const Slot& slot, ClosedAs as) override { closes.push_back(Closed{slot.key, as}); }
  void send(const Slot& slot, const Call&, const std::string& pauseSecret,
            std::function<void(bool)> done) override {
    if (refused.count(slot.user.str())) {
      done(false);
      return;
    }
    mailed.emplace_back(slot.user.str(), pauseSecret);
    done(true);
  }
  void storePause(const UserId& user, const std::string& digest) override {
    pauseDigests[user.str()] = digest;
  }
};

Slot slot(const char* user) { return Slot{UserId{std::string(user)}, std::string(user) + "@slot"}; }

}

TEST(a_sweep_that_cannot_take_the_fleet_lock_runs_nothing) {
  FakeMutex mutex;
  mutex.lockFree = false;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.due = {slot("u1")};
  sweep.sendable = {"u1"};

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_FALSE(report.ran);
  CHECK_EQ(report.due, 0);
  CHECK_EQ(sweep.askedLimit, 0);   // dueNow was never asked
  CHECK_EQ(mutex.locksTaken, 0);
  CHECK_EQ(mutex.locksReleased, 0);
  CHECK_EQ(sweep.claims.size(), std::size_t{0});
  CHECK_EQ(sweep.mailed.size(), std::size_t{0});
}

TEST(a_delivered_send_stores_the_pause_and_closes_delivered_in_that_order) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.due = {slot("u1")};
  sweep.sendable = {"u1"};

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK(report.ran);
  CHECK_EQ(report.due, 1);
  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.sent, 1);
  CHECK_EQ(report.failed, 0);
  CHECK_EQ(report.held, 0);
  CHECK_EQ(report.wouldSend, 0);
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(report.errors, 0);
  CHECK_EQ(sweep.askedLimit, 7);   // the product's batch, asked of the product's dueNow
  CHECK_EQ(mutex.locksTaken, 1);
  CHECK_EQ(mutex.locksReleased, 1);

  // DECIDE → CLAIM → SEND, and the mail carries the fresh secret whose digest is then stored.
  REQUIRE_EQ(sweep.claims.size(), std::size_t{1});
  CHECK_EQ(sweep.claims[0], std::string("u1@slot"));
  REQUIRE_EQ(sweep.mailed.size(), std::size_t{1});
  CHECK_EQ(sweep.mailed[0].first, std::string("u1"));
  CHECK_EQ(sweep.mailed[0].second, std::string("s1"));
  CHECK_EQ(sweep.pauseDigests["u1"], std::string("d1"));
  REQUIRE_EQ(sweep.closes.size(), std::size_t{1});
  CHECK_EQ(sweep.closes[0].key, std::string("u1@slot"));
  CHECK(sweep.closes[0].as == ClosedAs::delivered);
}

TEST(a_rehearsal_decides_everything_and_commits_nothing) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.due = {slot("u1"), slot("u2")};
  sweep.sendable = {"u1"};

  const MailSweepReport report = sweep.run(kNow, true);

  CHECK(report.ran);
  CHECK_EQ(report.due, 2);
  CHECK_EQ(report.wouldSend, 1);   // the number the rehearsal exists to report
  CHECK_EQ(report.skipped, 1);
  CHECK_EQ(report.claimed, 0);
  CHECK_EQ(report.sent, 0);
  CHECK_EQ(report.held, 0);        // nothing was withheld: nothing was ever going to be sent
  CHECK_EQ(sweep.claims.size(), std::size_t{0});
  CHECK_EQ(sweep.mailed.size(), std::size_t{0});
  CHECK_EQ(sweep.closes.size(), std::size_t{0});
  CHECK_EQ(sweep.pauseDigests.size(), std::size_t{0});
  CHECK_EQ(tokens.counter, 0);     // not even a credential was minted
}

TEST(a_slot_another_sweep_already_owns_is_dropped_in_silence) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.due = {slot("u1")};
  sweep.sendable = {"u1"};
  sweep.ownedElsewhere = {"u1"};

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.due, 1);
  CHECK_EQ(report.claimed, 0);
  CHECK_EQ(report.sent, 0);
  // A lost race is not a skip: that slot belongs to the sweep that won it, and counting it here
  // would report a decision this run never wrote to the ledger.
  CHECK_EQ(report.skipped, 0);
  CHECK_EQ(sweep.claims.size(), std::size_t{1});   // it tried, and lost
  CHECK_EQ(sweep.mailed.size(), std::size_t{0});
  CHECK_EQ(sweep.closes.size(), std::size_t{0});
}

TEST(a_skip_still_claims_its_slot_and_closes_nothing) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.due = {slot("u1")};

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.skipped, 1);
  CHECK_EQ(report.sent, 0);
  CHECK_EQ(sweep.claims.size(), std::size_t{1});
  CHECK_EQ(sweep.mailed.size(), std::size_t{0});
  CHECK_EQ(sweep.closes.size(), std::size_t{0});
}

TEST(a_dark_gate_claims_the_send_closes_it_held_and_mails_nobody) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(false, "u1"));
  sweep.due = {slot("u1")};
  sweep.sendable = {"u1"};

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_FALSE(sweep.arming().enabled);
  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.held, 1);
  CHECK_EQ(report.sent, 0);
  // The ledger says what we decided, not what the flag allowed, and the slot is CLOSED as held so
  // the row can never be read as a crash between the claim and the send.
  REQUIRE_EQ(sweep.closes.size(), std::size_t{1});
  CHECK(sweep.closes[0].as == ClosedAs::held);
  CHECK_EQ(sweep.mailed.size(), std::size_t{0});
  // Nothing left, so no credential was minted and the last pause link is untouched.
  CHECK_EQ(tokens.counter, 0);
  CHECK_EQ(sweep.pauseDigests.size(), std::size_t{0});
}

TEST(an_armed_gate_still_mails_only_the_allowlist) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.due = {slot("u1"), slot("u2")};
  sweep.sendable = {"u1", "u2"};

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.due, 2);
  CHECK_EQ(report.claimed, 2);
  CHECK_EQ(report.sent, 1);
  CHECK_EQ(report.held, 1);
  REQUIRE_EQ(sweep.mailed.size(), std::size_t{1});
  CHECK_EQ(sweep.mailed[0].first, std::string("u1"));
}

TEST(a_refused_send_closes_refused_and_leaves_the_old_pause_link_alive) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.due = {slot("u1")};
  sweep.sendable = {"u1"};
  sweep.refused = {"u1"};
  sweep.pauseDigests["u1"] = "last-times-digest";

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.claimed, 1);
  CHECK_EQ(report.failed, 1);
  CHECK_EQ(report.sent, 0);
  CHECK_EQ(sweep.mailed.size(), std::size_t{0});
  REQUIRE_EQ(sweep.closes.size(), std::size_t{1});
  CHECK(sweep.closes[0].as == ClosedAs::refused);
  // The credential rotates only on a mail that actually left. Rotating first would kill a pause
  // link still sitting in someone's inbox on behalf of a replacement that never arrived.
  CHECK_EQ(sweep.pauseDigests["u1"], std::string("last-times-digest"));
}

TEST(a_turn_that_throws_is_counted_and_the_next_user_still_runs) {
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u0,u1"));
  sweep.due = {slot("u0"), slot("u1")};
  sweep.sendable = {"u0", "u1"};
  sweep.throwing = {"u0"};

  const MailSweepReport report = sweep.run(kNow, false);

  CHECK_EQ(report.due, 2);
  CHECK_EQ(report.errors, 1);
  CHECK_EQ(report.claimed, 1);   // the throw came before u0's claim, so only u1's slot is claimed
  CHECK_EQ(report.sent, 1);
  REQUIRE_EQ(sweep.claims.size(), std::size_t{1});
  CHECK_EQ(sweep.claims[0], std::string("u1@slot"));
  REQUIRE_EQ(sweep.mailed.size(), std::size_t{1});
  CHECK_EQ(sweep.mailed[0].first, std::string("u1"));
  CHECK_EQ(mutex.locksReleased, 1);   // and the fleet lock is still handed back
}

TEST(an_unreadable_decision_is_claimed_like_a_skip_and_counted_as_an_error) {
  // A product whose ledger must own the slot anyway — roadmap, whose pointer only advances inside
  // a claim — answers an `unreadable` verdict instead of throwing: it is claimed, it is skipped,
  // and it is an error, all three.
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u0,u1"));
  sweep.due = {slot("u0"), slot("u1")};
  sweep.sendable = {"u1"};
  sweep.unreadable = {"u0"};

  const MailSweepReport wet = sweep.run(kNow, false);

  CHECK_EQ(wet.due, 2);
  CHECK_EQ(wet.errors, 1);
  CHECK_EQ(wet.claimed, 2);
  CHECK_EQ(wet.skipped, 1);
  CHECK_EQ(wet.sent, 1);
  REQUIRE_EQ(sweep.claims.size(), std::size_t{2});
  CHECK_EQ(sweep.claims[0], std::string("u0@slot"));
  CHECK_EQ(sweep.claims[1], std::string("u1@slot"));

  // And in a rehearsal it is still an error and still a skip, with nothing committed.
  sweep.claims.clear();
  const MailSweepReport dry = sweep.run(kNow, true);

  CHECK_EQ(dry.errors, 1);
  CHECK_EQ(dry.skipped, 1);
  CHECK_EQ(dry.wouldSend, 1);
  CHECK_EQ(dry.claimed, 0);
  CHECK_EQ(sweep.claims.size(), std::size_t{0});
}

TEST(a_pass_that_throws_hands_the_fleet_lock_back_before_the_caller_sees_the_throw) {
  // The per-user guard covers a turn that blows up; nothing covers the batch read itself. A throw
  // there escapes `run`, and if it took the fleet lock with it, every process on this database
  // would stop mailing until a restart — which is precisely the outage SWEEP-1 was.
  FakeMutex mutex;
  FakeTokens tokens;
  TinySweep sweep(mutex, tokens, MailArming(true, "u1"));
  sweep.dueNowThrows = true;

  bool threw = false;
  try {
    sweep.run(kNow, false);
  } catch (const std::runtime_error&) {
    threw = true;
  }

  CHECK(threw);
  CHECK_EQ(mutex.locksTaken, 1);
  CHECK_EQ(mutex.locksReleased, 1);
}

// The other sweep on this seam, and the only one that deletes rather than sends. It lives here
// beside MailSweep because what is asserted is the same skeleton — the fleet lock, and a pass that
// reports what it did — and because the windows themselves are the operator's to choose, not ours
// to test. What must hold: a pass that could not take the lock removed nothing and says so, and a
// window an operator zeroed is a table the sweep does not touch at all.
namespace {
struct FakeRetentionStore : RetentionStore {
  RetentionWindows sawWindows;
  UnixMs sawNow = 0;
  int passes = 0;
  RetentionReport answer;

  RetentionReport purge(const RetentionWindows& windows, UnixMs now) override {
    ++passes;
    sawWindows = windows;
    sawNow = now;
    return answer;
  }
};
}

TEST(retention_sweep_runs_one_pass_under_the_fleet_lock_and_reports_what_it_removed) {
  FakeRetentionStore store;
  FakeMutex mutex;
  FakeClock clock;
  RetentionWindows windows;
  windows.eventDays = 30;
  windows.feedbackDays = 0;  // an operator saying "keep it all"
  store.answer = RetentionReport{true, 7, 0, 3, 2, 5, 1};
  RetentionSweep sweep{store, mutex, clock, windows};

  const RetentionReport report = sweep.run();

  CHECK(report.ran);
  CHECK_EQ(store.passes, 1);
  CHECK_EQ(mutex.locksTaken, 1);
  CHECK_EQ(mutex.locksReleased, 1);
  CHECK_EQ(store.sawNow, clock.now);
  CHECK_EQ(store.sawWindows.eventDays, 30);
  CHECK_EQ(store.sawWindows.feedbackDays, 0);
  CHECK_EQ(report.events, 7);
  CHECK_EQ(report.feedback, 0);
  CHECK_EQ(report.serverErrors, 3);
  CHECK_EQ(report.oauthCodes, 2);
  CHECK_EQ(report.oauthTokens, 5);
  CHECK_EQ(report.oauthClients, 1);
  CHECK_EQ(report.rows(), 18);
}

TEST(retention_sweep_deletes_nothing_when_another_process_holds_the_lock) {
  FakeRetentionStore store;
  FakeMutex mutex;
  mutex.lockFree = false;
  FakeClock clock;
  RetentionSweep sweep{store, mutex, clock, RetentionWindows{}};

  const RetentionReport report = sweep.run();

  // ran=false is "nothing was looked at", which is not the same as "nothing was due" — and no
  // DELETE was reached at all.
  CHECK_FALSE(report.ran);
  CHECK_EQ(report.rows(), 0);
  CHECK_EQ(store.passes, 0);
}
