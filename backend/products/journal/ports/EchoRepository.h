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

// A candidate user for a repair pass: someone with recent page activity.
struct EchoUser {
  UserId user;
};

// A page owed a derivation — its body moved past what was last derived from it, or the corpus
// around it did. `attempts` is how many passes in a row have failed on this page WITHOUT settling
// it; a refusal settles the page (`isSettled` below), so it never counts up here.
struct DuePage {
  LocalDate day;
  std::string body;
  std::uint64_t bodyStampMs = 0;
  int attempts = 0;
  // WHICH of the three ways this page is owed a pass: a body that moved has to be cut into idea
  // units again, which is a vendor call; a corpus that moved under an unchanged body reads its
  // units back from storage and asks no segmenter. A page never derived counts as moved.
  bool bodyMoved = true;
};

// Which pipeline derived a page. Asked at the front of every pass: a page derived by an older
// segmenter or an older embedder is stale in a way its own body and its own corpus cannot reveal.
// Two strings rather than one stamp — a segmenter that moved means the page has to be CUT again,
// which is a vendor call; an embedder that moved means only the vectors are worthless, so the page
// is re-embedded and never re-cut.
struct PipelineVersions {
  std::string segment;
  std::string embed;
};

// A passage on its way to storage. `spanId` of 0 means storage mints a fresh identity; anything
// else is an identity the caller decided to carry forward. `passage` is exactly what segmentation
// produced, so [lo, hi) still indexes the body it came from.
struct SpanWrite {
  std::int64_t spanId = 0;
  Passage passage;
  std::vector<float> vector;
};

// Two passages named the way the pipeline holds them. Storage resolves the pairs a reader has
// waved away through content hashes.
struct SpanPair {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
};

// One kept pair on its way to storage.
struct EchoRow {
  std::int64_t triggerSpanId = 0;
  LocalDate matchDay;
  std::int64_t matchSpanId = 0;
  float cosine = 0.0f;
  float relation = 0.0f;
  bool matchIsSelf = true;
};

// One page's curation as it lands. The version rides the whole call because one curate call
// produced every row in it, and `Curator::version` already folds the prompt's digest into itself.
struct CuratedEchoes {
  std::string curatorVersion;
  std::vector<EchoRow> rows;
};

// How the last pass over a page ended. `emptyOk` is a page that genuinely had nothing to reach back
// to — done, not owed a retry; everything after it is a FAILURE and must never be stored as an
// empty result.
enum class CurationStatus { ok, emptyOk, transport, rateLimited, truncated, schemaInvalid, refused };

// Did the page get an answer it can keep? Only this decides what the reader is served.
inline bool isSuccess(CurationStatus status) {
  return status == CurationStatus::ok || status == CurationStatus::emptyOk;
}

// Is the page's pass OVER — the only question the stamps answer to. Success settles a page and so
// does a refusal: a refusal is an answer ABOUT that text and is the same answer every night, so
// retrying only re-bills it. Both stamps advance, so a corpus moving under a refused page does not
// reopen it; only the writer editing that body does.
inline bool isSettled(CurationStatus status) {
  return isSuccess(status) || status == CurationStatus::refused;
}

// What the pass derived from, and how it went. Storage advances the two stamps only on a settled
// pass, so a failed night never costs a page its echoes.
struct CurationOutcome {
  CurationStatus status = CurationStatus::ok;
  std::uint64_t bodyStampMs = 0;
  std::uint64_t corpusStamp = 0;
  std::string error;
  // Recorded on a SETTLED pass beside the stamps and read back by the two due-ness queries. A
  // failed pass leaves these where they were.
  PipelineVersions versions;
};

// One echo as the reader's page receives it. Both passages travel as TEXT: the client re-locates
// the quote in the live body and shows it only if it is still there, so a redaction propagates
// without a delete reaching the browser. `daysEarlier` is measured from the trigger day, never
// from today.
//
// `matchOccurrenceHint` is WHICH occurrence of `matchText` the passage is — 0 for the first in the
// match page's body — and it is what keeps a page saying the same sentence twice from anchoring to
// the wrong one. Deliberately not the byte offset storage holds: C++ counts bytes and JavaScript
// slices UTF-16 code units, so [lo, hi) parts company with anything a browser can use. It stays a
// HINT: -1 says the server has nothing honest to offer, and the text check decides.
//
// `markedUseful` is served rather than remembered by the device, so the next device knows it too.
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

// What a reader said about one pairing. `opened` is the walk back to the older page, `useful` is
// them saying so outright, and `notUseful` is a dismissal: the pair is retired AND it was wrong,
// two facts recorded in two places.
enum class EchoSignal { opened, useful, notUseful };

