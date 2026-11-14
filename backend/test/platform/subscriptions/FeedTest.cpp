#include "platform/subscriptions/Feed.h"

#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;

namespace {
FeedPage recorded(const char* name) { return FeedPage{contractExample("feed.json", name)["body"]}; }

std::string answerOf(const std::function<void()>& read) {
  try {
    read();
  } catch (const FeedUnavailable& unavailable) {
    return unavailable.answer;
  }
  return "read";
}
}

TEST(subscription_feed_pages_of_the_contract_chain_into_one_ledger_by_the_cursor_each_is_read_after) {
  std::string walked;
  FeedCursor cursor;
  for (const char* name : {"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble",
                           "older_period_refunded", "account_erased", "caught_up"}) {
    const Json::Value example = contractExample("feed.json", name);
    const FeedPage page{example["body"]};
    CHECK_EQ(example["request"]["after"].asUInt64(), cursor.seq);
    CHECK_FALSE(cursor.restoreIn(page).has_value());
    std::string seqs;
    for (const FeedEntry& entry : page.entries) seqs += " " + std::to_string(entry.seq) + ":" + entry.type;
    cursor = cursor.past(page);
    walked += std::string(name) + " ->" + std::to_string(cursor.seq) + (cursor.caughtUpWith(page) ? " caught up" : "") +
              seqs + "\n";
  }
  CHECK_EQ(cursor.epoch, std::string("c09a3ab3-2732-4415-ba88-825ff868cf13"));
  CHECK_EQ(walked, std::string(
      "from_zero ->6 1:started 2:bound 3:period_recorded 4:started 5:period_recorded 6:bound\n"
      "claimed_then_sandbox ->13 7:period_recorded 9:started 10:bound 11:period_recorded 12:renewed 13:period_recorded\n"
      "refunded_then_renewed ->17 14:period_refunded 15:revoked 16:renewed 17:period_recorded\n"
      "payment_trouble ->21 18:payment_failed 19:updated 20:payment_recovered 21:period_recorded\n"
      "older_period_refunded ->25 22:period_refunded 23:period_refund_reversed 24:renewal_turned_off 25:expired\n"
      "account_erased ->26 caught up 26:unbound\n"
      "caught_up ->26 caught up\n"));
}

TEST(subscription_feed_entries_carry_the_entitlement_of_the_account_they_name_after_their_transaction) {
  std::map<Seq, const FeedEntry*> bySeq;
  std::vector<FeedPage> pages;
  for (const char* name : {"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble",
                           "older_period_refunded", "account_erased"})
    pages.push_back(recorded(name));
  for (const FeedPage& page : pages)
    for (const FeedEntry& entry : page.entries) bySeq[entry.seq] = &entry;

  const std::vector<std::pair<Seq, const char*>> named{{3, "active"}, {13, "sandbox_active"}, {15, "revoked"},
                                                       {18, "grace"}, {19, "on_hold"}, {24, "cancelled_access_continues"},
                                                       {25, "expired"}, {26, "never_subscribed"}};
  for (const auto& [seq, name] : named) {
    REQUIRE(bySeq[seq]->entitlement.has_value());
    CHECK_EQ(bySeq[seq]->entitlement->body, entitlementExample(name));
  }

  std::string read;
  for (const auto& [seq, entry] : bySeq) {
    read += std::to_string(seq) + " " + (entry->accountId ? entry->accountId->str().substr(0, 8) : "-");
    if (entry->entitlement)
      read += " production=" +
              (entry->entitlement->productionAccessUntil ? std::to_string(*entry->entitlement->productionAccessUntil) : "-") +
              " sandbox=" +
              (entry->entitlement->sandboxAccessUntil ? std::to_string(*entry->entitlement->sandboxAccessUntil) : "-");
    read += "\n";
  }
  CHECK_EQ(read, std::string(
      "1 3f6c2a1e production=1799056800000 sandbox=-\n"
      "2 3f6c2a1e production=1799056800000 sandbox=-\n"
      "3 3f6c2a1e production=1799056800000 sandbox=-\n"
      "4 -\n"
      "5 -\n"
      "6 9387ec65 production=1799236800000 sandbox=-\n"
      "7 9387ec65 production=1799236800000 sandbox=-\n"
      "9 c806aea4 production=- sandbox=1796742300000\n"
      "10 c806aea4 production=- sandbox=1796742300000\n"
      "11 c806aea4 production=- sandbox=1796742300000\n"
      "12 c806aea4 production=- sandbox=1796742600000\n"
      "13 c806aea4 production=- sandbox=1796742600000\n"
      "14 9387ec65 production=- sandbox=-\n"
      "15 9387ec65 production=- sandbox=-\n"
      "16 3f6c2a1e production=1801735200000 sandbox=-\n"
      "17 3f6c2a1e production=1801735200000 sandbox=-\n"
      "18 3f6c2a1e production=1803031200000 sandbox=-\n"
      "19 3f6c2a1e production=- sandbox=-\n"
      "20 3f6c2a1e production=1805810400000 sandbox=-\n"
      "21 3f6c2a1e production=1805810400000 sandbox=-\n"
      "22 3f6c2a1e production=1805810400000 sandbox=-\n"
      "23 3f6c2a1e production=1805810400000 sandbox=-\n"
      "24 3f6c2a1e production=1805724000000 sandbox=-\n"
      "25 3f6c2a1e production=- sandbox=-\n"
      "26 3f6c2a1e production=- sandbox=-\n"));
}

