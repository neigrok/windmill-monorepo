#include "products/journal/adapters/llm/AnthropicCurator.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <set>
#include <unordered_map>
#include <utility>

namespace wm {

namespace {

// The load-bearing artifact. It is the cached block, so it is a literal and never gains a byte from
// any page — and it is hashed into version(), so a row judged by an older wording stays findable
// years later. Change it and every stored echo's stamp moves, which is the point.
//
// Its only job is the two things a cosine cannot settle. It writes no copy, asserts nothing about
// the writer, and never sees the retriever's scores, so there is nothing here for it to ratify.
constexpr const char* kSystemPrompt =
    "You judge whether two passages from one person's private journal are about the same thing.\n"
    "\n"
    "Every call gives you three blocks.\n"
    "\n"
    "TONIGHT: the passages the writer wrote on the page being processed, labelled T1, T2, and so on.\n"
    "EARLIER PASSAGES: passages the same writer wrote on earlier days, oldest first, labelled E1, "
    "E2, and so on, each with the day it was written.\n"
    "PAIRINGS TO JUDGE: a numbered list of pairs, each one a passage from tonight and a passage from "
    "earlier. Judge every pairing in that list, and only those.\n"
    "\n"
    "Return one verdict per pairing, naming the pairing by its number. Each verdict settles three "
    "things.\n"
    "\n"
    "related. Do the two passages share a SUBJECT, or only vocabulary?\n"
    "  Same subject: \"i want to learn c++\" and \"i like c++\". The subject is C++ and the writer's "
    "relationship to it, and the second passage is the same thread of a life as the first.\n"
    "  Only vocabulary: \"i like c++\" and \"i like the work\". The sentence has the same shape; the "
    "subject does not.\n"
    "  Also not related: a pairing about somebody else's life. \"Sam's dad died on Tuesday\" is not "
    "an echo of \"Dad's scan came back clear\", however alike the words are. Both passages must be "
    "about the writer's own life.\n"
    "  A shared theme is not a shared subject. Work, tiredness, family, money and sleep are themes; "
    "a subject is the specific thing the writer was thinking about.\n"
    "\n"
    "speaker_is_self. Is the EARLIER passage the writer's own voice, or something they copied down?\n"
    "  Journals carry pasted messages, song lyrics, quotes from books, and lines somebody else said "
    "to them, in a session or at work or in an argument. These sit on the page as ordinary sentences "
    "and read like any other line. Set speaker_is_self to false when the earlier passage is one of "
    "those, and true when the writer is speaking as themselves.\n"
    "\n"
    "relation. A number from 0 to 1 saying how strongly the pairing holds, ranked only against the "
    "other pairings in this same call. It is never compared with any other call. Use 0 for any "
    "pairing you marked unrelated.\n"
    "\n"
    "Most pairings are not related, and marking every one of them false is a correct and expected "
    "answer. The pairings were chosen by a vector search that is good at finding passages which "
    "sound alike and cannot tell whether they are about the same thing, which is the entire reason "
    "you are being asked. Do not look for a reason to keep one.\n"
    "\n"
    "Judge only what is written. Do not infer, advise, diagnose, or comment.\n"
    "\n"
    "Example, a call where two of three pairings hold:\n"
    "{\"verdicts\":[{\"pairing\":1,\"related\":true,\"relation\":0.8,\"speaker_is_self\":true},"
    "{\"pairing\":2,\"related\":false,\"relation\":0,\"speaker_is_self\":true},"
    "{\"pairing\":3,\"related\":true,\"relation\":0.4,\"speaker_is_self\":false}]}\n"
    "\n"
    "Example, a call where nothing holds, which is the ordinary night:\n"
    "{\"verdicts\":[{\"pairing\":1,\"related\":false,\"relation\":0,\"speaker_is_self\":true},"
    "{\"pairing\":2,\"related\":false,\"relation\":0,\"speaker_is_self\":true},"
    "{\"pairing\":3,\"related\":false,\"relation\":0,\"speaker_is_self\":true}]}\n";

// The prompt's identity in eight characters: FNV-1a over the bytes above. Not a security hash, a
// change detector — the one thing stamped on a row that says which wording judged it.
std::string promptTag() {
  std::uint32_t hash = 2166136261u;
  for (const char* byte = kSystemPrompt; *byte != '\0'; ++byte) {
    hash ^= static_cast<unsigned char>(*byte);
    hash *= 16777619u;
  }
  char tag[9];
  std::snprintf(tag, sizeof(tag), "%08x", hash);
  return tag;
}

// A passage as it goes on the wire: one line, whatever the page did. Journal text is the writer's
// own and arrives verbatim, so a passage carrying a newline could otherwise write its own PAIRINGS
// block into the layout. The stored span is untouched; only this copy is flattened.
std::string oneLine(const std::string& text) {
  std::string flat = text;
  for (char& c : flat) {
    if (c == '\n' || c == '\r' || c == '\t') c = ' ';
  }
  return flat;
}

// Every knob of the answer's shape in one object. `additionalProperties: false` plus a `required`
// naming every field is what makes structured outputs strict rather than advisory — and strict is
// what turns the schema_invalid branch from a thing that happens into a thing that barely can.
Json::Value verdictSchema() {
  const auto typed = [](const char* type) {
    Json::Value field(Json::objectValue);
    field["type"] = type;
    return field;
  };

  Json::Value properties(Json::objectValue);
  properties["pairing"] = typed("integer");
  properties["related"] = typed("boolean");
  properties["relation"] = typed("number");
  properties["speaker_is_self"] = typed("boolean");

  Json::Value required(Json::arrayValue);
  required.append("pairing");
  required.append("related");
  required.append("relation");
  required.append("speaker_is_self");

  Json::Value verdict(Json::objectValue);
  verdict["type"] = "object";
  verdict["properties"] = properties;
  verdict["required"] = required;
  verdict["additionalProperties"] = false;

  Json::Value verdicts(Json::objectValue);
  verdicts["type"] = "array";
  verdicts["items"] = verdict;

  Json::Value root(Json::objectValue);
  root["type"] = "object";
  root["properties"] = Json::Value(Json::objectValue);
  root["properties"]["verdicts"] = verdicts;
  root["required"] = Json::Value(Json::arrayValue);
  root["required"].append("verdicts");
  root["additionalProperties"] = false;
  return root;
}

}

CurationPrompt curationPrompt(const std::vector<Vectored>& tonight,
                              const std::vector<Vectored>& candidates,
                              const std::vector<Pairing>& proposed) {
  std::unordered_map<std::int64_t, std::size_t> triggerLabel;
  for (std::size_t i = 0; i < tonight.size(); ++i) triggerLabel[tonight[i].spanId] = i + 1;

  // Only the candidates some pairing actually names. A candidate nobody proposed cannot be judged —
  // no pairing points at it — so carrying it would buy tokens and nothing else.
  std::set<std::int64_t> wanted;
  for (const Pairing& pairing : proposed) {
    if (triggerLabel.count(pairing.triggerSpanId) != 0) wanted.insert(pairing.matchSpanId);
  }

  std::vector<const Vectored*> earlier;
  std::set<std::int64_t> taken;
  for (const Vectored& candidate : candidates) {
    if (wanted.count(candidate.spanId) == 0) continue;
    if (!taken.insert(candidate.spanId).second) continue;
    earlier.push_back(&candidate);
  }
  // Oldest first, ties broken on span id: the order the card itself reads in, and the only order
  // that says nothing about which of these retrieval liked.
  std::sort(earlier.begin(), earlier.end(), [](const Vectored* a, const Vectored* b) {
    if (a->day == b->day) return a->spanId < b->spanId;
    return a->day < b->day;
  });

  std::unordered_map<std::int64_t, std::size_t> matchLabel;
  for (std::size_t i = 0; i < earlier.size(); ++i) matchLabel[earlier[i]->spanId] = i + 1;

  // Numbered by where the two passages sit on the page and in the archive, never by score. Ordering
  // the list by rank would hand the model the prior in a second form after taking the numbers away.
  std::vector<std::pair<std::pair<std::size_t, std::size_t>, Pairing>> lines;
  for (const Pairing& pairing : proposed) {
    const auto trigger = triggerLabel.find(pairing.triggerSpanId);
    const auto match = matchLabel.find(pairing.matchSpanId);
    if (trigger == triggerLabel.end() || match == matchLabel.end()) continue;
    lines.push_back({{trigger->second, match->second}, pairing});
  }
  std::sort(lines.begin(), lines.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });

