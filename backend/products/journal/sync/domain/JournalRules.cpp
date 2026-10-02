#include "products/journal/sync/domain/JournalRules.h"

#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/TextMerge.h"

#include <algorithm>
#include <limits>
#include <tuple>

namespace wm::journal::engine {

using namespace sync;

namespace {

bool unsignedBound(const Json::Value& value, std::uint64_t maximum) {
  return isSafeInteger(value) && value.asDouble() >= 0 && value.asDouble() <= static_cast<double>(maximum);
}

Json::Value value(const Row* row, const std::string& field) {
  if (!row) return {};
  const auto found = row->lattice.f.find(field);
  return found == row->lattice.f.end() ? Json::Value() : found->second.value;
}

bool whitespaceToken(std::string_view token) {
  if (token.empty()) return false;
  const auto first = static_cast<unsigned char>(token.front());
  if (first == ' ' || (first >= 9 && first <= 13)) return true;
  for (const std::string_view point : {"\xc2\xa0", "\xe1\x9a\x80", "\xe2\x80\x80", "\xe2\x80\x81",
                                     "\xe2\x80\x82", "\xe2\x80\x83", "\xe2\x80\x84", "\xe2\x80\x85",
                                     "\xe2\x80\x86", "\xe2\x80\x87", "\xe2\x80\x88", "\xe2\x80\x89",
                                     "\xe2\x80\x8a", "\xe2\x80\xa8", "\xe2\x80\xa9", "\xe2\x80\xaf",
                                     "\xe2\x81\x9f", "\xe3\x80\x80", "\xef\xbb\xbf"}) {
    if (token.starts_with(point)) return true;
  }
  return false;
}

std::string_view trimStart(std::string_view text) {
  const auto tokens = tokenize(text);
  if (!tokens.empty() && whitespaceToken(tokens.front())) text.remove_prefix(tokens.front().size());
  return text;
}

std::string_view trimEnd(std::string_view text) {
  const auto tokens = tokenize(text);
  if (!tokens.empty() && whitespaceToken(tokens.back())) text.remove_suffix(tokens.back().size());
  return text;
}

void checkedBody(const std::string& body) {
  if (body.size() > kMaxPageBytes) throw Refusal("too-large");
}

CommandOutcome replace(const Json::Value& args, const Row* current, Ms now) {
  Delta delta{.t = "page", .id = RecordId(args["day"])};
  WriteEntry write{.t = "page", .id = delta.id};
  for (const char* name : {"mood", "energy", "source"}) {
    delta.lattice.f.emplace(name, Reg(args[name], Stamp{}));
    write.f.emplace(name, Stamp{});
  }
  delta.lattice.f.emplace("documentStamp", Reg(args["stamp"], Stamp{}));
  write.f.emplace("documentStamp", Stamp{});
  Json::Value archive(Json::objectValue);
  archive["archivedAt"] = Json::UInt64(now);
  if (current) archive["documentStamp"] = value(current, "documentStamp");
  delta.x.emplace("body", TextWrite{.text = args["body"].asString(), .replacement = true,
                                     .archiveNonempty = true, .archive = std::move(archive)});
  CommandOutcome result;
  result.deltas.push_back(std::move(delta));
  result.write.push_back(std::move(write));
  return result;
}

}

bool isCalendarDay(std::string_view day) {
  if (day.size() != 10 || day[4] != '-' || day[7] != '-') return false;
  for (std::size_t index = 0; index < day.size(); ++index) {
    if (index != 4 && index != 7 && (day[index] < '0' || day[index] > '9')) return false;
  }
  const int year = (day[0] - '0') * 1000 + (day[1] - '0') * 100 + (day[2] - '0') * 10 + day[3] - '0';
  const int month = (day[5] - '0') * 10 + day[6] - '0';
  const int date = (day[8] - '0') * 10 + day[9] - '0';
  if (year == 0 || month < 1 || month > 12) return false;
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  const int lengths[] = {31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  return date >= 1 && date <= lengths[month - 1];
}

bool isDocumentStamp(const Json::Value& stamp) {
  if (!stamp.isObject() || stamp.getMemberNames() != std::vector<std::string>{"actor", "counter", "ms"}) return false;
  if (!unsignedBound(stamp["ms"], (1ULL << 53) - 1) ||
      !unsignedBound(stamp["counter"], std::numeric_limits<std::uint32_t>::max()) || !stamp["actor"].isString()) return false;
  const std::string actor = stamp["actor"].asString();
  if (actor.size() > 64 || !std::all_of(actor.begin(), actor.end(), [](unsigned char c) { return c >= 0x20 && c <= 0x7e; })) return false;
  return !actor.empty() || (stamp["ms"].asUInt64() == 0 && stamp["counter"].asUInt64() == 0);
}

int compareDocumentStamps(const Json::Value& a, const Json::Value& b) {
  const auto first = std::tuple{a["ms"].asUInt64(), a["counter"].asUInt64(), a["actor"].asString()};
  const auto second = std::tuple{b["ms"].asUInt64(), b["counter"].asUInt64(), b["actor"].asString()};
  return first < second ? -1 : first > second ? 1 : 0;
}

Json::Value nextDocumentStamp(const Json::Value& pair, const Json::Value& observed, Ms now, const std::string& actor) {
  Ms ms = 0;
  std::uint64_t counter = 0;
  if (!pair.isNull()) {
    if (!pair.isObject() || !unsignedBound(pair["ms"], (1ULL << 53) - 1) ||
        !unsignedBound(pair["counter"], std::numeric_limits<std::uint32_t>::max())) throw Refusal("invalid");
    ms = pair["ms"].asUInt64();
    counter = pair["counter"].asUInt64();
  }
  if (!observed.isNull()) {
    if (!isDocumentStamp(observed)) throw Refusal("invalid");
    if (std::pair{observed["ms"].asUInt64(), observed["counter"].asUInt64()} > std::pair{ms, counter}) {
      ms = observed["ms"].asUInt64();
      counter = observed["counter"].asUInt64();
    }
  }
  if (now > ms) {
    ms = now;
    counter = 0;
  } else if (counter == std::numeric_limits<std::uint32_t>::max()) {
    ++ms;
    counter = 0;
  } else {
    ++counter;
  }
  Json::Value stamp(Json::objectValue);
  stamp["ms"] = Json::UInt64(ms);
  stamp["counter"] = Json::UInt64(counter);
  stamp["actor"] = actor;
  if (actor.empty() || !isDocumentStamp(stamp)) throw Refusal("invalid");
  return stamp;
}

std::string claimBody(std::string_view account, std::string_view here) {
  const std::string_view trimmedAccount = trimStart(trimEnd(account));
  if (trimmedAccount.empty()) return std::string(here);
  if (trimStart(trimEnd(here)).empty()) return std::string(account);
  if (here.find(trimmedAccount) != std::string_view::npos) return std::string(here);
  return std::string(trimEnd(account)) + "\n\n" + std::string(trimStart(here));
}

JournalOutcome runJournal(const std::string& name, const Json::Value& args, const Json::Value& rawArgs,
                           const Row* current, const Json::Value& books, Ms now) {
  if (!args["day"].isString() || !isCalendarDay(args["day"].asString()) || !args["body"].isString()) throw Refusal("invalid");
  checkedBody(args["body"].asString());
  if (name == "journal.savePage") {
    if (!isDocumentStamp(args["stamp"])) throw Refusal("invalid");
    if (current && compareDocumentStamps(args["stamp"], value(current, "documentStamp")) <= 0) return {};
    return JournalOutcome{.command = replace(args, current, now)};
  }
  if (name != "journal.claimPage" || !args["claimId"].isString()) throw Refusal("invalid");
  const std::string claimId = args["claimId"].asString();
  if (claimId.empty() || claimId.size() > 128) throw Refusal("invalid");
  const std::string digest = sha256(jcs(rawArgs)).hex();
  const Json::Value old = books["claims"][claimId];
  if (!old.isNull()) {
    if (old["digest"].asString() != digest) throw Refusal("claim-conflict");
    return {};
  }
  const auto currentBody = current ? current->x.find("body") : std::map<std::string, TextVal>::const_iterator{};
  const std::string account = current && currentBody != current->x.end() ? currentBody->second.text : "";
  Json::Value joined = args;
  joined["body"] = claimBody(account, args["body"].asString());
  checkedBody(joined["body"].asString());
  joined["stamp"] = nextDocumentStamp(books["contentClock"], value(current, "documentStamp"), now, "srv");
  for (const char* field : {"mood", "energy"}) if (args[field].isNull()) joined[field] = value(current, field);
  Json::Value receipt(Json::objectValue);
  receipt["digest"] = digest;
  receipt["day"] = args["day"];
  receipt["documentStamp"] = joined["stamp"];
  Json::Value pair(Json::objectValue);
  pair["ms"] = joined["stamp"]["ms"];
  pair["counter"] = joined["stamp"]["counter"];
  return JournalOutcome{replace(joined, current, now), claimId, std::move(receipt), std::move(pair)};
}

std::vector<Delta> checkJournal(const Intent& intent) {
  if (std::any_of(intent.d.begin(), intent.d.end(), [](const Delta& delta) { return delta.t == "page"; })) throw Refusal("invalid");
  return {};
}

std::vector<JournalRevision> pruneJournalRevisions(std::vector<JournalRevision> revisions,
                                                  const std::set<std::string>& affected, Ms now) {
  if (affected.empty()) return revisions;
  std::sort(revisions.begin(), revisions.end(), [](const auto& a, const auto& b) {
    return std::tie(a.archivedAt, a.rev) > std::tie(b.archivedAt, b.rev);
  });
  std::map<std::string, std::size_t> perDay;
  std::erase_if(revisions, [&](const auto& row) { return affected.contains(row.day) && ++perDay[row.day] > 10; });
  std::size_t bytes = 0;
  std::size_t index = 0;
  std::erase_if(revisions, [&](const auto& row) {
    bytes += row.bytes;
    return index++ >= 500 || bytes > 8'388'608 || (now >= kRevisionRetentionMs && row.archivedAt < now - kRevisionRetentionMs);
  });
  return revisions;
}

Json::Value retainedRevisions(const Json::Value& input) {
  std::vector<JournalRevision> revisions;
  for (const auto& row : input["revisions"]) {
    revisions.push_back(JournalRevision{row["day"].asString(), row["rev"].asUInt64(),
                                        static_cast<std::size_t>(row["bytes"].asUInt64()), row["archivedAt"].asUInt64()});
  }
  std::set<std::string> affected;
  for (const auto& day : input["days"]) affected.insert(day.asString());
  Json::Value result(Json::objectValue);
  result["kept"] = Json::Value(Json::arrayValue);
  for (const auto& row : pruneJournalRevisions(std::move(revisions), affected, input["serverNow"].asUInt64())) {
    result["kept"].append(Json::UInt64(row.rev));
  }
  return result;
}

}
