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

// A candidate user for a repair pass: someone with recent page activity. Nothing else — the email
// used to ride along so the sweep could ask billing whether to derive at all, and the entitlement
// gate has since moved to the read layer, so the sweep needs to know who and not one thing more.
struct EchoUser {
  UserId user;
};

// A page owed a derivation — its body moved past what was last derived from it, or the corpus
// around it did. It carries no `source`: segmentation is one deterministic function of the body
// (products/journal/domain/Passage.h), and a spoken page is segmented exactly like a typed one.
// ECHOES.md designs a separate spoken path and marks it as not built; when it is built, this is
// where the discriminator comes back. `attempts` is how many passes in a row have failed on this
// page WITHOUT settling it — a transport blip, a rate limit, the failures that clear on their own.
// A refusal is not one of them: it settles the page (`isSettled` below), so it never counts up
// here. Nothing backs off on this number yet.
struct DuePage {
  LocalDate day;
  std::string body;
  std::uint64_t bodyStampMs = 0;
  int attempts = 0;
};

// A passage on its way to storage. `spanId` of 0 means reconcile found no survivor for this text
// and storage mints a fresh identity; anything else is an identity the caller decided to carry
// forward, and storage only records that decision. `passage` is exactly what segmentation
// produced, so [lo, hi) still indexes the body it came from.
struct SpanWrite {
  std::int64_t spanId = 0;
  Passage passage;
  std::vector<float> vector;
};

// Two passages named the way the pipeline holds them. Used for the pairs a reader has waved away —
// the storage side resolves those through content hashes, so the sweep never has to know that
// dismissal is keyed on anything but the spans in front of it.
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

// One page's curation as it lands. The version rides the whole call rather than each row because
// one curate call produced every row in it — and it is one string and not two: `Curator::version`
// already folds the prompt's own digest into what it returns, so a second prompt-hash field beside
// it could only ever be the same fact written down twice or a contradiction.
struct CuratedEchoes {
  std::string curatorVersion;
  std::vector<EchoRow> rows;
};

// How the last pass over a page ended. `emptyOk` is a page that genuinely had nothing to reach
// back to — done, not owed a retry; everything after it is a FAILURE, and a failure must never be
// stored as an empty result, which would lose the page to a transient blip at 02:14.
enum class CurationStatus { ok, emptyOk, transport, rateLimited, truncated, schemaInvalid, refused };

// Did the page get an answer it can keep? Only this decides what the reader is served and what the
// report calls a derivation.
inline bool isSuccess(CurationStatus status) {
  return status == CurationStatus::ok || status == CurationStatus::emptyOk;
}

// Is the page's pass OVER — a different question, and the only one the stamps answer to. Success
// settles a page, and so does a refusal, which is the whole of the difference between the two
// predicates.
//
// A refusal is the one failure that will not clear on its own. The vendor declining to judge a body
// is an answer ABOUT that text, not a blip in front of it, and it is the same answer at 02:14
// tomorrow and every night after. Retried it re-bills, forever, a page that can never receive an
// echo — and the bodies that draw it are the heaviest ones a journal holds, so the loop would land
// hardest on exactly the pages nobody wants a machine grinding over. So a refusal ends the page at
// its current body. Both stamps advance, which means a corpus that moves under it does not reopen
// the question either; only the writer editing that body does, and then it is different text and a
// fair thing to ask again.
inline bool isSettled(CurationStatus status) {
  return isSuccess(status) || status == CurationStatus::refused;
}

// What the pass derived from, and how it went. The two stamps are the page's "I am done" record,
// and storage advances them only on a settled pass — the one rule that keeps a failed night from
// costing a page its echoes permanently.
struct CurationOutcome {
  CurationStatus status = CurationStatus::ok;
  std::uint64_t bodyStampMs = 0;
  std::uint64_t corpusStamp = 0;
  std::string error;
};

