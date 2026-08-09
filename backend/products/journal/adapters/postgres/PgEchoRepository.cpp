#include "products/journal/adapters/postgres/PgEchoRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/journal/domain/Passage.h"

#include <pqxx/pqxx>

#include <openssl/sha.h>

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <utility>

namespace wm {

namespace {
constexpr char kHexDigits[] = "0123456789abcdef";

std::string hexOf(const unsigned char* bytes, std::size_t count) {
  std::string hex(count * 2, '0');
  for (std::size_t at = 0; at < count; ++at) {
    hex[2 * at] = kHexDigits[bytes[at] >> 4];
    hex[2 * at + 1] = kHexDigits[bytes[at] & 0x0F];
  }
  return hex;
}

unsigned nibbleOf(char digit) {
  if (digit >= '0' && digit <= '9') return static_cast<unsigned>(digit - '0');
  if (digit >= 'a' && digit <= 'f') return static_cast<unsigned>(digit - 'a') + 10;
  if (digit >= 'A' && digit <= 'F') return static_cast<unsigned>(digit - 'A') + 10;
  return 0;
}

// A vector is four bytes per dimension, LITTLE-ENDIAN — the low byte of the IEEE-754 bit pattern
// first — shifted out a byte at a time rather than memcpy'd, so the bytes on disk are the same
// bytes on any host and a dump stays readable if we ever build somewhere big-endian.
//
// It travels as its own hex text with an explicit decode()/encode() at the SQL boundary, not as a
// bytea literal: that keeps the format independent of the server's bytea_output setting and off
// pqxx's binary readers entirely, which matters because the dev box is on libpqxx 8 and the CI
// image builds 7.10. Hex doubles the wire bytes against true binary (24.6 MB against 12.3 MB for
// a 8,000-passage corpus), and still costs a third of the 39.6 MB the float-array-through-::text
// dialect did, at roughly a thirtieth of the serialize and parse time. Binary results are an
// optimisation behind this function, never a schema change.
std::string hexOfVector(const std::vector<float>& vector) {
  std::string hex;
  hex.reserve(vector.size() * 8);
  for (const float value : vector) {
    const std::uint32_t bits = std::bit_cast<std::uint32_t>(value);
    for (int shift = 0; shift < 32; shift += 8) {
      const unsigned byte = (bits >> shift) & 0xFFu;
      hex += kHexDigits[byte >> 4];
      hex += kHexDigits[byte & 0x0F];
    }
  }
  return hex;
}

std::vector<float> vectorFrom(const std::string& hex) {
  std::vector<float> values;
  values.reserve(hex.size() / 8);
  for (std::size_t at = 0; at + 8 <= hex.size(); at += 8) {
    std::uint32_t bits = 0;
    for (int index = 0; index < 4; ++index) {
      const std::uint32_t byte =
          (nibbleOf(hex[at + 2 * index]) << 4) | nibbleOf(hex[at + 2 * index + 1]);
      bits |= byte << (8 * index);
    }
    values.push_back(std::bit_cast<float>(bits));
  }
  return values;
}

// The identity of a passage, digested. Normalised first — a dismissal keyed on raw text would be
// undone by a re-flowed line, and a dismissed echo coming back is the one failure this feature
// cannot afford.
std::string hashOf(const std::string& text) {
  const std::string identity = normalizedForIdentity(text);
  std::array<unsigned char, SHA256_DIGEST_LENGTH> digest{};
  SHA256(reinterpret_cast<const unsigned char*>(identity.data()), identity.size(), digest.data());
  return hexOf(digest.data(), digest.size());
}

std::string statusText(CurationStatus status) {
  switch (status) {
    case CurationStatus::ok: return "ok";
    case CurationStatus::emptyOk: return "empty_ok";
    case CurationStatus::transport: return "transport";
    case CurationStatus::rateLimited: return "rate_limited";
    case CurationStatus::truncated: return "truncated";
    case CurationStatus::schemaInvalid: return "schema_invalid";
    case CurationStatus::refused: return "refused";
  }
  return "transport";   // an unrecognised status reads as a failure, never as a page that is done
}

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build, so
// binding it concretely compiles on one and fails on the other.
//
// The anchoring hint is computed against the LIVE match body rather than read out of storage,
// which is what makes it worth sending: a passage whose page has been edited under it produces -1
// here and the client goes back to searching, instead of being handed a confident wrong sentence.
template <typename Row>
EchoView viewFrom(const Row& row, const std::string& matchBody) {
  std::string matchText = row["match_text"].template as<std::string>();
  const int occurrence = occurrenceAt(matchBody, matchText, row["match_lo"].template as<int>());
  return EchoView{
      LocalDate{row["trigger_day"].template as<std::string>()},
      row["trigger_span_id"].template as<std::int64_t>(),
      row["trigger_text"].template as<std::string>(),
      LocalDate{row["match_day"].template as<std::string>()},
      row["match_span_id"].template as<std::int64_t>(),
      std::move(matchText),
      row["match_is_self"].template as<bool>(),
      parseSource(row["match_source"].template as<std::string>()),
      row["days_earlier"].template as<int>(),
      occurrence,
      row["marked_useful"].template as<bool>()};
}
}

PgEchoRepository::PgEchoRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::vector<EchoUser> PgEchoRepository::activeSince(std::uint64_t sinceMs) {
  // The repair pass's candidate list: distinct owners of a recently-touched page. The join to
  // users earns its place on `deleted_at` alone — a soft-closed account never comes up, so its
  // echoes stop being computed the moment the grace period starts.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT DISTINCT p.user_id::text AS user_id "
      "FROM journal_page p JOIN users u ON u.id = p.user_id "
      "WHERE u.deleted_at IS NULL "
      "AND (extract(epoch from p.updated_at) * 1000)::bigint > $1",
      static_cast<long long>(sinceMs));

