#include "products/journal/adapters/http/EchoApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <chrono>
#include <cstdint>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {
constexpr std::uint64_t kDayMs = 24ULL * 60 * 60 * 1000;

// How much of a passage an unentitled reader is shown: enough to recognise their own sentence, not
// enough to be the feature. The withheld count travels with it so the cut is stated.
constexpr std::size_t kFreeWords = 8;

drogon::HttpResponsePtr noContent() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  return response;
}

std::vector<std::string> wordsOf(const std::string& text) {
  std::istringstream stream(text);
  std::vector<std::string> words;
  for (std::string word; stream >> word;) words.push_back(word);
  return words;
}

// The honest cut. An entitled reader gets the passage; everyone else gets its real opening words
// and the number withheld.
void appendMatch(Json::Value& into, const EchoView& echo, bool entitled) {
  Json::Value match(Json::objectValue);
  match["day"] = echo.matchDay.iso();
  match["isSelf"] = echo.matchIsSelf;
  match["source"] = echo.matchSource == Source::spoken ? "spoken" : "typed";
  // The reader's own answer, on both sides of the cut, and served rather than left to the device so
  // a mark made on a laptop is not asked for again on a phone.
  match["useful"] = echo.markedUseful;

  if (entitled) {
    match["text"] = echo.matchText;
    match["withheldWords"] = 0;
    // Which occurrence of that text the passage is, 0 for the first. Absent when the server has
    // nothing honest to say — the body moved under the passage — and absent for the honest cut
    // below, where the text served is a prefix.
    if (echo.matchOccurrenceHint >= 0) match["occurrenceHint"] = echo.matchOccurrenceHint;
    into.append(match);
    return;
  }

  const std::vector<std::string> words = wordsOf(echo.matchText);
  const std::size_t shown = words.size() < kFreeWords ? words.size() : kFreeWords;
  std::string prefix;
  for (std::size_t i = 0; i < shown; ++i) {
    if (i > 0) prefix += ' ';
    prefix += words[i];
  }
  match["text"] = prefix;
  match["withheldWords"] = static_cast<int>(words.size() - shown);
  into.append(match);
}

Json::Value toJson(const EchoSweepReport& report) {
  Json::Value body(Json::objectValue);
  body["usersScanned"] = report.usersScanned;
  body["pagesDerived"] = report.pagesDerived;
  body["pagesSkippedRefrain"] = report.pagesSkippedRefrain;
  body["passagesEmbedded"] = report.passagesEmbedded;
  body["echoesWritten"] = report.echoesWritten;
  body["pagesFailed"] = report.pagesFailed;
  body["inboundEnqueued"] = report.inboundEnqueued;
  body["pagesOverBudget"] = report.pagesOverBudget;
  return body;
}


// The tuning door's query knobs. A malformed value is IGNORED rather than answered 400: these are
// experiments an operator types by hand, and the fallback is the shipped default.
double knob(const drogon::HttpRequestPtr& req, const char* name, double fallback) {
  const std::string value = req->getParameter(name);
  if (value.empty()) return fallback;
  try {
    return std::stod(value);
  } catch (const std::exception&) {
    return fallback;
  }
}

int knob(const drogon::HttpRequestPtr& req, const char* name, int fallback) {
  const std::string value = req->getParameter(name);
  if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos) return fallback;
  try {
    return std::stoi(value);
  } catch (const std::exception&) {
    return fallback;
  }
}

Json::Value toJson(const SelectionRules& rules) {
  Json::Value body(Json::objectValue);
  body["minDayGap"] = rules.minDayGap;
  body["shown"] = rules.shown;
  body["refrainRadius"] = rules.refrainRadius;
  body["refrainCrowd"] = rules.refrainCrowd;
  body["familyRadius"] = rules.familyRadius;
  body["restatement"] = rules.restatement;
  body["perBand"] = rules.perBand;
  body["maxRecent"] = rules.maxRecent;
  body["maxPerMonth"] = rules.maxPerMonth;
  body["distanceWeight"] = rules.distanceWeight;
  body["familyPenalty"] = rules.familyPenalty;
  body["diversityPenalty"] = rules.diversityPenalty;
  return body;
}