TEST(subscription_feed_entries_carry_every_field_the_contract_gives_an_event) {
  std::string read;
  for (const char* name : {"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble",
                           "older_period_refunded", "account_erased"}) {
    const Json::Value body = contractExample("feed.json", name)["body"];
    const FeedPage page{body};
    for (Json::ArrayIndex at = 0; at < body["entries"].size(); ++at) {
      const Json::Value& recordedEntry = body["entries"][at];
      const FeedEntry& entry = page.entries[at];
      CHECK_EQ(entry.subscriptionId, recordedEntry["subscriptionId"].asString());
      if (entry.period) CHECK_EQ(entry.period->id, recordedEntry["period"]["id"].asString());
      const auto word = [](const std::optional<std::string>& value) { return value ? *value : std::string("-"); };
      const auto instant = [](const std::optional<std::int64_t>& value) { return value ? std::to_string(*value) : std::string("-"); };
      read += std::to_string(entry.seq) + " " + entry.type + " occurred=" + std::to_string(entry.occurredAt) +
              " recorded=" + std::to_string(entry.recordedAt) + " subscription=" + entry.subscriptionId.substr(0, 8) +
              " account=" + (entry.accountId ? entry.accountId->str().substr(0, 8) : "-") + " " + entry.store + " " +
              entry.environment + " offer=" + word(entry.offerKind);
      if (entry.period)
        read += " period=" + entry.period->id.substr(0, 8) + " [" + std::to_string(entry.period->start) + "," +
                std::to_string(entry.period->end) + ") price=" +
                (entry.period->price ? entry.period->price->amount + " " + entry.period->price->currency : "-") +
                " offer=" + word(entry.period->offerKind) + " refunded=" + instant(entry.period->refundedAt);
      read += "\n";
    }
  }
  CHECK_EQ(read, std::string(
      "1 started occurred=1796292000000 recorded=1796292004000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "2 bound occurred=1796292000000 recorded=1796292004000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "3 period_recorded occurred=1796292000000 recorded=1796292004000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=- period=e2b8f0a4 [1796292000000,1798970400000) price=12.00 USD offer=- refunded=-\n"
      "4 started occurred=1796472000000 recorded=1796472003000 subscription=77f866f6 account=- app_store production offer=-\n"
      "5 period_recorded occurred=1796472000000 recorded=1796472003000 subscription=77f866f6 account=- app_store production offer=- period=8f04068f [1796472000000,1799150400000) price=12.00 USD offer=- refunded=-\n"
      "6 bound occurred=1796547600000 recorded=1796547600000 subscription=77f866f6 account=9387ec65 app_store production offer=-\n"
      "7 period_recorded occurred=1796547600000 recorded=1796547600000 subscription=77f866f6 account=9387ec65 app_store production offer=- period=8f04068f [1796472000000,1799150400000) price=12.00 USD offer=- refunded=-\n"
      "9 started occurred=1796742000000 recorded=1796742002000 subscription=c0498d34 account=c806aea4 app_store sandbox offer=-\n"
      "10 bound occurred=1796742000000 recorded=1796742002000 subscription=c0498d34 account=c806aea4 app_store sandbox offer=-\n"
      "11 period_recorded occurred=1796742000000 recorded=1796742002000 subscription=c0498d34 account=c806aea4 app_store sandbox offer=- period=5f28ab82 [1796742000000,1796742300000) price=12.00 USD offer=- refunded=-\n"
      "12 renewed occurred=1796742300000 recorded=1796742302000 subscription=c0498d34 account=c806aea4 app_store sandbox offer=-\n"
      "13 period_recorded occurred=1796742300000 recorded=1796742302000 subscription=c0498d34 account=c806aea4 app_store sandbox offer=- period=db0e7f48 [1796742300000,1796742600000) price=12.00 USD offer=- refunded=-\n"
      "14 period_refunded occurred=1797780600000 recorded=1797780602000 subscription=77f866f6 account=9387ec65 app_store production offer=- period=8f04068f [1796472000000,1799150400000) price=12.00 USD offer=- refunded=1797780600000\n"
      "15 revoked occurred=1797780600000 recorded=1797780602000 subscription=77f866f6 account=9387ec65 app_store production offer=-\n"
      "16 renewed occurred=1798966800000 recorded=1798966810000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "17 period_recorded occurred=1798966800000 recorded=1798966810000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=- period=4c7a19e3 [1798970400000,1801648800000) price=12.00 USD offer=- refunded=-\n"
      "18 payment_failed occurred=1801648800000 recorded=1801648803000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "19 updated occurred=1803031200000 recorded=1803031203000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "20 payment_recovered occurred=1803304800000 recorded=1803304803000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "21 period_recorded occurred=1803304800000 recorded=1803304803000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=- period=d9aaabda [1803304800000,1805724000000) price=12.00 USD offer=- refunded=-\n"
      "22 period_refunded occurred=1803898800000 recorded=1803898802000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=- period=4c7a19e3 [1798970400000,1801648800000) price=12.00 USD offer=- refunded=1803898800000\n"
      "23 period_refund_reversed occurred=1804608000000 recorded=1804608002000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=- period=4c7a19e3 [1798970400000,1801648800000) price=12.00 USD offer=- refunded=-\n"
      "24 renewal_turned_off occurred=1804708800000 recorded=1804708802000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "25 expired occurred=1805724000000 recorded=1805724004000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"
      "26 unbound occurred=1806580800000 recorded=1806580800000 subscription=a7d40c52 account=3f6c2a1e app_store production offer=-\n"));

  // A free trial's period: no price, and an offer on the event and its period alike.
  Json::Value trial = contractExample("feed.json", "from_zero")["body"];
  trial["entries"][2]["offerKind"] = "free_trial";
  trial["entries"][2]["period"]["offerKind"] = "free_trial";
  trial["entries"][2]["period"]["price"] = Json::nullValue;
  const FeedPage trialPage{trial};
  const FeedEntry& period = trialPage.entries[2];
  CHECK_EQ(period.offerKind, std::optional<std::string>("free_trial"));
  CHECK_EQ(period.period->offerKind, std::optional<std::string>("free_trial"));
  CHECK_FALSE(period.period->price.has_value());
}