  std::vector<EchoUser> users;
  users.reserve(rows.size());
  for (const auto& row : rows) users.push_back(EchoUser{UserId{row["user_id"].as<std::string>()}});
  return users;
}

std::uint64_t PgEchoRepository::corpusStamp(const UserId& user) {
  // The corpus stamp IS the newest passage stamp the user has — no separate counter to bump and so
  // no way for one to drift out of step with the spans it claims to describe. A user with no spans
  // yet reads 0, which makes every page of theirs stale and is exactly right.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT coalesce(max(body_stamp_ms), 0)::bigint AS stamp FROM journal_span "
      "WHERE user_id = $1::uuid",
      user.str());
  return rows.empty() ? 0 : rows[0]["stamp"].as<std::uint64_t>();
}

std::vector<DuePage> PgEchoRepository::duePages(const UserId& user, std::uint64_t corpusStamp) {
  // Three ways to be owed a pass: never derived, a body that moved past the derivation, or a
  // corpus that moved past it. The third is what makes a backfill work — write "i like c++" in May,
  // add the January page in July, and the May page has to learn January exists even though its own
  // body never changed.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT p.day::text AS day, p.body, p.stamp_ms, coalesce(c.attempts, 0) AS attempts "
      "FROM journal_page p "
      "LEFT JOIN journal_page_curation c ON c.user_id = p.user_id AND c.day = p.day "
      "WHERE p.user_id = $1::uuid "
      "AND (c.day IS NULL OR c.body_stamp_ms < p.stamp_ms OR c.corpus_stamp < $2) "
      "ORDER BY p.day",
      user.str(), static_cast<long long>(corpusStamp));

  std::vector<DuePage> pages;
  pages.reserve(rows.size());
  for (const auto& row : rows)
    pages.push_back(DuePage{LocalDate{row["day"].as<std::string>()},
                            row["body"].as<std::string>(),
                            row["stamp_ms"].as<std::uint64_t>(),
                            row["attempts"].as<int>()});
  return pages;
}