  CurationPrompt prompt;
  if (lines.empty()) return prompt;

  prompt.text = "TONIGHT, " + tonight.front().day.iso() + "\n";
  for (std::size_t i = 0; i < tonight.size(); ++i) {
    prompt.text += "T" + std::to_string(i + 1) + ". " + oneLine(tonight[i].text) + "\n";
  }
  prompt.text += "\nEARLIER PASSAGES, OLDEST FIRST\n";
  for (std::size_t i = 0; i < earlier.size(); ++i) {
    prompt.text += "E" + std::to_string(i + 1) + ". " + earlier[i]->day.iso() + ". " +
                   oneLine(earlier[i]->text) + "\n";
  }
  prompt.text += "\nPAIRINGS TO JUDGE\n";
  for (std::size_t i = 0; i < lines.size(); ++i) {
    prompt.text += std::to_string(i + 1) + ". T" + std::to_string(lines[i].first.first) + " with E" +
                   std::to_string(lines[i].first.second) + "\n";
    prompt.numbered.push_back(lines[i].second);
  }
  return prompt;
}

AnthropicCurator::AnthropicCurator(std::shared_ptr<MessagesApi> transport, std::string model,
                                   std::string effort, std::shared_ptr<AiFuse> fuse,
                                   std::shared_ptr<UsageSink> usage)
    : transport_(std::move(transport)),
      model_(std::move(model)),
      effort_(std::move(effort)),
      fuse_(std::move(fuse)),
      usage_(std::move(usage)) {}

