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
    // `done` fires on every path: an operator is waiting on a promise this thread cannot fulfil.
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

// The seven steps of a derivation with the two that write taken out, in the same order and through
// the same calls. Step 3 does not store, so the identities it carries forward are the real ones for
// text this page already has and PROVISIONAL NEGATIVE ones for text it does not — the sequence
// mints only positives, so a negative id can never be mistaken for a passage that exists.
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

  const std::uint64_t corpusStamp = echoes_.corpusStamp(user);
  explained.due =
      echoes_
          .duePage(user, request.day, corpusStamp,
                   PipelineVersions{segmenter_.version(), embedder_.version()})
          .has_value();

  // The corpus, read BEFORE anything can return early, so an empty page or an unwired embedder does
  // not answer `corpus: 0` when it means nobody looked.
  if (explained.embedderConfigured) {
    const std::vector<Vectored> corpus = echoes_.corpusOf(user, embedder_.version());
    explained.corpus = static_cast<int>(corpus.size());
    for (const Vectored& span : corpus)
      if (!(span.day == request.day)) explained.history.push_back(span);
  }

  // 1 — the idea units. Read back from storage by default, because what the page reaches today was
  // decided by the units it actually carries; `recut=true` buys a fresh cut.
  const std::vector<KnownSpan> stored = echoes_.spansOf(user, request.day);
  explained.storedSpans = static_cast<int>(stored.size());
  if (!request.recut && !stored.empty()) {
    std::vector<std::string> texts;
    texts.reserve(stored.size());
    for (const KnownSpan& span : stored) texts.push_back(span.text);
    explained.passages = locateUnits(page->body, texts);
    explained.unitsFromStorage = true;
  } else if (explained.segmenterConfigured) {
    const Segmentation cut = segmenter_.unitsOf(user, page->body);
    explained.passages = cut.passages;
    explained.unitsDiscarded = cut.discarded;
    if (!cut.ok) explained.error = "segmenter: " + cut.failure;
  }
  if (!explained.embedderConfigured || explained.passages.empty()) return explained;

  // 2 — embed. The vendor call this door always pays for: tonight's vectors exist nowhere else
  // unless the page has already been derived, and the stored ones describe the LAST body.
  std::vector<std::string> texts;
  texts.reserve(explained.passages.size());
  for (const Passage& passage : explained.passages) texts.push_back(passage.text);
  const std::vector<std::vector<float>> vectors = embedder_.embed(texts);
  if (vectors.size() != explained.passages.size()) {
    explained.error = "embedder returned " + std::to_string(vectors.size()) + " of " +
                      std::to_string(explained.passages.size());
    return explained;
  }

  // 3 — reconcile, without storing.
  const std::vector<IdentifiedPassage> carried = reconcile(stored, explained.passages);
  std::vector<Vectored> tonight;
  std::int64_t provisional = 0;
  for (std::size_t i = 0; i < carried.size(); ++i)
    tonight.push_back(Vectored{carried[i].spanId != 0 ? carried[i].spanId : --provisional,
                               request.day, carried[i].passage.text, vectors[i]});

  // 4 — retrieve, from the corpus read at the top. The page's own stored passages are held out,
  // because tonight's are the freshly embedded ones above.
  const std::vector<Vectored>& history = explained.history;

  std::set<std::pair<std::int64_t, std::int64_t>> waved;
  for (const SpanPair& pair : echoes_.dismissalsOn(user, request.day))
    waved.insert({pair.triggerSpanId, pair.matchSpanId});

  // 5 — select. The same domain call the sweep makes, asked for its reasons.
  explained.selection = selectForPage(tonight, history, waved, request.rules, request.echoesPerPage,
                                      request.nearest);

  // 6 — curate, only when asked. It is the one step here that bills.
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