// One candidate and the whole of what the rules read about it.
Json::Value toJson(const CandidateNote& note) {
  Json::Value body(Json::objectValue);
  body["spanId"] = static_cast<Json::Int64>(note.spanId);
  body["day"] = note.day.iso();
  body["text"] = note.text;
  body["cosine"] = note.cosine;
  body["ageDays"] = static_cast<Json::Int64>(note.ageDays);
  body["z"] = note.z;
  body["score"] = note.score;
  body["familySize"] = note.familySize;
  body["representative"] = static_cast<Json::Int64>(note.representative);
  body["fate"] = fateText(note.fate);
  return body;
}

Json::Value toJson(const TriggerTrace& trace) {
  Json::Value body(Json::objectValue);
  body["spanId"] = static_cast<Json::Int64>(trace.spanId);
  body["text"] = trace.text;
  body["crowd"] = trace.crowd;
  body["refrain"] = trace.refrain;
  body["history"] = trace.history;
  body["retrieved"] = trace.retrieved;
  body["mean"] = trace.mean;
  body["stddev"] = trace.stddev;
  Json::Value candidates(Json::arrayValue);
  for (const CandidateNote& note : trace.notes) candidates.append(toJson(note));
  body["candidates"] = candidates;
  return body;
}

Json::Value toJson(const EchoExplanation& explained) {
  Json::Value body(Json::objectValue);
  Json::Value page(Json::objectValue);
  page["found"] = explained.pageFound;
  page["bodyBytes"] = static_cast<Json::UInt64>(explained.body.size());
  page["bodyStampMs"] = static_cast<Json::UInt64>(explained.bodyStampMs);
  // Whether a save right now would derive at all — a settled page answers "no echoes" without the
  // pipeline running, which is a different silence from every rule below saying no.
  page["due"] = explained.due;
  page["storedSpans"] = explained.storedSpans;
  body["page"] = page;

  Json::Value wiring(Json::objectValue);
  wiring["segmenter"] = explained.segmenterConfigured;
  wiring["segmentVersion"] = explained.segmentVersion;
  wiring["embedder"] = explained.embedderConfigured;
  wiring["embedVersion"] = explained.embedVersion;
  wiring["curator"] = explained.curatorConfigured;
  wiring["curatorVersion"] = explained.curatorVersion;
  body["wiring"] = wiring;

  Json::Value corpus(Json::objectValue);
  // Under THIS embedding version only: a version bump leaves the old vectors unreachable, which
  // reads to a user as echoes simply stopping.
  corpus["spans"] = explained.corpus;
  corpus["history"] = static_cast<int>(explained.history.size());
  body["corpus"] = corpus;

  Json::Value passages(Json::arrayValue);
  for (const Passage& passage : explained.passages) {
    Json::Value one(Json::objectValue);
    one["ord"] = passage.ord;
    one["text"] = passage.text;
    passages.append(one);
  }
  body["passages"] = passages;
  // Where those units came from: the stored cut is what the page reaches on today, a fresh one is
  // what it WOULD reach if it were re-derived now.
  body["unitsFromStorage"] = explained.unitsFromStorage;
  body["unitsDiscarded"] = explained.unitsDiscarded;

  Json::Value triggers(Json::arrayValue);
  for (const TriggerTrace& trace : explained.selection.traces) triggers.append(toJson(trace));
  body["triggers"] = triggers;

  Json::Value proposed(Json::arrayValue);
  for (const Pairing& pairing : explained.selection.pairings) {
    Json::Value one(Json::objectValue);
    one["triggerSpanId"] = static_cast<Json::Int64>(pairing.triggerSpanId);
    one["matchSpanId"] = static_cast<Json::Int64>(pairing.matchSpanId);
    one["cosine"] = pairing.cosine;
    one["score"] = pairing.score;
    one["familySize"] = pairing.familySize;
    proposed.append(one);
  }
  body["proposed"] = proposed;
  body["refrains"] = explained.selection.refrains;
  body["cappedOut"] = explained.selection.cappedOut;

  Json::Value verdicts(Json::arrayValue);
  for (const Verdict& verdict : explained.verdicts) {
    Json::Value one(Json::objectValue);
    one["triggerSpanId"] = static_cast<Json::Int64>(verdict.triggerSpanId);
    one["matchSpanId"] = static_cast<Json::Int64>(verdict.matchSpanId);
    one["related"] = verdict.related;
    one["relation"] = verdict.relation;
    one["speakerIsSelf"] = verdict.speakerIsSelf;
    verdicts.append(one);
  }
  body["verdicts"] = verdicts;
  if (!explained.curationFailure.empty()) body["curationFailure"] = explained.curationFailure;

  // What the page carries TODAY, so a run can be read against the thing the reader actually sees.
  Json::Value persisted(Json::arrayValue);
  for (const EchoView& echo : explained.persisted) {
    Json::Value one(Json::objectValue);
    one["matchDay"] = echo.matchDay.iso();
    one["daysEarlier"] = echo.daysEarlier;
    one["triggerText"] = echo.triggerText;
    one["matchText"] = echo.matchText;
    persisted.append(one);
  }
  body["persisted"] = persisted;
  if (!explained.error.empty()) body["error"] = explained.error;
  return body;
}

