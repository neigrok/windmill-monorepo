#include "products/journal/application/EchoSweep.h"

#include "products/journal/domain/Passage.h"
#include "products/journal/domain/SpanReconcile.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <exception>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {
// The repair cadence, and it is no longer how anyone receives an echo — a saved page is derived
// seconds later by EchoDerivations. What is left for this ticker is the work no save triggers:
// inbound reverse edges a live derivation deliberately does not chase, pages made stale by a
// corpus that moved under them, pages a vendor blip failed, and the derivations a per-page daily
// cap deferred. Six hours is generous for all four, because none of them is anybody waiting.
// Re-deriving an unchanged page is prevented by its stamps, not by the cadence: duePages only
// returns what is genuinely owed, so a live derivation that already ran costs this pass nothing.
constexpr double kEchoTickSeconds = 6.0 * 60.0 * 60.0;
constexpr double kEchoFirstTickSeconds = 60.0;
constexpr std::uint64_t kEchoLookbackMs = 24ull * 60 * 60 * 1000;

CurationStatus statusFor(const std::string& failure) {
  if (failure == "rate_limited") return CurationStatus::rateLimited;
  if (failure == "truncated") return CurationStatus::truncated;
  if (failure == "schema_invalid") return CurationStatus::schemaInvalid;
  if (failure == "refused") return CurationStatus::refused;
  return CurationStatus::transport;
}

// Three disjoint counters over one status, because the three mean three different things to whoever
// reads the log line: work delivered, work still owed, and work that will never be delivered and is
// no longer owed either. Blending the last into `pagesFailed` is how a permanent silence reads as a
// vendor having a bad night.
void countPage(EchoSweepReport& report, CurationStatus status) {
  if (isSuccess(status)) ++report.pagesDerived;
  else if (status == CurationStatus::refused) ++report.pagesRefused;
  else ++report.pagesFailed;
}
}

EchoSweep::EchoSweep(EchoRepository& echoes, Embedder& embedder, Curator& curator, Clock& clock,
                     Entitlements& entitlements, SelectionRules rules, SweepBudget budget)
    : echoes_(echoes), embedder_(embedder), curator_(curator), clock_(clock),
      entitlements_(entitlements), rules_(std::move(rules)), budget_(budget),
      heartbeat_("journal-echo") {}

void EchoSweep::start() {
  heartbeat_.start(kEchoFirstTickSeconds, kEchoTickSeconds, [this] {
    const std::uint64_t now = clock_.nowMs();
    const EchoSweepReport report = run(now - kEchoLookbackMs);
    if (report.pagesDerived > 0 || report.pagesFailed > 0 || report.pagesRefused > 0)
      LOG_INFO << "journal echo: " << report.usersScanned << " users, " << report.pagesDerived
               << " pages, " << report.passagesEmbedded << " passages, " << report.echoesWritten
               << " echoes, " << report.pagesFailed << " failed, " << report.pagesRefused
               << " refused, " << report.pagesOverBudget
               << " over budget, " << report.usersOverAiBudget << " users out of AI budget";
  });
  const bool armed = embedder_.configured() && curator_.configured();
  LOG_INFO << "journal echo: repair heartbeat armed, first sweep in " << kEchoFirstTickSeconds
           << "s (" << (armed ? "embedder + curator configured" : "unwired — dark") << ")";
}

void EchoSweep::runAsync(std::uint64_t sinceMs, std::function<void(EchoSweepReport)> done) {
  heartbeat_.queue([this, sinceMs, done = std::move(done)] {
    // `done` fires on every path: the operator is waiting on a promise it cannot fulfil itself, and
    // an empty report reads as "nothing ran", which is exactly what happened.
    try {
      done(run(sinceMs));
    } catch (const std::exception& error) {
      LOG_ERROR << "journal echo sweep failed: " << error.what();
      done(EchoSweepReport{});
    } catch (...) {
      LOG_ERROR << "journal echo sweep failed";
      done(EchoSweepReport{});
    }
  });
}

EchoSweepReport EchoSweep::derivePage(const UserId& user, const LocalDate& day) {
  EchoSweepReport report;
  // Either boundary missing is the same quiet no-op it is on the repair path: no row is written and
  // the page stays due, so wiring the vendors later derives it rather than skipping it forever.
  if (!embedder_.configured() || !curator_.configured()) return report;
  ++report.usersScanned;

  if (!entitlements_.sweepAllowanceFor(user).allows()) {
    ++report.usersOverAiBudget;
    return report;
  }

  const std::uint64_t corpusStamp = echoes_.corpusStamp(user);
  const std::optional<DuePage> page = echoes_.duePage(user, day, corpusStamp);
  // Nothing owed. The ordinary case for the second of two debounced saves that carried no new text,
  // and the reason a coalesced burst cannot bill twice even when it fires twice.
  if (!page) return report;

  const CurationOutcome outcome = derive(user, *page, corpusStamp, report);
  echoes_.recordCuration(user, page->day, outcome);
  countPage(report, outcome.status);
  return report;
}

