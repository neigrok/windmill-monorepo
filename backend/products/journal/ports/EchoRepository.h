#pragma once

#include "platform/domain/Auth.h"
#include "products/journal/domain/EchoSelection.h"
#include "products/journal/domain/SpanReconcile.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

struct EchoUser {
  UserId user;
};

// `attempts` counts consecutive failures that did not settle the page; a refusal settles.
struct DuePage {
  LocalDate day;
  std::string body;
  std::uint64_t bodyStampMs = 0;
  int attempts = 0;
  // True re-cuts the body (a vendor call); false reads its units back from storage. A page never
  // derived is true.
  bool bodyMoved = true;
};

// A moved `segment` means the page is cut again; a moved `embed` only re-embedded.
struct PipelineVersions {
  std::string segment;
  std::string embed;
  // The curator's prompt and effort, plus a digest of the selection knobs.
  std::string judge;
};

// `spanId` of 0 means storage mints a fresh identity. `passage` is what segmentation produced, so
// [lo, hi) still indexes its body.
struct SpanWrite {
  std::int64_t spanId = 0;
  Passage passage;
  std::vector<float> vector;
};

struct SpanPair {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
};

struct EchoRow {
  std::int64_t triggerSpanId = 0;
  LocalDate matchDay;
  std::int64_t matchSpanId = 0;
  float cosine = 0.0f;
  float relation = 0.0f;
  bool matchIsSelf = true;
};

struct CuratedEchoes {
  std::string curatorVersion;
  std::vector<EchoRow> rows;
  // Persistence is additive: a pairing this pass did not raise is kept. `refused` is what it raised
  // and the curator answered no, and is all a pass removes.
  std::vector<SpanPair> refused;
};

// `emptyOk` is a page that had nothing to reach back to. Everything after it is a failure and must
// never be stored as an empty result.
enum class CurationStatus { ok, emptyOk, transport, rateLimited, truncated, schemaInvalid, refused };

inline bool isSuccess(CurationStatus status) {
  return status == CurationStatus::ok || status == CurationStatus::emptyOk;
}

// A refusal settles like a success: both stamps advance, so only an edit reopens the page.
inline bool isSettled(CurationStatus status) {
  return isSuccess(status) || status == CurationStatus::refused;
}

// Storage advances the two stamps only on a settled pass. An UNSETTLED pass still records the
// version strings it earned — a page whose cut and embed landed and whose curate then died has that
// work in storage, and forgetting it means buying the same vendor call again every six hours.
struct CurationOutcome {
  CurationStatus status = CurationStatus::ok;
  std::uint64_t bodyStampMs = 0;
  std::uint64_t corpusStamp = 0;
  std::string error;
  PipelineVersions versions;
};

// Both passages travel as text; the client re-locates the quote in the live body and shows it only
// if it is still there. `daysEarlier` is measured from the trigger day, never from today.
// `matchOccurrenceHint` is which occurrence of `matchText` the passage is, 0 for the first, -1 for
// unknown — an occurrence index, not a byte offset.
struct EchoView {
  LocalDate triggerDay;
  std::int64_t triggerSpanId = 0;
  std::string triggerText;
  LocalDate matchDay;
  std::int64_t matchSpanId = 0;
  std::string matchText;
  bool matchIsSelf = true;
  Source matchSource = Source::typed;
  int daysEarlier = 0;
  int matchOccurrenceHint = -1;
  bool markedUseful = false;
};

// `notUseful` retires the pair and records it as wrong.
enum class EchoSignal { opened, useful, notUseful };

inline const char* signalText(EchoSignal kind) {
  switch (kind) {
    case EchoSignal::opened: return "opened";
    case EchoSignal::useful: return "useful";
    case EchoSignal::notUseful: return "not_useful";
  }
  return "opened";
}

// Which occurrence of `text` the passage sitting at byte offset `lo` is; -1 when no hit begins there.
inline int occurrenceAt(const std::string& body, const std::string& text, int lo) {
  if (text.empty() || lo < 0) return -1;
  int occurrence = 0;
  for (std::size_t at = body.find(text); at != std::string::npos;
       at = body.find(text, at + text.size())) {
    if (static_cast<int>(at) == lo) return occurrence;
    if (static_cast<int>(at) > lo) return -1;
    ++occurrence;
  }
  return -1;
}