inline const char* signalText(EchoSignal kind) {
  switch (kind) {
    case EchoSignal::opened: return "opened";
    case EchoSignal::useful: return "useful";
    case EchoSignal::notUseful: return "not_useful";
  }
  return "opened";
}

// Which occurrence of `text` the passage sitting at byte offset `lo` is: scan from the start, step
// past each hit, stop at the one that begins where the passage does. -1 when no hit begins there.
// Server-side and client-side scans agree because the search is over whole occurrences of the same
// string, so bytes here and UTF-16 code units there land on the same one.
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
// one account. A bound on our cost — no page is refused for it, and nothing is deleted.
constexpr int kCorpusSpans = 20'000;

// Storage for the echo pipeline. Owner-scoped throughout. Entitlement is NOT asked here, and not by
// the sweep either: the sweep derives for everyone and the READ layer decides how much of a passage
// a reader is handed.
struct EchoRepository {
  virtual ~EchoRepository() = default;

  virtual std::vector<EchoUser> activeSince(std::uint64_t sinceMs) = 0;

  // The newest passage stamp anywhere in this user's corpus. Read ONCE at the top of a pass and
  // carried through it, or a page derived halfway records a stamp covering spans it never saw.
  virtual std::uint64_t corpusStamp(const UserId& user) = 0;
  virtual std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp,
                                        const PipelineVersions& versions) = 0;

  // One named page, if it is owed anything — the live path's opening move. It asks the same
  // questions duePages asks of one row instead of the user's shelf. Nothing owed reads as nullopt.
  virtual std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                         std::uint64_t corpusStamp,
                                         const PipelineVersions& versions) = 0;

  // One page as it stands, owed anything or not. The reverse edge needs it: a page holding an echo
  // into a page that just moved is NOT due by any of duePages' questions — its own body did not
  // move and its corpus stamp may be current — yet it has to be re-derived against text that still
  // exists. Nullopt is a day the writer has no page on.
  virtual std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) = 0;

  virtual std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) = 0;

  // Records the caller's identity decisions and hands back exactly what it stored, minted ids and
  // all, so a warm corpus can be UPDATED rather than dropped when a page is re-derived.
  virtual std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                             const std::vector<SpanWrite>& spans,
                                             const std::string& embedVersion,
                                             std::uint64_t bodyStampMs) = 0;

  // The user's passages, without a single page body attached. One embedding version only: cosine
  // across two spaces is meaningless, and nothing about it looks like an error. AT MOST
  // kCorpusSpans of them, the most recent, oldest-first — past that the oldest days can no longer
  // be echoed.
  virtual std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) = 0;

  virtual std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) = 0;

  // One pairing, named the way the reader named it: two DAYS. Storage resolves them to the span
  // pair and keys the dismissal on the two passages' content, because an ordinal shifts the moment
  // a sentence is inserted and would resurrect the retired echo.
  virtual void dismissPair(const UserId& user, const LocalDate& triggerDay,
                           const LocalDate& matchDay) = 0;

  // "Not useful" is panel-level on the surface — one tap retires the whole page — so it is one call
  // here rather than one per match.
  virtual void dismissPage(const UserId& user, const LocalDate& triggerDay) = 0;

  // "Not now" — the reader declined the UPGRADE OFFER on this page; their echoes and their honest
  // cut are untouched. Keyed on the day rather than a passage pair because the offer belongs to the
  // page, so re-deriving it leaves the answer standing.
  virtual void dismissOffer(const UserId& user, const LocalDate& day) = 0;

  // What the reader thought of a pairing, written beside the retrieval score and the curator's
  // version. Both are idempotent: a button pressed twice is one row. A pairing with no echo row
  // behind it records nothing.
  virtual void recordSignal(const UserId& user, const LocalDate& triggerDay,
                            const LocalDate& matchDay, EchoSignal kind) = 0;
  virtual void recordPageSignal(const UserId& user, const LocalDate& triggerDay,
                                EchoSignal kind) = 0;

  virtual void replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                             const CuratedEchoes& curated) = 0;
  virtual void recordCuration(const UserId& user, const LocalDate& day,
                              const CurationOutcome& outcome) = 0;

  // The trigger days holding an echo into this page. The caller budgets the walk across nights.
  virtual std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& matchDay) = 0;

  virtual std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                          const LocalDate& to) = 0;

  // The days in this range whose offer the reader already declined. Its own call rather than a flag
  // on EchoView: the answer is one per PAGE.
  virtual std::vector<LocalDate> retiredOffers(const UserId& user, const LocalDate& from,
                                               const LocalDate& to) = 0;

  // How many pages the user has actually written on. The surface owes the reader nothing below a
  // ~20-page corpus floor — no mark and no offer.
  virtual int pagesWritten(const UserId& user) = 0;
};

}