EchoSweepReport EchoSweep::run(std::uint64_t sinceMs) {
  EchoSweepReport report;
  // Either boundary missing makes the whole pass a quiet no-op rather than an error — the same
  // discipline PlanComposer uses behind paste-import. No user is scanned and no row is written.
  if (!embedder_.configured() || !curator_.configured()) return report;

  for (const EchoUser& due : echoes_.activeSince(sinceMs)) {
    ++report.usersScanned;
    const UserId& user = due.user;

    // The background bucket, asked once for the whole user rather than per page. Dry means SKIPPED,
    // not failed: nothing is written, so no stamp advances, so every page this user is owed is still
    // owed on the next pass. A refusal recorded here would mark the night done and lose it.
    if (!entitlements_.sweepAllowanceFor(user).allows()) {
      ++report.usersOverAiBudget;
      continue;
    }

    // Read once and carry it through the user's whole pass. A page derived halfway through would
    // otherwise record a stamp covering spans it never saw, and would never re-run against them.
    const std::uint64_t corpusStamp = echoes_.corpusStamp(user);

    std::vector<DuePage> pages = echoes_.duePages(user, corpusStamp);
    if (static_cast<int>(pages.size()) > budget_.pagesPerUser) {
      report.pagesOverBudget += static_cast<int>(pages.size()) - budget_.pagesPerUser;
      pages.erase(pages.begin() + budget_.pagesPerUser, pages.end());
    }

    // A page derived this pass may have moved text that other pages reach into, so those pages'
    // stored quotes can no longer locate. Walk that reverse edge in the same pass, budgeted — the
    // alternative is an edited page silently killing every echo aimed at it until it is touched
    // again, which for a page nobody edits is forever.
    std::set<std::string> queued;
    for (const DuePage& page : pages) queued.insert(page.day.iso());

    for (std::size_t i = 0; i < pages.size(); ++i) {
      const DuePage page = pages[i];
      const CurationOutcome outcome = derive(user, page, corpusStamp, report);
      echoes_.recordCuration(user, page.day, outcome);
      countPage(report, outcome.status);
      // The reverse edge is walked on SETTLED, not on success: a refused page still replaced its own
      // spans at step 3, so the pages reaching into it still hold quotes that have moved, and they
      // are owed a re-derivation whether or not this page got an answer.
      if (!isSettled(outcome.status)) continue;

      int enqueued = 0;
      for (const LocalDate& inbound : echoes_.inboundPages(user, page.day)) {
        if (enqueued >= budget_.inboundPerPage) break;
        if (!queued.insert(inbound.iso()).second) continue;
        // Re-derive it from the current body; duePages did not name it because its own body never
        // moved, only the page it points at.
        pages.push_back(DuePage{inbound, {}, 0, 0});
        ++enqueued;
        ++report.inboundEnqueued;
      }
    }
  }
  return report;
}