// The one millisecond knob of the admin door, read from the body or the query: nullopt is a
// malformed value the caller answers 400 to, zero is simply absent. Digits-only before stoull so a
// "-5" cannot wrap and a 20-digit overflow stays a 400 rather than a 500.
std::optional<std::uint64_t> msOf(const drogon::HttpRequestPtr& req,
                                  const std::shared_ptr<Json::Value>& json, const char* name) {
  if (json && json->isMember(name)) {
    if (!(*json)[name].isUInt64()) return std::nullopt;
    return (*json)[name].asUInt64();
  }
  const std::string param = req->getParameter(name);
  if (param.empty()) return 0;
  if (param.find_first_not_of("0123456789") != std::string::npos) return std::nullopt;
  try {
    return std::stoull(param);
  } catch (const std::out_of_range&) {
    return std::nullopt;
  }
}
}

EchoApi::EchoApi(std::shared_ptr<EchoRepository> echoes, std::shared_ptr<EchoSweep> sweep,
                 std::shared_ptr<EchoExplainer> explainer, std::shared_ptr<AuthService> auth,
                 std::shared_ptr<Entitlements> entitlements, std::string adminToken)
    : echoes_(std::move(echoes)), sweep_(std::move(sweep)), explainer_(std::move(explainer)),
      auth_(std::move(auth)), entitlements_(std::move(entitlements)),
      adminToken_(std::move(adminToken)) {}

void EchoApi::listEchoes(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to read your echoes"));
    return;
  }

  const std::string from = req->getParameter("from");
  const std::string to = req->getParameter("to");
  std::optional<LocalDate> first;
  std::optional<LocalDate> last;
  try {
    first = LocalDate{from.empty() ? "0001-01-01" : from};
    last = LocalDate{to.empty() ? "9999-12-31" : to};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  const bool entitled = entitlements_->hasWindmillOne(caller->id, caller->email.value);

  // Which pages the reader has already answered "not now" on. Served rather than remembered by the
  // device, so the next device does not ask again.
  std::set<std::string> offersRetired;
  for (const LocalDate& day : echoes_->retiredOffers(caller->id, *first, *last))
    offersRetired.insert(day.iso());

  // Grouped by the page that carries them, in the order the repository returns: newest trigger
  // first, then each page's matches newest first.
  Json::Value pages(Json::arrayValue);
  std::string openDay;
  Json::Value page(Json::objectValue);
  Json::Value matches(Json::arrayValue);
  for (const EchoView& echo : echoes_->echoesFor(caller->id, *first, *last)) {
    if (echo.triggerDay.iso() != openDay) {
      if (!openDay.empty()) {
        page["matches"] = matches;
        pages.append(page);
      }
      openDay = echo.triggerDay.iso();
      page = Json::Value(Json::objectValue);
      page["day"] = openDay;
      page["entitled"] = entitled;
      page["offerRetired"] = offersRetired.count(openDay) > 0;
      matches = Json::Value(Json::arrayValue);
    }
    appendMatch(matches, echo, entitled);
  }
  if (!openDay.empty()) {
    page["matches"] = matches;
    pages.append(page);
  }

  // The browser cannot count pages it has not synced, so the ~20-page floor is unenforceable unless
  // this is served.
  Json::Value body(Json::objectValue);
  body["pages"] = pages;
  body["pagesWritten"] = echoes_->pagesWritten(caller->id);
  // The ~20-page corpus floor is right for a stranger's first fortnight and wrong for the people
  // building it: below the floor the client draws NOTHING, so a working echo is indistinguishable
  // from a broken pipeline. The floor still applies to everybody else.
  body["floorWaived"] = entitlements_->isOwner(caller->email.value);
  cb(jsonResponse(body));
}

