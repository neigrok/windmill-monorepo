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
// the curator, with nothing persisted. It exists because the shipped pipeline has one honest
// answer for a page that reaches back to nothing ("no echoes") and no way at all to say WHICH of
// nine rules said no, which makes every attempt to improve the algorithm a guess.
//
// Nothing here writes. No span row, no echo row, no curation stamp, no corpus stamp — so running
// it never settles a page and never robs the live path of a derivation it still owes. It is
// therefore also NOT a rehearsal of persistence: it cannot tell you that storage would have
// failed, only what the rules decided.
//
// It DOES spend. The embedder is called for the page's passages every time (that is the only way
// to have tonight's vectors without storing them), and the curator only when the caller asks for
// it — the one part of the pipeline that costs dollars rather than milliseconds.
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

// The knobs a caller may vary, so an operator can ask "and what if the restatement threshold were
// 0.99" without a deploy. Defaults are the shipped policy, handed in by the composition root.
struct ExplainRequest {
  LocalDate day;
  SelectionRules rules;
  int echoesPerPage = 10;
  int nearest = 20;      // how many near misses to report per trigger; 0 buys none
  bool curate = false;   // ask the vendor too — the one part of this that costs money
  // Cut the page again rather than reading back the units storage already holds. Off by default:
  // an explanation of what a page reaches TODAY should be read against the units it actually
  // carries, and a fresh cut is a second vendor call whose answer may differ from the stored one.
  bool recut = false;
};

class EchoExplainer {
public:
  EchoExplainer(EchoRepository& echoes, Segmenter& segmenter, Embedder& embedder, Curator& curator,
                PageService& pages);

  EchoExplanation explain(const UserId& user, const ExplainRequest& request);

  // Off the request thread, for the same reason the admin sweep is: an embed round trip plus a
  // curator call is seconds long and drogon has one handler thread per core.
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