TEST(subscription_feed_a_word_the_contract_does_not_name_yet_is_carried_and_listed_never_refused) {
  Json::Value body = contractExample("feed.json", "from_zero")["body"];
  body["entries"][0]["type"] = "gifted";
  body["entries"][0]["period"] = body["entries"][2]["period"];
  body["entries"][1]["store"] = "galaxy_store";
  body["entries"][3]["offerKind"] = "half_price";
  body["entries"][4]["period"]["offerKind"] = "gift";
  const FeedPage page{body};

  std::string read;
  for (const FeedEntry& entry : page.entries) {
    read += std::to_string(entry.seq) + " " + entry.type + (entry.knownType ? "" : " (unknown)") + " store=" + entry.store +
            " offer=" + (entry.offerKind ? *entry.offerKind : "-") + " period=" +
            (entry.period ? entry.period->id.substr(0, 8) + " offer=" + (entry.period->offerKind ? *entry.period->offerKind : "-") : "-") +
            " entitlement=" + (entry.entitlement ? "yes" : "no") + " words=";
    for (const UnknownWord& unknown : entry.unknownWords) read += unknown.field + ":" + unknown.word + " ";
    read += "\n";
  }
  CHECK_EQ(read, std::string(
      "1 gifted (unknown) store=app_store offer=- period=- entitlement=yes words=type:gifted \n"
      "2 bound store=unknown offer=- period=- entitlement=yes words=store:galaxy_store \n"
      "3 period_recorded store=app_store offer=- period=e2b8f0a4 offer=- entitlement=yes words=\n"
      "4 started store=app_store offer=- period=- entitlement=no words=offerKind:half_price \n"
      "5 period_recorded store=app_store offer=- period=8f04068f offer=- entitlement=no words=period.offerKind:gift \n"
      "6 bound store=app_store offer=- period=- entitlement=yes words=\n"));

  // What decides access still refuses the page: an environment the contract does not name.
  body["entries"][0]["environment"] = "staging";
  CHECK_EQ(answerOf([&] { FeedPage{body}; }), std::string("malformed"));
}