std::optional<DuePage> PgEchoRepository::duePage(const UserId& user, const LocalDate& day,
                                                 std::uint64_t corpusStamp) {
  // The same three ways to be owed a pass as duePages, asked of one named row. The live path calls
  // this the moment a writer stops typing, so it is also the guard that makes a debounced second
  // save free: a page already derived against this body and this corpus is not due, and nothing
  // downstream of here is reached.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT p.day::text AS day, p.body, p.stamp_ms, coalesce(c.attempts, 0) AS attempts "
      "FROM journal_page p "
      "LEFT JOIN journal_page_curation c ON c.user_id = p.user_id AND c.day = p.day "
      "WHERE p.user_id = $1::uuid AND p.day = $2::date "
      "AND (c.day IS NULL OR c.body_stamp_ms < p.stamp_ms OR c.corpus_stamp < $3)",
      user.str(), day.iso(), static_cast<long long>(corpusStamp));

  if (rows.empty()) return std::nullopt;
  return DuePage{LocalDate{rows[0]["day"].as<std::string>()}, rows[0]["body"].as<std::string>(),
                 rows[0]["stamp_ms"].as<std::uint64_t>(), rows[0]["attempts"].as<int>()};
}

std::vector<KnownSpan> PgEchoRepository::spansOf(const UserId& user, const LocalDate& day) {
  // Ordered by ord because reconciliation matches duplicated text within a page in document order —
  // two identical lines have to keep two stable, distinct identities rather than collapse into one.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT span_id, text FROM journal_span "
      "WHERE user_id = $1::uuid AND day = $2::date ORDER BY ord",
      user.str(), day.iso());

  std::vector<KnownSpan> spans;
  spans.reserve(rows.size());
  for (const auto& row : rows)
    spans.push_back(KnownSpan{row["span_id"].as<std::int64_t>(), row["text"].as<std::string>()});
  return spans;
}

std::vector<Vectored> PgEchoRepository::replaceSpans(const UserId& user, const LocalDate& day,
                                                     const std::vector<SpanWrite>& spans,
                                                     const std::string& embedVersion,
                                                     std::uint64_t bodyStampMs) {
  // Delete then insert, in one transaction: a day's passages are always a complete set, and a
  // carried span_id is re-inserted under the identity the caller chose. Nothing here decides which
  // identities survive — that judgement is made in the domain and this only records it.
  //
  // No foreign key ties journal_echo to these rows, so an echo aimed at a passage that just died is
  // orphaned rather than deleted. It is invisible immediately (echoesFor inner-joins both spans) and
  // is swept when its own page is next derived, which the reverse edge is what schedules.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM journal_span WHERE user_id = $1::uuid AND day = $2::date",
                  user.str(), day.iso());

  // RETURNING, so the identity storage just minted travels back with the row rather than being
  // read for a second time. In ord order, which is the order corpusOf serves this page in — a warm
  // corpus splices this straight in and stays byte-identical to a fresh load.
  std::vector<Vectored> stored;
  stored.reserve(spans.size());
  for (const SpanWrite& span : spans) {
    pqxx::result rows = txn.exec_params(
        "INSERT INTO journal_span "
        "(user_id, span_id, day, ord, lo, hi, text, text_sha256, vector, embed_version, "
        "body_stamp_ms) "
        "VALUES ($1::uuid, coalesce(nullif($2::bigint, 0), nextval('journal_span_id_seq')), "
        "$3::date, $4, $5, $6, $7, decode($8, 'hex'), decode($9, 'hex'), $10, $11) "
        "RETURNING span_id",
        user.str(), static_cast<long long>(span.spanId), day.iso(), span.passage.ord,
        span.passage.lo, span.passage.hi, span.passage.text, hashOf(span.passage.text),
        hexOfVector(span.vector), embedVersion, static_cast<long long>(bodyStampMs));
    stored.push_back(Vectored{rows[0]["span_id"].as<std::int64_t>(), day, span.passage.text,
                              span.vector});
  }

  txn.commit();
  return stored;
}

