#pragma once

#include "platform/application/Heartbeat.h"
#include "products/journal/application/PageService.h"
#include "products/journal/domain/EchoSelection.h"
#include "products/journal/ports/Curator.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/Embedder.h"
#include "products/journal/ports/Segmenter.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace wm {

// What one page's derivation would do now, from segmenter to curator, with nothing persisted: no
// span row, no echo row, no curation stamp, no corpus stamp. It does spend — the embedder is called
// every time, the curator only when the caller asks.
struct EchoExplanation {
  bool pageFound = false;
  std::string body;
  std::uint64_t bodyStampMs = 0;
  // Would a save right now derive this page at all — asked with the pipeline identity the sweep
  // records, this request's selection rules folded into the judging half like the sweep folds its own.
  bool due = false;
  bool segmenterConfigured = false;
  bool embedderConfigured = false;
  bool curatorConfigured = false;
  std::string segmentVersion;
  std::string embedVersion;
  std::string curatorVersion;
  std::string error;                    // the embedder call failed; every field below is empty

  int corpus = 0;                       // passages stored under THIS embedding version
  int storedSpans = 0;                  // this page's own stored passages
  std::vector<Vectored> history;        // the corpus minus this page
  std::vector<Passage> passages;        // the idea units the segmenter cut the body into
  int unitsDiscarded = 0;               // units it proposed that are not in the body, so dropped
  bool unitsFromStorage = false;        // true: the stored units were reused, no vendor call made
  PageSelection selection;              // the traces — the same call a save runs
  std::vector<Verdict> verdicts;        // the curator's, when it was asked
  std::string curationFailure;          // and how the call failed, when it did
  std::vector<EchoView> persisted;      // what the page carries today, for comparison
};

// Defaults are the shipped policy, handed in by the composition root.
struct ExplainRequest {
  LocalDate day;
  SelectionRules rules;
  int echoesPerPage = 10;
  int nearest = 20;      // how many near misses to report per trigger; 0 buys none
  bool curate = false;   // ask the vendor too
  bool recut = false;    // cut the page again instead of reading back the stored units
};

class EchoExplainer {
public:
  EchoExplainer(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
                PageService& pages);

  EchoExplanation explain(const UserId& user, const ExplainRequest& request);

  // Off the request thread: an embed round trip plus a curator call is seconds long.
  void explainAsync(const UserId& user, const ExplainRequest& request,
                    std::function<void(EchoExplanation)> done);

private:
  EchoRepository& echoes_;
  Segmenter& segmenter_;
  Embedder& embedder_;
  Curator& curator_;
  PageService& pages_;
  Heartbeat heartbeat_;   // declared last: destructs first, before the deps a running call holds
};

}
