#include "products/journal/application/EchoSweep.h"

#include "products/journal/domain/Passage.h"
#include "products/journal/domain/SpanReconcile.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <cstdio>
#include <exception>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

namespace {
// The repair cadence. Re-deriving an unchanged page is prevented by its stamps, not by the cadence.
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

// Three disjoint counters: work delivered, work still owed, work that never will be.
void countPage(EchoSweepReport& report, CurationStatus status) {
  if (isSuccess(status)) ++report.pagesDerived;
  else if (status == CurationStatus::refused) ++report.pagesRefused;
  else ++report.pagesFailed;
}
}

EchoSweep::EchoSweep(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder,
                     Curator& curator, Clock& clock, Entitlements& entitlements,
                     SelectionRules rules, SweepBudget budget)
    : echoes_(echoes), segmenter_(segmenter), embedder_(embedder), curator_(curator), clock_(clock),
      entitlements_(entitlements), rules_(std::move(rules)), budget_(budget),
      heartbeat_("journal-echo") {}

void EchoSweep::start() {
  heartbeat_.start(kEchoFirstTickSeconds, kEchoTickSeconds, [this] {
    const std::uint64_t now = clock_.nowMs();
    const EchoSweepReport report = run(now - kEchoLookbackMs);
    // Logged whenever anybody was SCANNED, not only when a page was derived. The old gate was the
    // three outcome counters, so the passes worth reading were exactly the silent ones: every writer
    // out of AI budget, or every trigger a refrain, printed nothing at all and looked identical to a
    // quiet night. `usersOverAiBudget` was in the line and unreachable in the one case it names.
    if (report.usersScanned > 0)
      LOG_INFO << "journal echo: " << report.usersScanned << " users, " << report.pagesDerived
               << " pages, " << report.passagesEmbedded << " passages, " << report.echoesWritten
               << " echoes, " << report.triggersSkippedRefrain << " refrains, "
               << report.inboundEnqueued << " inbound, " << report.pagesFailed << " failed, "
               << report.pagesRefused << " refused, " << report.unitsDiscarded
               << " units discarded, " << report.pagesOverBudget << " over budget, "
               << report.usersOverAiBudget << " users out of AI budget";
  });
  const bool armed =
      segmenter_.configured() && embedder_.configured() && curator_.configured();
  LOG_INFO << "journal echo: repair heartbeat armed, first sweep in " << kEchoFirstTickSeconds
           << "s (" << (armed ? "segmenter + embedder + curator configured" : "unwired — dark")
           << ")";
}

void EchoSweep::runAsync(std::uint64_t sinceMs, std::function<void(EchoSweepReport)> done,
                         bool rejudgeAll) {
  heartbeat_.queue([this, sinceMs, rejudgeAll, done = std::move(done)] {
    // `done` fires on every path.
    try {
      done(run(sinceMs, rejudgeAll));
    } catch (const std::exception& error) {
      LOG_ERROR << "journal echo sweep failed: " << error.what();
      done(EchoSweepReport{});
    } catch (...) {
      LOG_ERROR << "journal echo sweep failed";
      done(EchoSweepReport{});
    }
  });
}

PipelineVersions EchoSweep::versions() const {
  // The judging half is the curator's identity plus the selection knobs.
  return PipelineVersions{segmenter_.version(), embedder_.version(),
                          judgeVersion(curator_.version(), rules_)};
}

EchoSweepReport EchoSweep::derivePage(const UserId& user, const LocalDate& day) {
  EchoSweepReport report;
  // Any boundary missing is a no-op: no row is written and the page stays due.
  if (!segmenter_.configured() || !embedder_.configured() || !curator_.configured()) return report;
  ++report.usersScanned;

  if (!entitlements_.sweepAllowanceFor(user).allows()) {
    ++report.usersOverAiBudget;
    return report;
  }

  const std::uint64_t corpusStamp = echoes_.corpusStamp(user);
  const std::optional<DuePage> page = echoes_.duePage(user, day, corpusStamp, versions());
  if (!page) return report;

  CurationOutcome outcome = derive(user, *page, corpusStamp, report);
  // A SETTLED page was handled end to end by this build, so it records the whole pipeline. An
  // unsettled one keeps only the versions the steps it actually completed wrote, so the work
  // already paid for is not bought again — and so a refused page, which is settled, is never
  // reopened by a version it does not carry.
  if (isSettled(outcome.status)) outcome.versions = versions();
  echoes_.recordCuration(user, page->day, outcome);
  countPage(report, outcome.status);
  return report;
}