TEST(subscription_feed_cursor_sees_a_restored_ledger_by_its_epoch_or_by_a_ledger_that_ends_below_it) {
  const FeedCursor following{"c09a3ab3-2732-4415-ba88-825ff868cf13", 26};
  CHECK_EQ(following.restoreIn(recorded("ledger_restored")), std::optional<std::string>("epoch"));
  CHECK_FALSE(following.restoreIn(recorded("caught_up")).has_value());

  Json::Value shorter = contractExample("feed.json", "caught_up")["body"];
  shorter["latestSeq"] = 21;
  CHECK_EQ(following.restoreIn(FeedPage{shorter}), std::optional<std::string>("latest_seq_below_cursor"));

  const FeedCursor neverRead;
  CHECK_FALSE(neverRead.restoreIn(recorded("ledger_restored")).has_value());
  CHECK_FALSE(neverRead.restoreIn(recorded("from_zero")).has_value());
}

TEST(subscription_feed_cursor_refuses_a_page_that_does_not_continue_it) {
  const FeedCursor at13{"c09a3ab3-2732-4415-ba88-825ff868cf13", 13};
  CHECK_EQ(answerOf([&] { at13.past(recorded("claimed_then_sandbox")); }), std::string("out-of-order"));
  CHECK_EQ(answerOf([&] { at13.past(recorded("ledger_restored")); }), std::string("epoch-changed"));
  CHECK_EQ(at13.past(recorded("refunded_then_renewed")), (FeedCursor{"c09a3ab3-2732-4415-ba88-825ff868cf13", 17}));
  CHECK_EQ(FeedCursor{}.past(recorded("ledger_restored")), (FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 0}));
}