void EchoApi::dismiss(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                      const std::string& triggerDay, const std::string& matchDay) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to dismiss an echo"));
    return;
  }
  std::optional<LocalDate> trigger;
  std::optional<LocalDate> match;
  try {
    trigger = LocalDate{triggerDay};
    match = LocalDate{matchDay};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  // Waving away a pairing between two DAYS says two things: it retires the pair — keyed on the two
  // passages' content down in storage, because an ordinal shifts the moment a sentence is inserted —
  // and it is a JUDGEMENT. Two calls, in this order: the dismissal leaves journal_echo standing, so
  // the signal still finds the row it copies the score and version off.
  echoes_->dismissPair(*caller, *trigger, *match);
  echoes_->recordSignal(*caller, *trigger, *match, EchoSignal::notUseful);
  cb(noContent());   // idempotent: a pairing that is already gone dismisses nothing, and says 204
}

void EchoApi::dismissPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& triggerDay) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to dismiss an echo"));
    return;
  }
  std::optional<LocalDate> trigger;
  try {
    trigger = LocalDate{triggerDay};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  // "Not useful" is one tap on a panel, so it is one request: nine matches must not cost nine round
  // trips, each able to fail on its own and leave the page half faded. The judgement is recorded for
  // all of them too.
  echoes_->dismissPage(*caller, *trigger);
  echoes_->recordPageSignal(*caller, *trigger, EchoSignal::notUseful);
  cb(noContent());   // idempotent: a page with nothing left to retire dismisses nothing, and says 204
}

void EchoApi::dismissOffer(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& triggerDay) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to retire an offer"));
    return;
  }
  std::optional<LocalDate> day;
  try {
    day = LocalDate{triggerDay};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  // "Not now" — the echoes on this page stay, the honest cut stays, and only the asking stops.
  // Recorded server-side so the same person is not asked again.
  echoes_->dismissOffer(*caller, *day);
  cb(noContent());   // idempotent: declining twice is declining once
}

void EchoApi::markUseful(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                         const std::string& triggerDay, const std::string& matchDay) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to mark an echo useful"));
    return;
  }
  std::optional<LocalDate> trigger;
  std::optional<LocalDate> match;
  try {
    trigger = LocalDate{triggerDay};
    match = LocalDate{matchDay};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  // The reader saying outright that a pairing was worth showing them: no echo is retired and nothing
  // is re-ranked. It answers 204 however many times it is pressed.
  echoes_->recordSignal(*caller, *trigger, *match, EchoSignal::useful);
  cb(noContent());
}

void EchoApi::opened(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                     const std::string& triggerDay, const std::string& matchDay) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in"));
    return;
  }
  std::optional<LocalDate> trigger;
  std::optional<LocalDate> match;
  try {
    trigger = LocalDate{triggerDay};
    match = LocalDate{matchDay};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  // The reader walked back to the older page. Weaker than a "useful", so it is its own kind.
  echoes_->recordSignal(*caller, *trigger, *match, EchoSignal::opened);
  cb(noContent());
}