bool AnthropicCurator::configured() const { return transport_ && transport_->configured(); }

std::string AnthropicCurator::version() const {
  static const std::string tag = promptTag();
  return model_ + "/" + effort_ + "/" + tag;
}

Curation AnthropicCurator::curate(const UserId& user, const std::vector<Vectored>& tonight,
                                  const std::vector<Vectored>& candidates,
                                  const std::vector<Pairing>& proposed) {
  Curation curation;

  // Unconfigured is the sweep's mistake, not the page's — but it is still work the page is owed, so
  // it fails rather than reporting a night with nothing in it.
  if (!configured()) {
    curation.failure = MessagesFailure::transport;
    return curation;
  }

  const CurationPrompt prompt = curationPrompt(tonight, candidates, proposed);
  // Nothing to ask. Not a failure and not a blank answer either: retrieval offered no pairing, so
  // the page is genuinely done and does not come back tomorrow.
  if (prompt.numbered.empty()) {
    curation.ok = true;
    return curation;
  }

  // Over the process fuse, the page is not judged and not lost either: this is the same failed-call
  // shape as an unreachable vendor, so tomorrow's pass picks the page up exactly as it would have.
  if (fuse_ && !fuse_->allows(nowMs())) {
    curation.failure = MessagesFailure::transport;
    return curation;
  }

  MessagesRequest request;
  request.model = model_;
  request.system = kSystemPrompt;
  request.user = prompt.text;
  request.schema = verdictSchema();
  request.effort = effort_;

  const MessagesReply reply = transport_->send(request);
  // Recorded from HERE, not from the transport, because this is the frame that knows the model, the
  // operation and whose night it was — the transport knows only the wire. Every outcome lands,
  // including the refusals and truncations, which are the calls that thought the longest.
  AiSpend spend;
  spend.user = user;
  spend.product = "journal";
  spend.operation = "echo.curate";
  spend.runId = newRunId("curate");
  spend.model = model_;
  spend.outcome = reply.outcome;
  spend.tokens = reply.tokens;
  meterSpend(spend, fuse_, usage_);

  if (!reply.ok) {
    curation.failure = reply.failure;
    return curation;
  }

  const Json::Value& verdicts = reply.output["verdicts"];
  if (!verdicts.isArray()) {
    curation.failure = MessagesFailure::schemaInvalid;
    return curation;
  }

  std::set<int> answered;
  for (const Json::Value& item : verdicts) {
    if (!item.isObject()) continue;
    // A verdict is taken whole or not at all. One that names a pairing nobody proposed is about
    // nothing; one missing a field is a judgement we would have to invent half of. Either way the
    // page loses an echo, which is the failure this feature is allowed to have.
    if (!item["pairing"].isIntegral() || !item["related"].isBool() ||
        !item["relation"].isNumeric() || !item["speaker_is_self"].isBool())
      continue;
    const int number = item["pairing"].asInt();
    if (number < 1 || number > static_cast<int>(prompt.numbered.size())) continue;
    if (!answered.insert(number).second) continue;

    const Pairing& pairing = prompt.numbered[static_cast<std::size_t>(number) - 1];
    Verdict verdict;
    verdict.triggerSpanId = pairing.triggerSpanId;
    verdict.matchSpanId = pairing.matchSpanId;
    verdict.related = item["related"].asBool();
    verdict.relation = std::clamp(item["relation"].asFloat(), 0.0f, 1.0f);
    verdict.speakerIsSelf = item["speaker_is_self"].asBool();
    curation.verdicts.push_back(verdict);
  }

  curation.ok = true;
  return curation;
}

}