std::vector<Vectored> PgEchoRepository::corpusOf(const UserId& user,
                                                 const std::string& embedVersion) {
  // The whole comparison set, and not one page body with it: the corpus load is the entire cost of
  // a night and a body is dead weight in it — the passage text is already here, and it is the only
  // text an echo may ever quote.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT span_id, day::text AS day, text, encode(vector, 'hex') AS vector "
      "FROM journal_span WHERE user_id = $1::uuid AND embed_version = $2 ORDER BY day, ord",
      user.str(), embedVersion);

  std::vector<Vectored> corpus;
  corpus.reserve(rows.size());
  for (const auto& row : rows)
    corpus.push_back(Vectored{row["span_id"].as<std::int64_t>(),
                              LocalDate{row["day"].as<std::string>()},
                              row["text"].as<std::string>(),
                              vectorFrom(row["vector"].as<std::string>())});
  return corpus;
}

std::vector<SpanPair> PgEchoRepository::dismissalsOn(const UserId& user,
                                                     const LocalDate& triggerDay) {
  // Dismissals are keyed on content, so this resolves them back into the span ids the pipeline is
  // holding. Text repeats: every span carrying dismissed text is dismissed, which is the whole
  // point of hashing rather than pinning to an id.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT st.span_id AS trigger_span_id, sm.span_id AS match_span_id "
      "FROM journal_span st "
      "JOIN journal_echo_dismissal d ON d.user_id = st.user_id AND d.trigger_hash = st.text_sha256 "
      "JOIN journal_span sm ON sm.user_id = d.user_id AND sm.text_sha256 = d.match_hash "
      "WHERE st.user_id = $1::uuid AND st.day = $2::date AND sm.day < $2::date",
      user.str(), triggerDay.iso());

  std::vector<SpanPair> pairs;
  pairs.reserve(rows.size());
  for (const auto& row : rows)
    pairs.push_back(SpanPair{row["trigger_span_id"].as<std::int64_t>(),
                             row["match_span_id"].as<std::int64_t>()});
  return pairs;
}

void PgEchoRepository::dismissPair(const UserId& user, const LocalDate& triggerDay,
                                   const LocalDate& matchDay) {
  // One pairing, in one statement, and the same shape as the panel door below with one more day in
  // the WHERE. Stored as the two passages' content, never as their ids, so the pair stays faded
  // across an edit, a re-segmentation and a segmenter version bump.
  //
  // Two days can name several pairings — a page with two passages both reaching into the same
  // January page is two rows — and the reader retiring "that match" means all of them. DISTINCT
  // because two spans can carry identical text and therefore identical hashes.
  //
  // Scoped by e.user_id and nothing else: a forged day reaches this caller's rows or no rows.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO journal_echo_dismissal (user_id, trigger_hash, match_hash) "
      "SELECT DISTINCT e.user_id, st.text_sha256, sm.text_sha256 "
      "FROM journal_echo e "
      "JOIN journal_span st ON st.user_id = e.user_id AND st.span_id = e.trigger_span_id "
      "JOIN journal_span sm ON sm.user_id = e.user_id AND sm.span_id = e.match_span_id "
      "WHERE e.user_id = $1::uuid AND e.trigger_day = $2::date AND e.match_day = $3::date "
      "ON CONFLICT DO NOTHING",
      user.str(), triggerDay.iso(), matchDay.iso());
  txn.commit();
}

void PgEchoRepository::dismissPage(const UserId& user, const LocalDate& triggerDay) {
  // The whole panel in one statement, on the same content hashes the pair-level door writes — a
  // position-keyed dismissal would resurrect itself the moment a sentence is inserted above it,
  // which is the failure this feature can least afford. DISTINCT because two spans on a page can
  // carry the same text and therefore the same hash pair; ON CONFLICT because pressing "Not useful"
  // twice has to be the same as pressing it once.
  //
  // Scoped by e.user_id and nothing else: a forged day reaches this caller's rows or no rows.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO journal_echo_dismissal (user_id, trigger_hash, match_hash) "
      "SELECT DISTINCT e.user_id, st.text_sha256, sm.text_sha256 "
      "FROM journal_echo e "
      "JOIN journal_span st ON st.user_id = e.user_id AND st.span_id = e.trigger_span_id "
      "JOIN journal_span sm ON sm.user_id = e.user_id AND sm.span_id = e.match_span_id "
      "WHERE e.user_id = $1::uuid AND e.trigger_day = $2::date "
      "ON CONFLICT DO NOTHING",
      user.str(), triggerDay.iso());
  txn.commit();
}