TEST(subscription_feed_reads_a_body_the_contract_does_not_describe_as_malformed) {
  const Json::Value page = contractExample("feed.json", "from_zero")["body"];
  const std::vector<std::pair<std::string, std::function<void(Json::Value&)>>> breaks{
      {"no epoch", [](Json::Value& body) { body.removeMember("epoch"); }},
      {"entries not a list", [](Json::Value& body) { body["entries"] = Json::Value(Json::objectValue); }},
      {"no latestSeq", [](Json::Value& body) { body.removeMember("latestSeq"); }},
      {"an entry past latestSeq", [](Json::Value& body) { body["latestSeq"] = 5; }},
      {"seqs out of order", [](Json::Value& body) { body["entries"][1]["seq"] = 1; }},
      {"a seq in words", [](Json::Value& body) { body["entries"][0]["seq"] = "1"; }},
      {"no type", [](Json::Value& body) { body["entries"][0].removeMember("type"); }},
      {"no accountId", [](Json::Value& body) { body["entries"][0].removeMember("accountId"); }},
      {"an account that is not a uuid", [](Json::Value& body) {
         body["entries"][0]["accountId"] = "account-1";
         body["entries"][0]["entitlement"]["accountId"] = "account-1";
       }},
      {"an account with no entitlement", [](Json::Value& body) { body["entries"][0]["entitlement"] = Json::nullValue; }},
      {"an entitlement with no account", [](Json::Value& body) { body["entries"][3]["entitlement"] = body["entries"][0]["entitlement"]; }},
      {"another account's entitlement", [](Json::Value& body) { body["entries"][0]["entitlement"] = body["entries"][5]["entitlement"]; }},
      {"no sandbox", [](Json::Value& body) { body["entries"][0]["entitlement"].removeMember("sandbox"); }},
      {"accessUntil in words", [](Json::Value& body) { body["entries"][0]["entitlement"]["production"]["accessUntil"] = "soon"; }},
      {"no accessUntil", [](Json::Value& body) { body["entries"][0]["entitlement"]["production"].removeMember("accessUntil"); }},
      {"another environment", [](Json::Value& body) { body["entries"][0]["environment"] = "staging"; }},
      {"occurredAt in words", [](Json::Value& body) { body["entries"][0]["occurredAt"] = "today"; }},
      {"no recordedAt", [](Json::Value& body) { body["entries"][0].removeMember("recordedAt"); }},
      {"a subscription that is not a uuid", [](Json::Value& body) { body["entries"][0]["subscriptionId"] = "sub_1"; }},
      {"a period on a lifecycle event", [](Json::Value& body) { body["entries"][0]["period"] = body["entries"][2]["period"]; }},
      {"a period event with no period", [](Json::Value& body) { body["entries"][2]["period"] = Json::nullValue; }},
      {"a period id that is not a uuid", [](Json::Value& body) { body["entries"][2]["period"]["id"] = "txn-1"; }},
      {"a period with no end", [](Json::Value& body) { body["entries"][2]["period"].removeMember("end"); }},
      {"an amount that is not decimal", [](Json::Value& body) { body["entries"][2]["period"]["price"]["amount"] = "12,00"; }},
      {"an amount with no digits after the point", [](Json::Value& body) { body["entries"][2]["period"]["price"]["amount"] = "12."; }},
      {"a currency in lower case", [](Json::Value& body) { body["entries"][2]["period"]["price"]["currency"] = "usd"; }},
      {"refundedAt in words", [](Json::Value& body) { body["entries"][2]["period"]["refundedAt"] = "yesterday"; }},
  };
  std::string answers;
  for (const auto& [name, mutate] : breaks) {
    Json::Value broken = page;
    mutate(broken);
    answers += name + ": " + answerOf([&] { FeedPage{broken}; }) + "\n";
  }
  CHECK_EQ(answers, std::string(
      "no epoch: malformed\n"
      "entries not a list: malformed\n"
      "no latestSeq: malformed\n"
      "an entry past latestSeq: malformed\n"
      "seqs out of order: malformed\n"
      "a seq in words: malformed\n"
      "no type: malformed\n"
      "no accountId: malformed\n"
      "an account that is not a uuid: malformed\n"
      "an account with no entitlement: malformed\n"
      "an entitlement with no account: malformed\n"
      "another account's entitlement: malformed\n"
      "no sandbox: malformed\n"
      "accessUntil in words: malformed\n"
      "no accessUntil: malformed\n"
      "another environment: malformed\n"
      "occurredAt in words: malformed\n"
      "no recordedAt: malformed\n"
      "a subscription that is not a uuid: malformed\n"
      "a period on a lifecycle event: malformed\n"
      "a period event with no period: malformed\n"
      "a period id that is not a uuid: malformed\n"
      "a period with no end: malformed\n"
      "an amount that is not decimal: malformed\n"
      "an amount with no digits after the point: malformed\n"
      "a currency in lower case: malformed\n"
      "refundedAt in words: malformed\n"));
  CHECK_EQ(answerOf([&] { FeedPage{page}; }), std::string("read"));
}