CurationOutcome EchoSweep::derive(const UserId& user, const DuePage& page,
                                  std::uint64_t corpusStamp, EchoSweepReport& report) {
  CurationOutcome outcome;
  outcome.bodyStampMs = page.bodyStampMs;
  outcome.corpusStamp = corpusStamp;

  // 1 — segment. An empty page is finished, not owed a retry: there is nothing to reach back with.
  const std::vector<Passage> fresh = segment(page.body);
  if (fresh.empty()) {
    echoes_.replaceSpans(user, page.day, {}, embedder_.version(), page.bodyStampMs);
    echoes_.replaceEchoes(user, page.day, CuratedEchoes{curator_.version(), {}});
    outcome.status = CurationStatus::emptyOk;
    return outcome;
  }

  // 2 — embed. A short result is a FAILED call, never a page with fewer passages: storing it as
  // the latter would mark the page done and lose it.
  std::vector<std::string> texts;
  texts.reserve(fresh.size());
  for (const Passage& passage : fresh) texts.push_back(passage.text);
  const std::vector<std::vector<float>> vectors = embedder_.embed(texts);
  if (vectors.size() != fresh.size()) {
    outcome.status = CurationStatus::transport;
    outcome.error = "embedder returned " + std::to_string(vectors.size()) + " of " +
                    std::to_string(fresh.size());
    return outcome;
  }
  report.passagesEmbedded += static_cast<int>(fresh.size());

  // 3 — reconcile, so a passage whose text is unchanged keeps its identity however far down the
  // page it moved. This is what stops an inserted sentence re-pointing every inbound echo.
  const std::vector<IdentifiedPassage> carried = reconcile(echoes_.spansOf(user, page.day), fresh);
  std::vector<SpanWrite> writes;
  writes.reserve(carried.size());
  for (std::size_t i = 0; i < carried.size(); ++i)
    writes.push_back(SpanWrite{carried[i].spanId, carried[i].passage, vectors[i]});
  echoes_.replaceSpans(user, page.day, writes, embedder_.version(), page.bodyStampMs);

  // 4 — retrieve. Reading the corpus back after the write is also how tonight's passages acquire
  // the identities storage just minted for them.
  const std::vector<Vectored> corpus = echoes_.corpusOf(user, embedder_.version());
  std::vector<Vectored> tonight;
  std::vector<Vectored> history;
  for (const Vectored& span : corpus) {
    if (span.day == page.day) tonight.push_back(span);
    else history.push_back(span);
  }

  std::set<std::pair<std::int64_t, std::int64_t>> waved;
  for (const SpanPair& pair : echoes_.dismissalsOn(user, page.day))
    waved.insert({pair.triggerSpanId, pair.matchSpanId});

  // 5 — select, for the page. The refrain gate, each trigger's ranking, the reader's dismissals
  // and the page ceiling are one domain call (EchoSelection.h, selectForPage) — the same call the
  // debug door runs, so what an operator is shown is what a save did and not a second opinion
  // about it. `nearestReported` 0: the near misses cost another corpus scan and only that door
  // pays for them.
  const PageSelection selection =
      selectForPage(tonight, history, waved, rules_, budget_.echoesPerPage, 0);
  report.pagesSkippedRefrain += selection.refrains;
  const std::vector<Pairing>& proposed = selection.pairings;

  // The candidate passages the curator is handed, gathered once by identity so a passage two
  // triggers both reached back to is sent once.
  std::map<std::int64_t, Vectored> offered;
  for (const Vectored& span : history)
    for (const Pairing& pairing : proposed)
      if (pairing.matchSpanId == span.spanId) offered.emplace(span.spanId, span);

  if (proposed.empty()) {
    echoes_.replaceEchoes(user, page.day, CuratedEchoes{curator_.version(), {}});
    outcome.status = CurationStatus::emptyOk;
    return outcome;
  }

  // 6 — curate. `ok == false` is a failed CALL, which is not the same as finding nothing, and the
  // difference is the whole reason a page can be retried tomorrow instead of lost tonight.
  std::vector<Vectored> candidates;
  candidates.reserve(offered.size());
  for (const auto& [spanId, span] : offered) candidates.push_back(span);
  const Curation curation = curator_.curate(user, tonight, candidates, proposed);
  if (!curation.ok) {
    outcome.status = statusFor(curation.failure);
    outcome.error = curation.failure;
    // A refusal settles the page, so it leaves it in a DEFINITE state rather than carrying whatever
    // an earlier body's pass wrote. Step 3 has already replaced this page's spans; echoes aimed from
    // here at span ids that no longer exist are not a record of anything, and a page the vendor will
    // not judge is a page that carries none.
    if (outcome.status == CurationStatus::refused)
      echoes_.replaceEchoes(user, page.day, CuratedEchoes{curator_.version(), {}});
    return outcome;
  }

  // 7 — persist what the curator kept.
  CuratedEchoes curated;
  curated.curatorVersion = curator_.version();   // already encodes the prompt identity
  std::map<std::pair<std::int64_t, std::int64_t>, float> cosines;
  for (const Pairing& pairing : proposed)
    cosines[{pairing.triggerSpanId, pairing.matchSpanId}] = pairing.cosine;

  for (const Verdict& verdict : curation.verdicts) {
    if (!verdict.related) continue;
    const auto match = offered.find(verdict.matchSpanId);
    const auto cosine = cosines.find({verdict.triggerSpanId, verdict.matchSpanId});
    // A verdict naming a pairing nobody proposed is dropped rather than trusted.
    if (match == offered.end() || cosine == cosines.end()) continue;
    curated.rows.push_back(EchoRow{verdict.triggerSpanId, match->second.day, verdict.matchSpanId,
                                   cosine->second, verdict.relation, verdict.speakerIsSelf});
  }
  echoes_.replaceEchoes(user, page.day, curated);
  report.echoesWritten += static_cast<int>(curated.rows.size());
  outcome.status = curated.rows.empty() ? CurationStatus::emptyOk : CurationStatus::ok;
  return outcome;
}

}
