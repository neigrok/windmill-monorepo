#include "products/journal/sync/JournalRules.h"

#include "platform/domain/sync/Jcs.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::sync;
using namespace wm::journal::engine;

namespace {

Json::Value saveArgs() {
  return parseJson(R"({"day":"2026-10-01","body":"here","mood":null,"energy":0,"source":"typed","stamp":{"ms":1000,"counter":0,"actor":"writer:one"}})");
}

Row page(const Json::Value& args) {
  Row row{"page", RecordId(args["day"])};
  for (const char* name : {"mood", "energy", "source"}) row.lattice.f.emplace(name, Reg(args[name], Stamp{10, 0, "srv"}));
  row.lattice.f.emplace("documentStamp", Reg(args["stamp"], Stamp{10, 0, "srv"}));
  row.x["body"] = TextVal{args["body"].asString(), 1, false};
  row.seq = 1;
  return row;
}

std::string refusal(const std::function<void()>& action) {
  try { action(); } catch (const Refusal& error) { return error.refused.code; }
  return "accepted";
}

}

TEST(journal_calendar_checks_centuries_and_year_bounds) {
  for (const char* day : {"0001-01-01", "9999-12-31", "2000-02-29", "2024-02-29"}) CHECK(isCalendarDay(day));
  for (const char* day : {"0000-01-01", "1900-02-29", "2100-02-29", "2026-02-29", "2026-04-31", "2026-1-01", "2026-13-01", "2026-01-00"}) CHECK_FALSE(isCalendarDay(day));
}

TEST(journal_content_clock_is_separate_and_carries_counter_overflow) {
  const auto next = nextDocumentStamp(parseJson(R"({"ms":100,"counter":10})"),
                                       parseJson(R"({"ms":200,"counter":4294967295,"actor":"future:writer"})"), 50, "srv");
  CHECK_EQ(jcs(next), std::string(R"({"actor":"srv","counter":0,"ms":201})"));
  CHECK_EQ(refusal([&] { nextDocumentStamp(Json::Value(), parseJson(R"({"ms":9007199254740991,"counter":4294967295,"actor":"writer"})"), 50, "srv"); }), std::string("invalid"));
  CHECK(isDocumentStamp(parseJson(R"({"ms":0,"counter":0,"actor":""})")));
  CHECK_FALSE(isDocumentStamp(parseJson(R"({"ms":1,"counter":0,"actor":""})")));
  CHECK_FALSE(isDocumentStamp(parseJson(R"({"ms":1,"counter":0,"actor":"writer","extra":1})")));
}

TEST(journal_claim_uses_ecmascript_whitespace_and_containment) {
  CHECK_EQ(claimBody("\xef\xbb\xbf account \xe2\x80\xaf", "\xc2\xa0here"), std::string("\xef\xbb\xbf account\n\nhere"));
  CHECK_EQ(claimBody("\xe3\x80\x80", "\nverbatim \n"), std::string("\nverbatim \n"));
  CHECK_EQ(claimBody("account \n", "\xe2\x80\xa8"), std::string("account \n"));
  CHECK_EQ(claimBody(" account ", "prefix account suffix"), std::string("prefix account suffix"));
}

TEST(journal_stale_save_checks_raw_bytes_before_returning_noop) {
  Json::Value args = saveArgs();
  const Row current = page(args);
  CHECK(runJournal("journal.savePage", args, args, &current, Json::Value(), 100).command.deltas.empty());
  args["body"] = std::string(kMaxPageBytes + 1, 'x');
  CHECK_EQ(refusal([&] { runJournal("journal.savePage", args, args, &current, Json::Value(), 100); }), std::string("too-large"));
}

TEST(journal_claim_receipt_replays_before_a_later_page_edit) {
  Json::Value args = saveArgs();
  args.removeMember("stamp");
  args["claimId"] = "claim-one";
  auto currentArgs = saveArgs();
  currentArgs["body"] = "account";
  currentArgs["mood"] = 5;
  const Row current = page(currentArgs);
  const auto accepted = runJournal("journal.claimPage", args, args, &current, Json::Value(), 2000);
  REQUIRE_EQ(accepted.command.deltas.size(), std::size_t(1));
  CHECK_EQ(accepted.command.deltas[0].x.at("body").text, std::string("account\n\nhere"));
  CHECK_EQ(accepted.command.deltas[0].lattice.f.at("mood").value, Json::Value(5));
  CHECK_EQ(accepted.command.deltas[0].lattice.f.at("energy").value, Json::Value(0));
  CHECK(accepted.command.deltas[0].x.at("body").replacement);
  CHECK(accepted.command.deltas[0].x.at("body").archiveNonempty);
  Json::Value books(Json::objectValue);
  books["claims"]["claim-one"] = accepted.receipt;
  currentArgs["body"] = "another device's edit";
  currentArgs["stamp"]["ms"] = 4000;
  const Row edited = page(currentArgs);
  CHECK(runJournal("journal.claimPage", args, args, &edited, books, 5000).command.deltas.empty());
  args["mood"] = 2;
  CHECK_EQ(refusal([&] { runJournal("journal.claimPage", args, args, &edited, books, 5000); }), std::string("claim-conflict"));
}

TEST(journal_claim_joined_cap_and_clock_exhaustion_return_no_receipt) {
  Json::Value args = saveArgs();
  args.removeMember("stamp");
  args["claimId"] = "claim-one";
  auto currentArgs = saveArgs();
  currentArgs["body"] = std::string(kMaxPageBytes, 'a');
  Row current = page(currentArgs);
  CHECK_EQ(refusal([&] { runJournal("journal.claimPage", args, args, &current, Json::Value(), 100); }), std::string("too-large"));
  currentArgs["body"] = "account";
  currentArgs["stamp"] = parseJson(R"({"ms":9007199254740991,"counter":4294967295,"actor":"future"})");
  current = page(currentArgs);
  CHECK_EQ(refusal([&] { runJournal("journal.claimPage", args, args, &current, Json::Value(), 100); }), std::string("invalid"));
}

TEST(journal_revision_pruning_runs_only_after_insertion) {
  std::vector<JournalRevision> revisions{{"day", 1, 1, 0}, {"day", 2, 9'000'000, 100}};
  const auto untouched = pruneJournalRevisions(revisions, {}, kRevisionRetentionMs + 200);
  REQUIRE_EQ(untouched.size(), revisions.size());
  CHECK_EQ(untouched[0].rev, Seq(1));
  CHECK_EQ(untouched[1].rev, Seq(2));
  CHECK(pruneJournalRevisions(revisions, {"day"}, 100).empty());
}
