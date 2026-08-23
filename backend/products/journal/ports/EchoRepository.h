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
  // True re-cuts the body (a vendor call); false reads its units back from storage. Never derived
  // counts as moved.
  bool bodyMoved = true;
};

// A moved `segment` means the page has to be CUT again, a moved `embed` only re-embedded.
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
  // Persistence is additive: a pairing this pass did not raise is kept. `refused` is what it did
  // raise and the curator answered no — the only thing a pass removes.
  std::vector<SpanPair> refused;
};

// `emptyOk` is a page that genuinely had nothing to reach back to. Everything after it is a
// FAILURE and must never be stored as an empty result.
enum class CurationStatus { ok, emptyOk, transport, rateLimited, truncated, schemaInvalid, refused };

inline bool isSuccess(CurationStatus status) {
  return status == CurationStatus::ok || status == CurationStatus::emptyOk;
}

// A refusal settles the page like a success does: both stamps advance, so a corpus moving under a
// refused page does not reopen it; only an edit to it does.
inline bool isSettled(CurationStatus status) {
  return isSuccess(status) || status == CurationStatus::refused;
}

// Storage advances the two stamps only on a settled pass, so a failed night never costs a page its
// echoes.
struct CurationOutcome {
  CurationStatus status = CurationStatus::ok;
  std::uint64_t bodyStampMs = 0;
  std::uint64_t corpusStamp = 0;
  std::string error;
  PipelineVersions versions;
};

// Both passages travel as TEXT: the client re-locates the quote in the live body and shows it only
// if it is still there, so a redaction propagates without a delete reaching the browser.
// `daysEarlier` is measured from the trigger day, never from today. `matchOccurrenceHint` is WHICH
// occurrence of `matchText` the passage is, 0 for the first, and -1 says the server has nothing
// honest to offer — not a byte offset, because C++ counts bytes and JavaScript slices UTF-16.
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

// `notUseful` is a dismissal: the pair is retired AND it was wrong, recorded in two places.
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

// The comparison set's ceiling: 20,000 passages is ~30 MB of 384-dim float32 vectors held warm for
// one account. No page is refused for it, and nothing is deleted.
constexpr int kCorpusSpans = 20'000;

// Owner-scoped throughout. Entitlement is NOT asked here and not by the sweep: the READ layer
// decides how much of a passage a reader is handed.
struct EchoRepository {
  virtual ~EchoRepository() = default;

  virtual std::vector<EchoUser> activeSince(std::uint64_t sinceMs) = 0;

  // Read ONCE at the top of a pass and carried through it, or a page derived halfway records a
  // stamp covering spans it never saw.
  virtual std::uint64_t corpusStamp(const UserId& user) = 0;
  virtual std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp,
                                        const PipelineVersions& versions) = 0;

  // Nullopt when nothing is owed.
  virtual std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                         std::uint64_t corpusStamp,
                                         const PipelineVersions& versions) = 0;

  // One page as it stands, owed anything or not. Nullopt is a day the writer has no page on.
  virtual std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) = 0;

  // EVERY page this writer has, owed anything or not — the operator's re-judge. `bodyMoved` is
  // false throughout: a re-judge asks what tonight REACHES, never what it says, so no page is cut
  // again.
  virtual std::vector<DuePage> allPages(const UserId& user) = 0;

  virtual std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) = 0;

  // Hands back exactly what it stored, minted ids and all, so a warm corpus can be UPDATED rather
  // than dropped.
  virtual std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                             const std::vector<SpanWrite>& spans,
                                             const std::string& embedVersion,
                                             std::uint64_t bodyStampMs) = 0;

  // One embedding version only: cosine across two spaces is meaningless. AT MOST kCorpusSpans of
  // them, the most recent, oldest-first.
  virtual std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) = 0;

  virtual std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) = 0;

  // Keyed on the two passages' content, not an ordinal, which shifts the moment a sentence is
  // inserted.
  virtual void dismissPair(const UserId& user, const LocalDate& triggerDay,
                           const LocalDate& matchDay) = 0;

  // Panel-level: one tap retires the whole page.
  virtual void dismissPage(const UserId& user, const LocalDate& triggerDay) = 0;

  // Keyed on the day, so re-deriving leaves it standing.
  virtual void dismissOffer(const UserId& user, const LocalDate& day) = 0;

  // Idempotent: a button pressed twice is one row, and a pairing with no echo row behind it records
  // nothing.
  virtual void recordSignal(const UserId& user, const LocalDate& triggerDay,
                            const LocalDate& matchDay, EchoSignal kind) = 0;
  virtual void recordPageSignal(const UserId& user, const LocalDate& triggerDay,
                                EchoSignal kind) = 0;

  virtual void replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                             const CuratedEchoes& curated) = 0;

  // Everything this page reaches back to, gone. Under additive persistence `replaceEchoes` with an
  // empty set does not remove anything.
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
