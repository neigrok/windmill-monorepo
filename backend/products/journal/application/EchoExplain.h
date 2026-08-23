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

// What one page's derivation would do RIGHT NOW, and why — the whole of it, from the segmenter to
// the curator, with nothing persisted.
//
// Nothing here writes: no span row, no echo row, no curation stamp, no corpus stamp, so running it
// never settles a page and never robs the live path of a derivation it still owes. It is therefore
// not a rehearsal of persistence — it cannot tell you that storage would have failed.
//
// It DOES spend. The embedder is called for the page's passages every time; the curator only when
// the caller asks for it.
struct EchoExplanation {
  bool pageFound = false;
  std::string body;
  std::uint64_t bodyStampMs = 0;
  bool due = false;                     // would a save right now derive this page at all
  bool segmenterConfigured = false;
  bool embedderConfigured = false;
  bool curatorConfigured = false;
  std::string segmentVersion;
  std::string embedVersion;
  std::string curatorVersion;
  std::string error;                    // the embedder call failed; every field below is empty

  int corpus = 0;                       // passages stored under THIS embedding version
  int storedSpans = 0;                  // this page's own stored passages
  // The corpus minus this page — what retrieval is actually judged against. Read at the top of the
  // run, before any early return, so the count is never the answer to a question nobody asked.
  std::vector<Vectored> history;
  std::vector<Passage> passages;        // the idea units the segmenter cut the body into
  int unitsDiscarded = 0;               // units it proposed that are not in the body, so dropped
  bool unitsFromStorage = false;        // true: the stored units were reused, no vendor call made
  PageSelection selection;              // the traces — the same call a save runs
  std::vector<Verdict> verdicts;        // the curator's, when it was asked
  std::string curationFailure;          // and how the call failed, when it did
  std::vector<EchoView> persisted;      // what the page carries today, for comparison
};

// The knobs a caller may vary, so an operator can try a different threshold without a deploy.
// Defaults are the shipped policy, handed in by the composition root.
struct ExplainRequest {
  LocalDate day;
  SelectionRules rules;
  int echoesPerPage = 10;
  int nearest = 20;      // how many near misses to report per trigger; 0 buys none
  bool curate = false;   // ask the vendor too — the one part of this that costs money
  // Cut the page again rather than reading back the units storage already holds. Off by default: a
  // fresh cut is a second vendor call whose answer may differ from the stored one.
  bool recut = false;
};

class EchoExplainer {
public:
  EchoExplainer(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
                PageService& pages);

  EchoExplanation explain(const UserId& user, const ExplainRequest& request);

  // Off the request thread: an embed round trip plus a curator call is seconds long and drogon has
  // one handler thread per core.
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