void EchoApi::adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // The operator's rehearsal door, closed unless the deploy set an admin token. The compare is
  // constant-time so a wrong token cannot be guessed a byte at a time.
  const std::string header = req->getHeader("x-admin-token");
  const std::string presented = header.empty() ? req->getParameter("token") : header;
  if (adminToken_.empty() || !secretEqual(presented, adminToken_)) {
    cb(error(drogon::k403Forbidden, "admin token required"));
    return;
  }

  std::shared_ptr<Json::Value> json = req->getJsonObject();
  std::optional<std::uint64_t> since = msOf(req, json, "sinceMs");
  if (!since) {
    cb(error(drogon::k400BadRequest, "sinceMs must be a millisecond timestamp"));
    return;
  }

  // `sinceMs` is the whole rehearsal: which users to look at. There is no "as of" instant, because a
  // pass judges every page against stamps the corpus carries. An unstated window is the last day,
  // read off the wall here — this edge owns no Clock.
  std::uint64_t sinceMs = *since;
  if (sinceMs == 0) {
    const std::uint64_t nowMs =
        static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                       std::chrono::system_clock::now().time_since_epoch())
                                       .count());
    sinceMs = nowMs > kDayMs ? nowMs - kDayMs : 0;
  }

  // Off this thread: a repair pass is minutes of embedder and curator calls, and the IO thread that
  // took this request also serves every other route.
  sweep_->runAsync(sinceMs, [cb = std::move(cb)](const EchoSweepReport& report) {
    cb(jsonResponse(toJson(report)));
  });
}

void EchoApi::explainPage(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& day) {
  const std::string header = req->getHeader("x-admin-token");
  const std::string presented = header.empty() ? req->getParameter("token") : header;
  if (adminToken_.empty() || !secretEqual(presented, adminToken_)) {
    cb(error(drogon::k403Forbidden, "admin token required"));
    return;
  }
  // And a signed-in owner on top of it: this hands back whole passages, and only the caller's own.
  // The admin secret opens the door; it names nobody.
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in as the owner of the page"));
    return;
  }

  std::optional<LocalDate> date;
  try {
    date = LocalDate{day};
  } catch (const InvalidPage&) {
    cb(error(drogon::k400BadRequest, "bad date"));
    return;
  }

  ExplainRequest request{.day = *date};
  request.rules.minDayGap = knob(req, "minDayGap", request.rules.minDayGap);
  request.rules.shown = knob(req, "shown", request.rules.shown);
  request.rules.refrainRadius = knob(req, "refrainRadius", request.rules.refrainRadius);
  request.rules.refrainCrowd = knob(req, "refrainCrowd", request.rules.refrainCrowd);
  request.rules.familyRadius = knob(req, "familyRadius", request.rules.familyRadius);
  request.rules.restatement = knob(req, "restatement", request.rules.restatement);
  request.rules.perBand = knob(req, "perBand", request.rules.perBand);
  request.rules.maxRecent = knob(req, "maxRecent", request.rules.maxRecent);
  request.rules.maxPerMonth = knob(req, "maxPerMonth", request.rules.maxPerMonth);
  request.rules.distanceWeight = knob(req, "distanceWeight", request.rules.distanceWeight);
  request.rules.familyPenalty = knob(req, "familyPenalty", request.rules.familyPenalty);
  request.rules.diversityPenalty = knob(req, "diversityPenalty", request.rules.diversityPenalty);
  request.echoesPerPage = knob(req, "echoesPerPage", request.echoesPerPage);
  request.nearest = knob(req, "nearest", request.nearest);
  request.curate = req->getParameter("curate") == "1" || req->getParameter("curate") == "true";
  request.recut = req->getParameter("recut") == "1" || req->getParameter("recut") == "true";

  // Off this thread: an embed round trip and, when asked, a curator call — seconds, on one of the
  // handful of IO threads serving every other route.
  explainer_->explainAsync(*caller, request,
                           [cb = std::move(cb), rules = request.rules](
                               const EchoExplanation& explained) {
                             Json::Value body = toJson(explained);
                             // The rules the run actually used, echoed back.
                             body["rules"] = toJson(rules);
                             cb(jsonResponse(body));
                           });
}

}