void PgEchoRepository::dismissOffer(const UserId& user, const LocalDate& day) {
  // One row per page, and it does not touch journal_echo at all — declining the offer retires the
  // ASKING, never the echoes. The reader keeps everything they had, including the honest cut; the
  // page just stops selling.
  //
  // Keyed on the day rather than on a passage hash, unlike both dismissal doors above, because the
  // offer belongs to the page and not to any pairing on it: re-derive the page and the answer still
  // stands. Aligning this with the other two would put the question back the moment a sentence
  // moved, which is the nagging the mission rule forbids.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO journal_echo_offer_dismissal (user_id, day) VALUES ($1::uuid, $2::date) "
      "ON CONFLICT DO NOTHING",
      user.str(), day.iso());
  txn.commit();
}

void PgEchoRepository::recordSignal(const UserId& user, const LocalDate& triggerDay,
                                    const LocalDate& matchDay, EchoSignal kind) {
  // The echo row is the source of every column here, which is what makes this a dataset rather
  // than a tally: the score that retrieved the pair and the model that judged it are copied in
  // beside the reader's answer, so a later question — did the 2026-08-09 swap to sonnet cost
  // precision? — is a GROUP BY rather than an archaeology dig. Copied and not joined at read time
  // on purpose: journal_echo is rewritten every night and would answer about tonight's curator,
  // not the one whose pairing the reader actually saw.
  //
  // ON CONFLICT DO NOTHING, so the first answer stands. Pressing a button twice is one row, and a
  // pairing this account never had is no row at all.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO journal_echo_signal (user_id, trigger_day, trigger_span_id, match_day, "
      "match_span_id, kind, cosine, relation, curator_version) "
      "SELECT e.user_id, e.trigger_day, e.trigger_span_id, e.match_day, e.match_span_id, $4::text, "
      "e.cosine, e.relation, e.curator_version "
      "FROM journal_echo e "
      "WHERE e.user_id = $1::uuid AND e.trigger_day = $2::date AND e.match_day = $3::date "
      "ON CONFLICT DO NOTHING",
      user.str(), triggerDay.iso(), matchDay.iso(), signalText(kind));
  txn.commit();
}

void PgEchoRepository::recordPageSignal(const UserId& user, const LocalDate& triggerDay,
                                        EchoSignal kind) {
  // The same answer about every pairing on a page, because the panel-level "Not useful" is one tap
  // about all of them. One statement for the same reason the panel dismissal is one: a page whose
  // signals half-landed is a page whose dataset quietly disagrees with its own dismissals.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "INSERT INTO journal_echo_signal (user_id, trigger_day, trigger_span_id, match_day, "
      "match_span_id, kind, cosine, relation, curator_version) "
      "SELECT e.user_id, e.trigger_day, e.trigger_span_id, e.match_day, e.match_span_id, $3::text, "
      "e.cosine, e.relation, e.curator_version "
      "FROM journal_echo e "
      "WHERE e.user_id = $1::uuid AND e.trigger_day = $2::date "
      "ON CONFLICT DO NOTHING",
      user.str(), triggerDay.iso(), signalText(kind));
  txn.commit();
}