// Ceiling on the comparison set held warm for one account; no page is refused for it.
// HOW MANY TIMES A PAGE MAY FAIL BEFORE IT IS LEFT ALONE. An unsettled pass leaves the page due, so
// without a bound a page that fails for a reason nothing will fix — a body the embedder cannot read,
// a vendor that dislikes it — is re-derived on every pass forever, buying a segmenter call each time
// and producing nothing. `attempts` counts consecutive unsettled passes and existed for exactly this
// and was read by nobody. Editing the body resets it, because that is a different page.
constexpr int kCurationRetries = 6;

constexpr int kCorpusSpans = 20'000;

// Owner-scoped throughout. Entitlement is decided by the read layer, not here and not by the sweep.
struct EchoRepository {
  virtual ~EchoRepository() = default;

  virtual std::vector<EchoUser> activeSince(std::uint64_t sinceMs) = 0;

  // A FINGERPRINT of this writer's passages, not a clock — compare it for SAMENESS and never for
  // order. It was max(body_stamp_ms), which is monotone only while a corpus GROWS: emptying a page
  // removes its spans and can LOWER the max, so `corpus_stamp < stored` never fired and a corpus
  // that shrank under every page reopened none of them. (Not hypothetical — the owner's page went
  // from fifty bytes to empty on the day this was found.) Read once at the top of a pass and
  // carried through it, so a page derived halfway cannot record a stamp covering spans it never saw.
  virtual std::uint64_t corpusStamp(const UserId& user) = 0;
  virtual std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp,
                                        const PipelineVersions& versions) = 0;

  // Nullopt when nothing is owed.
  virtual std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                         std::uint64_t corpusStamp,
                                         const PipelineVersions& versions) = 0;

  // One page as it stands, owed anything or not; nullopt when there is no page that day.
  virtual std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) = 0;

  // Every page this writer has, owed anything or not. `bodyMoved` is false throughout: no page is
  // cut again.
  virtual std::vector<DuePage> allPages(const UserId& user) = 0;

  virtual std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) = 0;

  // Returns exactly what it stored, minted ids and all.
  virtual std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                             const std::vector<SpanWrite>& spans,
                                             const std::string& embedVersion,
                                             std::uint64_t bodyStampMs) = 0;

  // One embedding version only. At most kCorpusSpans, the most recent, oldest-first.
  virtual std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) = 0;

  virtual std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) = 0;

  // Keyed on the two passages' content, not on span ids.
  virtual void dismissPair(const UserId& user, const LocalDate& triggerDay,
                           const LocalDate& matchDay) = 0;

  // Retires the whole page.
  virtual void dismissPage(const UserId& user, const LocalDate& triggerDay) = 0;

  // Keyed on the day, so re-deriving leaves it standing.
  virtual void dismissOffer(const UserId& user, const LocalDate& day) = 0;

  // Idempotent; a pairing with no echo row behind it records nothing.
  virtual void recordSignal(const UserId& user, const LocalDate& triggerDay,
                            const LocalDate& matchDay, EchoSignal kind) = 0;
  virtual void recordPageSignal(const UserId& user, const LocalDate& triggerDay,
                                EchoSignal kind) = 0;

  virtual void replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                             const CuratedEchoes& curated) = 0;

  // Removes everything this page reaches back to; `replaceEchoes` with an empty set does not.
  virtual void clearEchoes(const UserId& user, const LocalDate& triggerDay) = 0;
  virtual void recordCuration(const UserId& user, const LocalDate& day,
                              const CurationOutcome& outcome) = 0;

  // The trigger days holding an echo into this page.
  virtual std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& matchDay) = 0;

  virtual std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                          const LocalDate& to) = 0;

  // One answer per PAGE.
  virtual std::vector<LocalDate> retiredOffers(const UserId& user, const LocalDate& from,
                                               const LocalDate& to) = 0;

  virtual int pagesWritten(const UserId& user) = 0;
};

}
