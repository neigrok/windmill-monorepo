#include "products/journal/application/EchoExplain.h"

#include "products/journal/domain/Passage.h"
#include "products/journal/domain/SpanReconcile.h"

#include <trantor/utils/Logger.h>

#include <exception>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

EchoExplainer::EchoExplainer(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder,
                             Curator& curator, PageService& pages)
    : echoes_(echoes), segmenter_(segmenter), embedder_(embedder), curator_(curator), pages_(pages),
      heartbeat_("journal-echo-explain") {}

void EchoExplainer::explainAsync(const UserId& user, const ExplainRequest& request,
                                 std::function<void(EchoExplanation)> done) {
  heartbeat_.queue([this, user, request, done = std::move(done)] {
    // `done` fires on every path.
    try {
      done(explain(user, request));
    } catch (const std::exception& error) {
      LOG_ERROR << "journal echo explain failed: " << error.what();
      EchoExplanation failed;
      failed.error = error.what();
      done(failed);
    } catch (...) {
      EchoExplanation failed;
      failed.error = "explain failed";
      done(failed);
    }
  });
}

// A derivation with the two steps that write taken out. Step 3 does not store, so text this page
// does not already have carries a provisional negative id; storage mints only positives.
EchoExplanation EchoExplainer::explain(const UserId& user, const ExplainRequest& request) {
  EchoExplanation explained;
  explained.segmenterConfigured = segmenter_.configured();
  explained.segmentVersion = segmenter_.version();
  explained.embedderConfigured = embedder_.configured();
  explained.curatorConfigured = curator_.configured();
  explained.embedVersion = embedder_.version();
  explained.curatorVersion = curator_.version();
  explained.persisted = echoes_.echoesFor(user, request.day, request.day);

  const std::optional<Page> page = pages_.page(user, request.day);
  if (!page) return explained;
  explained.pageFound = true;
  explained.body = page->body;
  explained.bodyStampMs = page->updatedAtMs;

  // The judging half is the curator plus the selection knobs, spelled by the one function the sweep
  // records with: asked with the curator alone, this answer was `true` for every page ever.
  const std::uint64_t corpusStamp = echoes_.corpusStamp(user);
  explained.due =
      echoes_
          .duePage(user, request.day, corpusStamp,
                   PipelineVersions{segmenter_.version(), embedder_.version(),
                                    judgeVersion(curator_.version(), request.rules)})
          .has_value();

  // Read before anything can return early, so `corpus: 0` never means nobody looked.
  if (explained.embedderConfigured) {
    const std::vector<Vectored> corpus = echoes_.corpusOf(user, embedder_.version());
    explained.corpus = static_cast<int>(corpus.size());
    for (const Vectored& span : corpus)
      if (!(span.day == request.day)) explained.history.push_back(span);
  }

  // 1 — the idea units, read back from storage unless `recut`.
  const std::vector<StoredSpan> stored = echoes_.spansOf(user, request.day);
  explained.storedSpans = static_cast<int>(stored.size());
  if (!request.recut && !stored.empty()) {
    std::vector<std::string> texts;
    texts.reserve(stored.size());
    for (const StoredSpan& span : stored) texts.push_back(span.text);
    explained.passages = locateUnits(page->body, texts);
    explained.unitsFromStorage = true;
  } else if (explained.segmenterConfigured) {
    const Segmentation cut = segmenter_.unitsOf(user, page->body);
    explained.passages = cut.passages;
    explained.unitsDiscarded = cut.discarded;
    if (!cut.ok) explained.error = "segmenter: " + cut.failure;
  }
  if (!explained.embedderConfigured || explained.passages.empty()) return explained;

  // 2 — embed. The vendor call this door always pays for.
  std::vector<std::string> texts;
  texts.reserve(explained.passages.size());
  for (const Passage& passage : explained.passages) texts.push_back(passage.text);
  const std::vector<std::vector<float>> vectors = embedder_.embed(texts);
  if (vectors.size() != explained.passages.size()) {
    explained.error = "embedder returned " + std::to_string(vectors.size()) + " of " +
                      std::to_string(explained.passages.size());
    return explained;
  }

  // 3 — reconcile, without storing. This door always pays the embedder (step 2 above), so it does
  // not reuse stored vectors the way the sweep does: it exists to report what a derivation decides
  // right now, and a reused vector would report the last pass's answer instead.
  std::vector<KnownSpan> known;
  known.reserve(stored.size());
  for (const StoredSpan& span : stored) known.push_back(KnownSpan{span.spanId, span.text});
  const std::vector<IdentifiedPassage> carried = reconcile(known, explained.passages);
  std::vector<Vectored> tonight;
  std::int64_t provisional = 0;
  for (std::size_t i = 0; i < carried.size(); ++i)
    tonight.push_back(Vectored{carried[i].spanId != 0 ? carried[i].spanId : --provisional,
                               request.day, carried[i].passage.text, vectors[i]});

  // 4 — retrieve, from the corpus read at the top; this page's stored passages are held out.
  const std::vector<Vectored>& history = explained.history;

  std::set<std::pair<std::int64_t, std::int64_t>> waved;
  for (const SpanPair& pair : echoes_.dismissalsOn(user, request.day))
    waved.insert({pair.triggerSpanId, pair.matchSpanId});

  // 5 — select, asked for its reasons.
  explained.selection = selectForPage(tonight, history, waved, request.rules, request.echoesPerPage,
                                      request.nearest);

  // 6 — curate, only when asked.
  if (!request.curate || !explained.curatorConfigured || explained.selection.pairings.empty())
    return explained;

  std::map<std::int64_t, Vectored> offered;
  for (const Vectored& span : history)
    for (const Pairing& pairing : explained.selection.pairings)
      if (pairing.matchSpanId == span.spanId) offered.emplace(span.spanId, span);
  std::vector<Vectored> candidates;
  candidates.reserve(offered.size());
  for (const auto& [spanId, span] : offered) candidates.push_back(span);

  const Curation curation = curator_.curate(user, tonight, candidates,
                                            explained.selection.pairings);
  if (!curation.ok) explained.curationFailure = curation.failure;
  explained.verdicts = curation.verdicts;
  return explained;
}

}
