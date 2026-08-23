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

// A page owed a derivation. `attempts` is how many passes in a row have failed on it WITHOUT
// settling it; a refusal settles the page (`isSettled` below), so it never counts up here.
struct DuePage {
  LocalDate day;
  std::string body;
  std::uint64_t bodyStampMs = 0;
  int attempts = 0;
  // A body that moved has to be cut into idea units again, which is a vendor call; a corpus that
  // moved under an unchanged body reads its units back from storage. Never derived counts as moved.
  bool bodyMoved = true;
};

// Which pipeline derived a page: one derived by an older segmenter or embedder is stale in a way
// its own body and its own corpus cannot reveal. Two strings rather than one stamp — a moved
// segmenter means the page has to be CUT again, a moved embedder only that it is re-embedded.
struct PipelineVersions {
  std::string segment;
  std::string embed;
  // The curator's prompt and effort, plus a digest of the selection knobs — everything that decides
  // WHICH pairings are kept rather than how the page is cut or embedded.
  std::string judge;
};

// `spanId` of 0 means storage mints a fresh identity; anything else is one the caller carried
// forward. `passage` is exactly what segmentation produced, so [lo, hi) still indexes its body.
struct SpanWrite {
  std::int64_t spanId = 0;
  Passage passage;
  std::vector<float> vector;
};

// Storage resolves the pairs a reader has waved away through content hashes.
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

// The version rides the whole call because one curate call produced every row in it, and
// `Curator::version` already folds the prompt's digest into itself.
struct CuratedEchoes {
  std::string curatorVersion;
  std::vector<EchoRow> rows;
};

// `emptyOk` is a page that genuinely had nothing to reach back to — done, not owed a retry.
// Everything after it is a FAILURE and must never be stored as an empty result.
enum class CurationStatus { ok, emptyOk, transport, rateLimited, truncated, schemaInvalid, refused };

// Did the page get an answer it can keep? Only this decides what the reader is served.
inline bool isSuccess(CurationStatus status) {
  return status == CurationStatus::ok || status == CurationStatus::emptyOk;
}

// Is the page's pass OVER — the only question the stamps answer to. Success settles a page and so
// does a refusal, which is an answer ABOUT that text and the same answer every night. Both stamps
// advance, so a corpus moving under a refused page does not reopen it; only an edit to it does.
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
  // Recorded on a SETTLED pass and read back by the two due-ness queries; a failed pass leaves them.
  PipelineVersions versions;
};

// One echo as the reader's page receives it. Both passages travel as TEXT: the client re-locates the
// quote in the live body and shows it only if it is still there, so a redaction propagates without a
// delete reaching the browser. `daysEarlier` is measured from the trigger day, never from today.
//
// `matchOccurrenceHint` is WHICH occurrence of `matchText` the passage is, 0 for the first — not the
// byte offset storage holds, because C++ counts bytes and JavaScript slices UTF-16 code units. It
// stays a HINT: -1 says the server has nothing honest to offer, and the text check decides.
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

// `opened` is the walk back to the older page, `useful` is the reader saying so outright, and
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

// Which occurrence of `text` the passage sitting at byte offset `lo` is; -1 when no hit begins
// there. Server-side and client-side scans agree because the search is over whole occurrences of
// the same string, so bytes here and UTF-16 code units there land on the same one.
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

  // One named page, if it is owed anything. Nothing owed reads as nullopt.
  virtual std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                         std::uint64_t corpusStamp,
                                         const PipelineVersions& versions) = 0;

  // One page as it stands, owed anything or not: a page holding an echo into a page that just moved
  // is NOT due by any of duePages' questions yet has to be re-derived against text that still
  // exists. Nullopt is a day the writer has no page on.
  virtual std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) = 0;

  virtual std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) = 0;

  // Hands back exactly what it stored, minted ids and all, so a warm corpus can be UPDATED rather
  // than dropped when a page is re-derived.
  virtual std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                             const std::vector<SpanWrite>& spans,
                                             const std::string& embedVersion,
                                             std::uint64_t bodyStampMs) = 0;

  // The user's passages, without a single page body attached. One embedding version only: cosine
  // across two spaces is meaningless. AT MOST kCorpusSpans of them, the most recent, oldest-first.
  virtual std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) = 0;

  virtual std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) = 0;

  // One pairing, named the way the reader named it: two DAYS. Storage keys the dismissal on the two
  // passages' content, because an ordinal shifts the moment a sentence is inserted.
  virtual void dismissPair(const UserId& user, const LocalDate& triggerDay,
                           const LocalDate& matchDay) = 0;

  // "Not useful" is panel-level on the surface — one tap retires the whole page.
  virtual void dismissPage(const UserId& user, const LocalDate& triggerDay) = 0;

  // "Not now" — the reader declined the UPGRADE OFFER on this page; their echoes and their honest cut
  // are untouched. Keyed on the day: the offer belongs to the page, so re-deriving leaves it standing.
  virtual void dismissOffer(const UserId& user, const LocalDate& day) = 0;

  // Written beside the retrieval score and the curator's version. Idempotent: a button pressed twice
  // is one row, and a pairing with no echo row behind it records nothing.
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

  // The days in this range whose offer the reader already declined — one answer per PAGE.
  virtual std::vector<LocalDate> retiredOffers(const UserId& user, const LocalDate& from,
                                               const LocalDate& to) = 0;

  // How many pages the user has actually written on. The surface owes the reader nothing below a
  // ~20-page corpus floor.
  virtual int pagesWritten(const UserId& user) = 0;
};

}