void PgEchoRepository::replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                                     const CuratedEchoes& curated) {
  // Replace, additively. What goes is only what can no longer be shown — a row whose trigger or
  // match passage died with the last re-derivation. A row the curator simply did not return this
  // time is KEPT: the curator is not deterministic, and a typo fix must not silently destroy a
  // chain the reader has already walked. created_at survives an update for the same reason; an
  // echo re-affirmed tonight has been on the page since the night it was first found.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "DELETE FROM journal_echo e WHERE e.user_id = $1::uuid AND e.trigger_day = $2::date AND ("
      "NOT EXISTS (SELECT 1 FROM journal_span s "
      "WHERE s.user_id = e.user_id AND s.span_id = e.trigger_span_id) "
      "OR NOT EXISTS (SELECT 1 FROM journal_span s "
      "WHERE s.user_id = e.user_id AND s.span_id = e.match_span_id))",
      user.str(), triggerDay.iso());

  for (const EchoRow& echo : curated.rows)
    txn.exec_params(
        "INSERT INTO journal_echo (user_id, trigger_day, trigger_span_id, match_day, match_span_id, "
        "cosine, relation, match_is_self, curator_version) "
        "VALUES ($1::uuid, $2::date, $3, $4::date, $5, $6, $7, $8, $9) "
        "ON CONFLICT (user_id, trigger_span_id, match_span_id) DO UPDATE "
        "SET trigger_day = EXCLUDED.trigger_day, match_day = EXCLUDED.match_day, "
        "cosine = EXCLUDED.cosine, relation = EXCLUDED.relation, "
        "match_is_self = EXCLUDED.match_is_self, curator_version = EXCLUDED.curator_version",
        user.str(), triggerDay.iso(), static_cast<long long>(echo.triggerSpanId),
        echo.matchDay.iso(), static_cast<long long>(echo.matchSpanId), echo.cosine, echo.relation,
        echo.matchIsSelf, curated.curatorVersion);

  txn.commit();
}

void PgEchoRepository::recordCuration(const UserId& user, const LocalDate& day,
                                      const CurationOutcome& outcome) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};

  // A failed pass records WHAT failed and leaves both stamps exactly where they were, so the page
  // comes back as due on the next sweep. Advancing them here — the idiom the shipped vector path
  // used, where completion and success were the same thing — loses the page permanently to one
  // transient blip at 02:14.
  if (!isSuccess(outcome.status)) {
    txn.exec_params(
        "INSERT INTO journal_page_curation (user_id, day, status, attempts, last_error, updated_at) "
        "VALUES ($1::uuid, $2::date, $3, 1, $4, now()) "
        "ON CONFLICT (user_id, day) DO UPDATE "
        "SET status = EXCLUDED.status, attempts = journal_page_curation.attempts + 1, "
        "last_error = EXCLUDED.last_error, updated_at = now()",
        user.str(), day.iso(), statusText(outcome.status), outcome.error);
    txn.commit();
    return;
  }

  txn.exec_params(
      "INSERT INTO journal_page_curation "
      "(user_id, day, body_stamp_ms, corpus_stamp, status, attempts, last_error, updated_at) "
      "VALUES ($1::uuid, $2::date, $3, $4, $5, 0, '', now()) "
      "ON CONFLICT (user_id, day) DO UPDATE "
      "SET body_stamp_ms = EXCLUDED.body_stamp_ms, corpus_stamp = EXCLUDED.corpus_stamp, "
      "status = EXCLUDED.status, attempts = 0, last_error = '', updated_at = now()",
      user.str(), day.iso(), static_cast<long long>(outcome.bodyStampMs),
      static_cast<long long>(outcome.corpusStamp), statusText(outcome.status));
  txn.commit();
}

std::vector<LocalDate> PgEchoRepository::inboundPages(const UserId& user,
                                                      const LocalDate& matchDay) {
  // The reverse edge, served by journal_echo_inbound: which pages are reaching into this one, and
  // therefore have to be derived again now that its passages have moved.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT DISTINCT trigger_day::text AS day FROM journal_echo "
      "WHERE user_id = $1::uuid AND match_day = $2::date ORDER BY day",
      user.str(), matchDay.iso());

  std::vector<LocalDate> days;
  days.reserve(rows.size());
  for (const auto& row : rows) days.push_back(LocalDate{row["day"].as<std::string>()});
  return days;
}