EchoSweepReport EchoSweep::run(std::uint64_t sinceMs, bool rejudgeAll) {
  EchoSweepReport report;
  // Any boundary missing makes the whole pass a no-op rather than an error.
  if (!segmenter_.configured() || !embedder_.configured() || !curator_.configured()) return report;

  for (const EchoUser& due : echoes_.activeSince(sinceMs)) {
    ++report.usersScanned;
    const UserId& user = due.user;

    // The background bucket, asked once per user. Dry means skipped, not failed: no stamp advances
    // and every page is still owed next pass.
    if (!entitlements_.sweepAllowanceFor(user).allows()) {
      ++report.usersOverAiBudget;
      continue;
    }

    // Read once and carried through the user's whole pass.
    const std::uint64_t corpusStamp = echoes_.corpusStamp(user);

    std::vector<DuePage> pages =
        rejudgeAll ? echoes_.allPages(user) : echoes_.duePages(user, corpusStamp, versions());
    if (static_cast<int>(pages.size()) > budget_.pagesPerUser) {
      report.pagesOverBudget += static_cast<int>(pages.size()) - budget_.pagesPerUser;
      pages.erase(pages.begin() + budget_.pagesPerUser, pages.end());
    }

    // A page derived this pass may have moved text other pages reach into, so the reverse edge is
    // walked in the same pass, budgeted.
    std::set<std::string> queued;
    for (const DuePage& page : pages) queued.insert(page.day.iso());

    for (std::size_t i = 0; i < pages.size(); ++i) {
      const DuePage page = pages[i];
      CurationOutcome outcome = derive(user, page, corpusStamp, report);
      if (isSettled(outcome.status)) outcome.versions = versions();   // see derivePage
      echoes_.recordCuration(user, page.day, outcome);
      countPage(report, outcome.status);
      // Walked on settled, not on success: a refused page replaced its own spans before the
      // curator was ever asked.
      if (!isSettled(outcome.status)) continue;

      int enqueued = 0;
      for (const LocalDate& inbound : echoes_.inboundPages(user, page.day)) {
        if (enqueued >= budget_.inboundPerPage) break;
        if (!queued.insert(inbound.iso()).second) continue;
        // Read here because duePages did not name it: its own body never moved. A day the writer
        // has no page on is skipped.
        const std::optional<DuePage> body = echoes_.pageAt(user, inbound);
        if (!body) continue;
        pages.push_back(*body);
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
  // WHAT THIS PASS ACHIEVED, filled in as each step succeeds — not what the build would produce.
  // The difference is money: a dead embedder fails every page at step 3, and a pass that claimed a
  // segment version anyway would look cut when it is not, while a pass that claims none buys the
  // cut it already paid a vendor for again in six hours, and again, forever, producing no echoes.
  // Each string is written by the step that earned it, and storage keeps the ones a failed pass
  // leaves empty rather than clearing them.

  // 1 — cut the page into idea units. A vendor call, made only when the BYTES moved: `bodyMoved`
  // compares storage's digest of the body it cut against this one, so a save that set mood or
  // energy and left the text alone reads false here and buys nothing.
  const std::vector<StoredSpan> stored = echoes_.spansOf(user, page.day);
  std::vector<Passage> fresh;
  if (!page.bodyMoved && !stored.empty()) {
    // Located rather than trusted, so a stale claim cannot produce a passage that is not there.
    std::vector<std::string> texts;
    texts.reserve(stored.size());
    for (const StoredSpan& span : stored) texts.push_back(span.text);
    fresh = locateUnits(page.body, texts);
  } else {
    const Segmentation cut = segmenter_.unitsOf(user, page.body);
    report.unitsDiscarded += cut.discarded;
    // A failed cut is a failed call, never a page with nothing on it.
    if (!cut.ok) {
      outcome.status = statusFor(cut.failure);
      outcome.error = "segmenter: " + cut.failure;
      // A refusal settles the page, so it ends carrying nothing. The spans are left alone.
      if (outcome.status == CurationStatus::refused) echoes_.clearEchoes(user, page.day);
      return outcome;
    }
    fresh = cut.passages;
  }

  // An empty page is finished, not owed a retry.
  if (fresh.empty()) {
    echoes_.replaceSpans(user, page.day, {}, embedder_.version(), page.body, page.bodyStampMs);
    echoes_.replaceEchoes(user, page.day, CuratedEchoes{curator_.version(), {}});
    outcome.status = CurationStatus::emptyOk;
    return outcome;
  }

  // 2 — reconcile, so unchanged text keeps its identity however far down the page it moved. It runs
  // BEFORE the embedder rather than after, which is only a reordering because reconciliation needs
  // nothing but text — and it is the whole saving: knowing which passages survived is what lets the
  // next step ask the embedder for the new ones alone. The embed round trip sits between the save
  // and the echo appearing, so this is latency and not only bill.
  std::vector<KnownSpan> known;
  known.reserve(stored.size());
  for (const StoredSpan& span : stored) known.push_back(KnownSpan{span.spanId, span.text});
  const std::vector<IdentifiedPassage> carried = reconcile(known, fresh);

  // 3 — embed what storage cannot already answer. Reuse is gated on the EMBEDDING VERSION, because
  // a cosine between two embedding spaces is meaningless, and on the RAW text rather than the
  // normalised identity reconcile carried the id by, because the vector is a function of the exact
  // bytes the embedder was handed.
  std::map<std::int64_t, const StoredSpan*> reusable;
  for (const StoredSpan& span : stored)
    if (span.embedVersion == embedder_.version()) reusable.emplace(span.spanId, &span);

  std::vector<std::vector<float>> vectors(carried.size());
  std::vector<std::string> texts;
  std::vector<std::size_t> asked;   // where each answer belongs in `vectors`
  for (std::size_t i = 0; i < carried.size(); ++i) {
    const auto held = reusable.find(carried[i].spanId);
    if (carried[i].spanId != 0 && held != reusable.end() &&
        held->second->text == carried[i].passage.text) {
      vectors[i] = held->second->vector;
      continue;
    }
    asked.push_back(i);
    texts.push_back(carried[i].passage.text);
  }
  // A short result is a failed call, never a page with fewer passages. Nothing to ask is not a
  // call at all, so an unchanged page reaches storage without touching the embedder.
  if (!texts.empty()) {
    const std::vector<std::vector<float>> fetched = embedder_.embed(texts);
    if (fetched.size() != texts.size()) {
      outcome.status = CurationStatus::transport;
      outcome.error = "embedder returned " + std::to_string(fetched.size()) + " of " +
                      std::to_string(texts.size());
      return outcome;
    }
    for (std::size_t i = 0; i < fetched.size(); ++i) vectors[asked[i]] = fetched[i];
    // What was BOUGHT, not what the page holds: the two differ now, and the gap is the saving.
    report.passagesEmbedded += static_cast<int>(fetched.size());
  }

  std::vector<SpanWrite> writes;
  writes.reserve(carried.size());
  for (std::size_t i = 0; i < carried.size(); ++i)
    writes.push_back(SpanWrite{carried[i].spanId, carried[i].passage, vectors[i]});
  echoes_.replaceSpans(user, page.day, writes, embedder_.version(), page.body, page.bodyStampMs);
  // Recorded HERE and not a line earlier, because these strings are a claim about what is IN
  // STORAGE, not about what this pass attempted. A pass that cut the page and then died at the
  // embedder stored nothing, so claiming a segment_version there would name the grammar that cut
  // units storage does not hold. The body digest above catches that case on its own now — no span
  // carries the new body's hash, so the page still reads as moved — but the claim would be a lie
  // either way, and `segment_version` is the half that answers a GRAMMAR bump rather than an edit.
  // Past this line both are true, so a curate that dies afterwards reads its units back instead of
  // re-buying the cut — which is the whole saving.
  outcome.versions.segment = segmenter_.version();
  outcome.versions.embed = embedder_.version();

  // 4 — retrieve. Reading the corpus back is also how tonight's passages acquire their minted ids.
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

  // 5 — select, for the page. `nearestReported` 0: near misses cost another corpus scan.
  const PageSelection selection =
      selectForPage(tonight, history, waved, rules_, budget_.echoesPerPage, 0);
  report.triggersSkippedRefrain += selection.refrains;
  const std::vector<Pairing>& proposed = selection.pairings;

  // What this pass actively refused, before the curator is asked. A stored pairing is retracted
  // only by a judgement about that pair, so only fates that are properties of the pair itself belong
  // here: no shared uncommon word, and the same sentence said again.
  std::vector<SpanPair> structural;
  for (const TriggerTrace& trace : selection.traces)
    for (const CandidateNote& note : trace.notes)
      if (note.fate == Fate::noAnchor || note.fate == Fate::restatement)
        structural.push_back(SpanPair{trace.spanId, note.spanId});

  // Gathered by identity, so a passage two triggers both reached back to is sent once.
  std::map<std::int64_t, Vectored> offered;
  for (const Vectored& span : history)
    for (const Pairing& pairing : proposed)
      if (pairing.matchSpanId == span.spanId) offered.emplace(span.spanId, span);

  if (proposed.empty()) {
    echoes_.replaceEchoes(user, page.day, CuratedEchoes{curator_.version(), {}, structural});
    outcome.status = CurationStatus::emptyOk;
    return outcome;
  }

  // 6 — curate. `ok == false` is a failed call, not the same as finding nothing.
  std::vector<Vectored> candidates;
  candidates.reserve(offered.size());
  for (const auto& [spanId, span] : offered) candidates.push_back(span);
  const Curation curation = curator_.curate(user, tonight, candidates, proposed);
  if (!curation.ok) {
    outcome.status = statusFor(curation.failure);
    outcome.error = curation.failure;
    // A refusal settles the page; this page's spans were replaced before the curator was asked.
    if (outcome.status == CurationStatus::refused) echoes_.clearEchoes(user, page.day);
    return outcome;
  }

  // 7 — persist what the curator kept.
  CuratedEchoes curated;
  curated.curatorVersion = curator_.version();
  curated.refused = structural;

  // The day collapse is forward-only, and persistence is additive — so a page that stored two echoes
  // into ONE past day before `maxPerMatchDay` existed would keep both rows forever, and the reader
  // would go on seeing two cards where the write side (a dismissal, a signal) has always addressed
  // one. The loser of a collapse is retracted, but ONLY once its day is actually represented: it is
  // a duplicate of a card that exists, not a pairing anybody refused, so retracting it while the
  // winner was itself rejected would quietly delete the day instead of deduplicating it.
  std::set<std::string> represented;
  for (const EchoRow& row : curated.rows) represented.insert(row.matchDay.iso());
  for (const TriggerTrace& trace : selection.traces)
    for (const CandidateNote& note : trace.notes)
      if (note.fate == Fate::sameDay && represented.count(note.day.iso()))
        curated.refused.push_back(SpanPair{trace.spanId, note.spanId});
  std::map<std::pair<std::int64_t, std::int64_t>, float> cosines;
  for (const Pairing& pairing : proposed)
    cosines[{pairing.triggerSpanId, pairing.matchSpanId}] = pairing.cosine;

  for (const Verdict& verdict : curation.verdicts) {
    // A refusal is recorded as well as a keep, or a stored pairing survives every later judgement.
    if (!verdict.related) {
      curated.refused.push_back(SpanPair{verdict.triggerSpanId, verdict.matchSpanId});
      continue;
    }
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