// One echo as the reader's page receives it. Both passages travel as TEXT: the client re-locates
// the quote in the live body and shows it only if it is still there, so a redaction propagates
// without a delete ever having to reach the browser. `daysEarlier` is measured from the trigger
// day, never from today: "212 days earlier" is true on every page, "212 days ago" is true only on
// tonight's.
//
// `matchOccurrenceHint` is WHICH occurrence of `matchText` the passage is — 0 for the first in the
// match page's body, 1 for the second — and it is the only thing that keeps a page saying "i don't
// know." twice from anchoring the quote to the wrong one. It is deliberately not the byte offset
// storage holds: C++ counts bytes and JavaScript slices UTF-16 code units, so [lo, hi) parts
// company with anything a browser can use at the first non-ASCII character, and a codepoint offset
// parts company again at the first emoji. An occurrence index has no encoding in it to disagree
// about. It stays a HINT and nothing more: -1 says the server has nothing honest to offer, and the
// text check — not this number — is what decides whether the quote is still there.
//
// `markedUseful` is the reader's own answer travelling back to them. It is served rather than
// remembered by the device for the same reason `offerRetired` is: an answer only one device knows
// about is an answer the next device ignores, and re-asking someone something they already told
// you is exactly what this product does not do.
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

// What a reader said about one pairing. `opened` is the walk back to the older page — the only
// clean positive label this feature gets for free, because the reader was pressing that button
// anyway. `useful` is them saying so outright, and `notUseful` is what a dismissal means: the pair
// is retired AND it was wrong, which are two different facts and are recorded in two places.
enum class EchoSignal { opened, useful, notUseful };

inline const char* signalText(EchoSignal kind) {
  switch (kind) {
    case EchoSignal::opened: return "opened";
    case EchoSignal::useful: return "useful";
    case EchoSignal::notUseful: return "not_useful";
  }
  return "opened";
}

// Which occurrence of `text` the passage sitting at byte offset `lo` is, counted the way a browser
// counts: scan from the start, step past each hit, stop at the one that begins where the passage
// does. -1 when no hit begins there — the body has moved under the passage since it was derived,
// and a number that names the wrong sentence is worse than no number at all.
//
// Server-side and client-side scans agree because neither is told about encoding: the search is
// over whole occurrences of the same string, so bytes here and UTF-16 code units there land on the
// same one.
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

// Storage for the echo pipeline. Owner-scoped throughout. Entitlement is NOT asked here, and it is
// not asked by the sweep either: the sweep derives for everyone and the READ layer decides how much
// of a passage a reader is handed. The canon's honest-cut state has to show a non-subscriber that
// echoes exist, how many and how far back, none of which survives an empty table.
//
// The seven steps of ECHOES.md read across this port in order: activeSince and duePages open a
// repair pass — duePage opens a live one, for the single page a writer just saved — spansOf and
// replaceSpans carry passage identity across a re-derivation, corpusOf feeds retrieval,
// dismissalsOn removes what the reader waved away, replaceEchoes and recordCuration close a page,
// and inboundPages is the reverse edge that keeps an edited page from silently killing every echo
// aimed at it. The last three serve the reader rather than the pass.
struct EchoRepository {
  virtual ~EchoRepository() = default;

  virtual std::vector<EchoUser> activeSince(std::uint64_t sinceMs) = 0;