std::vector<EchoView> PgEchoRepository::echoesFor(const UserId& user, const LocalDate& from,
                                                  const LocalDate& to) {
  // Both spans join INNER: an echo whose passage no longer exists is not a row to be filtered
  // later, it simply is not here. The dismissal check runs on content hashes rather than on ids,
  // which is what makes a waved-away pair stay away through an edit.
  //
  // Ordered trigger day, then position on the page, then match day — oldest match first. Read
  // top-down that list is reach ("this goes back to 2024"); newest-first the same rows read as
  // accumulation ("and again, and again"). Same data, opposite rhetoric.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};

  // The match pages' bodies, once each, so the anchoring hint can be counted against the page the
  // reader will actually walk back to. Its own query rather than a column on the one below: ten
  // echoes into one January page would otherwise ship that page's text ten times.
  pqxx::result bodyRows = txn.exec_params(
      "SELECT DISTINCT mp.day::text AS day, mp.body "
      "FROM journal_echo e "
      "JOIN journal_page mp ON mp.user_id = e.user_id AND mp.day = e.match_day "
      "WHERE e.user_id = $1::uuid AND e.trigger_day BETWEEN $2::date AND $3::date",
      user.str(), from.iso(), to.iso());

  std::map<std::string, std::string> bodies;
  for (const auto& row : bodyRows)
    bodies.emplace(row["day"].as<std::string>(), row["body"].as<std::string>());

  pqxx::result rows = txn.exec_params(
      "SELECT e.trigger_day::text AS trigger_day, e.trigger_span_id, st.text AS trigger_text, "
      "e.match_day::text AS match_day, e.match_span_id, sm.text AS match_text, sm.lo AS match_lo, "
      "e.match_is_self, mp.source AS match_source, "
      "(e.trigger_day - e.match_day) AS days_earlier, "
      // The reader's own answer, coming back to them. Served rather than remembered by the device:
      // a mark made on a laptop that a phone cannot see is a mark the phone will ask for again.
      "EXISTS (SELECT 1 FROM journal_echo_signal g WHERE g.user_id = e.user_id "
      "AND g.trigger_span_id = e.trigger_span_id AND g.match_span_id = e.match_span_id "
      "AND g.kind = 'useful') AS marked_useful "
      "FROM journal_echo e "
      "JOIN journal_span st ON st.user_id = e.user_id AND st.span_id = e.trigger_span_id "
      "JOIN journal_span sm ON sm.user_id = e.user_id AND sm.span_id = e.match_span_id "
      "JOIN journal_page mp ON mp.user_id = e.user_id AND mp.day = e.match_day "
      "WHERE e.user_id = $1::uuid AND e.trigger_day BETWEEN $2::date AND $3::date "
      "AND NOT EXISTS (SELECT 1 FROM journal_echo_dismissal d "
      "WHERE d.user_id = e.user_id AND d.trigger_hash = st.text_sha256 "
      "AND d.match_hash = sm.text_sha256) "
      "ORDER BY e.trigger_day, st.ord, e.match_day",
      user.str(), from.iso(), to.iso());

  std::vector<EchoView> echoes;
  echoes.reserve(rows.size());
  for (const auto& row : rows) {
    auto body = bodies.find(row["match_day"].as<std::string>());
    echoes.push_back(viewFrom(row, body == bodies.end() ? std::string{} : body->second));
  }
  return echoes;
}

std::vector<LocalDate> PgEchoRepository::retiredOffers(const UserId& user, const LocalDate& from,
                                                       const LocalDate& to) {
  // Which pages in view have already been answered with "not now", so the surface can decline to
  // ask again. A reader who never declined anything reads zero rows here, which is the whole cost.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT day::text AS day FROM journal_echo_offer_dismissal "
      "WHERE user_id = $1::uuid AND day BETWEEN $2::date AND $3::date ORDER BY day",
      user.str(), from.iso(), to.iso());

  std::vector<LocalDate> days;
  days.reserve(rows.size());
  for (const auto& row : rows) days.push_back(LocalDate{row["day"].as<std::string>()});
  return days;
}

int PgEchoRepository::pagesWritten(const UserId& user) {
  // Pages the user has actually written on — a row holding only whitespace is a page they opened,
  // not one they wrote. This is the number the ~20-page corpus floor is judged against, and the
  // reason it is served at all is that the browser cannot count what it has not synced.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT count(*)::int AS pages FROM journal_page "
      "WHERE user_id = $1::uuid AND btrim(body, E' \\t\\r\\n') <> ''",
      user.str());
  return rows.empty() ? 0 : rows[0]["pages"].as<int>();
}

}