  // The newest passage stamp anywhere in this user's corpus. Read ONCE at the top of a pass and
  // carried through it: a page derived halfway through would otherwise record a stamp covering
  // spans it never saw, and would never re-run against them.
  virtual std::uint64_t corpusStamp(const UserId& user) = 0;
  virtual std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp) = 0;

  // One named page, if it is owed anything — the live path's whole opening move. It asks the same
  // three questions duePages asks (never derived · body moved · corpus moved) of one row instead of
  // the user's shelf, because a writer's save names its own page and scanning the rest of the
  // journal to find it back would make the cheap trigger the expensive one. Nothing owed reads as
  // nullopt, which is how a debounced second save costs nothing at all.
  virtual std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                         std::uint64_t corpusStamp) = 0;

  // Ordered by ord — reconcile matches duplicated text within a page in document order, so the
  // order this returns in is part of the contract, not a convenience.
  virtual std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) = 0;

  // Records the caller's identity decisions and hands back exactly what it stored, minted ids and
  // all. The return value is not a convenience: it is what lets a warm corpus be UPDATED rather
  // than dropped when a page is re-derived. Every derivation writes its own page's spans, so a
  // cache that could only invalidate would throw the corpus away on every single pass and never be
  // warm for anyone — the one call that changes the corpus is also the one that can describe the
  // change exactly.
  virtual std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                             const std::vector<SpanWrite>& spans,
                                             const std::string& embedVersion,
                                             std::uint64_t bodyStampMs) = 0;

  // Every passage the user has, without a single page body attached — the corpus load is the whole
  // cost of a night and a body is dead weight in it. One embedding version only: cosine across two
  // spaces is not degraded, it is meaningless, and nothing about it looks like an error.
  virtual std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) = 0;

  virtual std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) = 0;

  // One pairing, named the way the reader named it: two DAYS. Storage resolves them to the span
  // pair and keys the dismissal on the two passages' content, because an ordinal shifts the moment
  // a sentence is inserted and a position-keyed dismissal would resurrect the very echo that was
  // retired. This used to take span ids and the edge resolved them by reading the whole page back
  // through echoesFor — one call per match, recomputing anchoring hints it then threw away.
  virtual void dismissPair(const UserId& user, const LocalDate& triggerDay,
                           const LocalDate& matchDay) = 0;

  // "Not useful" is panel-level on the surface — one tap retires the whole page — so it is one
  // call here. Nine calls for nine matches is nine chances to half-succeed, and a page left half
  // faded is a page that comes back tomorrow still carrying the thing the reader waved away.
  virtual void dismissPage(const UserId& user, const LocalDate& triggerDay) = 0;

  // "Not now" — the reader declined the UPGRADE OFFER on this page. A different gesture entirely
  // from the two above: their echoes and their honest cut are untouched, the page just stops
  // selling. Keyed on the day rather than a passage pair BECAUSE the offer belongs to the page and
  // not to any pairing on it — re-derive the page and the answer still stands, which a content hash
  // would not survive. Nobody should later align this with the other two doors.
  virtual void dismissOffer(const UserId& user, const LocalDate& day) = 0;

  // What the reader thought of a pairing, kept so the feature can eventually be measured rather
  // than believed. Written beside the retrieval score and the curator's version — the row is a
  // dataset only because those ride with it, and it is the only way to answer whether the
  // 2026-08-09 model swap cost precision. Both are idempotent: a button pressed twice is one row.
  //
  // A pairing with no echo row behind it records nothing. There is no signal to keep about a
  // pairing this account never had, and forging days therefore buys a caller an empty insert.
  virtual void recordSignal(const UserId& user, const LocalDate& triggerDay,
                            const LocalDate& matchDay, EchoSignal kind) = 0;
  virtual void recordPageSignal(const UserId& user, const LocalDate& triggerDay,
                                EchoSignal kind) = 0;

  virtual void replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                             const CuratedEchoes& curated) = 0;
  virtual void recordCuration(const UserId& user, const LocalDate& day,
                              const CurationOutcome& outcome) = 0;

  // The trigger days holding an echo into this page. Budget the walk: a three-hundred-page cleanup
  // pass has to drain over several nights rather than bill in one.
  virtual std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& matchDay) = 0;

  virtual std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                          const LocalDate& to) = 0;

  // The days in this range whose offer the reader already declined. Its own call rather than a flag
  // on EchoView: the answer is one per PAGE, and hanging it off every echo row would invite a
  // future where two rows on one page disagree about it.
  virtual std::vector<LocalDate> retiredOffers(const UserId& user, const LocalDate& from,
                                               const LocalDate& to) = 0;

  // How many pages the user has actually written on. The surface owes the reader nothing below a
  // ~20-page corpus floor — no mark and no offer — and a journal with nothing to reach back into
  // must not advertise reaching back. Only the server can count that, so only the server may say it.
  virtual int pagesWritten(const UserId& user) = 0;
};

}
