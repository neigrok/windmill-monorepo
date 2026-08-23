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

// Four bytes per dimension, little-endian — the low byte of the IEEE-754 bit pattern first — shifted
// out a byte at a time rather than memcpy'd. It travels as hex text with an explicit
// decode()/encode() at the SQL boundary, off the server's bytea_output setting and off pqxx's binary
// readers, which differ between the dev box and CI.
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

// Normalised first: a dismissal keyed on raw text would be undone by a re-flowed line.
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

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build. The
// anchoring hint is computed against the live match body, so a passage whose page was edited under
// it produces -1 and the client goes back to searching.
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
  // The join to users is for `deleted_at` alone: a soft-closed account never comes up.
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
  // A FINGERPRINT of the comparison set, compared for sameness and never for order. It used to be
  // max(body_stamp_ms), which cannot answer the question: emptying a page takes its passages away,
  // and the max over what survives only ever falls, so a corpus that SHRANK moved under every page
  // without one of them reading as stale. No aggregate over the surviving rows can rise on both an
  // insert and a delete, so the ordering went rather than the truth: the due queries ask
  // `IS DISTINCT FROM`, and any change in identity, body stamp, embedding space or text moves this.
  // Sixty bits, so it is never negative. A user with no spans reads 0, which makes every page of
  // theirs stale. Re-deriving a page into the same passages leaves it alone — that is what keeps a
  // pass from reopening every other page of the account.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT coalesce(('x' || substr(md5(string_agg("
      "  span_id::text || ':' || body_stamp_ms::text || ':' || embed_version || ':' || "
      "  encode(text_sha256, 'hex'), ',' ORDER BY span_id)), 1, 15))::bit(60)::bigint, 0) AS stamp "
      "FROM journal_span WHERE user_id = $1::uuid",
      user.str());
  return rows.empty() ? 0 : rows[0]["stamp"].as<std::uint64_t>();
}

std::vector<DuePage> PgEchoRepository::duePages(const UserId& user, std::uint64_t corpusStamp,
                                                const PipelineVersions& versions) {
  // Five ways to be owed a pass: never derived, a moved body, a moved corpus, a moved pipeline, and
  // a last pass that did not settle. That last one is load-bearing rather than belt and braces: an
  // unsettled pass now records the versions of the steps it did finish, so every version clause can
  // match a page the curator never judged. A page the vendor refused is not reopened by a moved
  // corpus alone. The status literals must stay in step with the ones `statusText` writes.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT p.day::text AS day, p.body, p.stamp_ms, coalesce(c.attempts, 0) AS attempts, "
      // The page is cut again unless storage already holds passages cut from THIS body by THIS
      // segmenter; a moved embedder alone does not buy the segmenter again. The curation row cannot
      // answer it, because a pass that stored the cut and then failed at the curator leaves that
      // row's body stamp behind — and reading it would buy the same cut again every six hours.
      "(NOT EXISTS (SELECT 1 FROM journal_span s WHERE s.user_id = p.user_id AND s.day = p.day "
      "                                          AND s.body_stamp_ms = p.stamp_ms) "
      "     OR c.segment_version IS DISTINCT FROM $3) AS body_moved "
      "FROM journal_page p "
      "LEFT JOIN journal_page_curation c ON c.user_id = p.user_id AND c.day = p.day "
      "WHERE p.user_id = $1::uuid "
      "AND (c.day IS NULL OR c.body_stamp_ms < p.stamp_ms "
      "     OR (c.corpus_stamp IS DISTINCT FROM $2 AND c.status <> 'refused') "
      // A pipeline change reopens even a refused page.
      "     OR c.segment_version IS DISTINCT FROM $3 "
      "     OR c.embed_version IS DISTINCT FROM $4 "
      "     OR c.judge_version IS DISTINCT FROM $5 "
      "     OR (c.status NOT IN ('ok', 'empty_ok', 'refused') AND coalesce(c.attempts, 0) < " +
          std::to_string(kCurationRetries) + ")) "
      "ORDER BY p.day",
      user.str(), static_cast<long long>(corpusStamp), versions.segment, versions.embed,
      versions.judge);

  std::vector<DuePage> pages;
  pages.reserve(rows.size());
  for (const auto& row : rows)
    pages.push_back(DuePage{LocalDate{row["day"].as<std::string>()},
                            row["body"].as<std::string>(),
                            row["stamp_ms"].as<std::uint64_t>(),
                            row["attempts"].as<int>(),
                            row["body_moved"].as<bool>()});
  return pages;
}

std::optional<DuePage> PgEchoRepository::duePage(const UserId& user, const LocalDate& day,
                                                 std::uint64_t corpusStamp,
                                                 const PipelineVersions& versions) {
  // The same conditions duePages asks, of one named row, refusal and unsettled clauses included.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT p.day::text AS day, p.body, p.stamp_ms, coalesce(c.attempts, 0) AS attempts, "
      "(NOT EXISTS (SELECT 1 FROM journal_span s WHERE s.user_id = p.user_id AND s.day = p.day "
      "                                          AND s.body_stamp_ms = p.stamp_ms) "
      "     OR c.segment_version IS DISTINCT FROM $4) AS body_moved "
      "FROM journal_page p "
      "LEFT JOIN journal_page_curation c ON c.user_id = p.user_id AND c.day = p.day "
      "WHERE p.user_id = $1::uuid AND p.day = $2::date "
      "AND (c.day IS NULL OR c.body_stamp_ms < p.stamp_ms "
      "     OR (c.corpus_stamp IS DISTINCT FROM $3 AND c.status <> 'refused') "
      "     OR c.segment_version IS DISTINCT FROM $4 "
      "     OR c.embed_version IS DISTINCT FROM $5 "
      "     OR c.judge_version IS DISTINCT FROM $6 "
      "     OR (c.status NOT IN ('ok', 'empty_ok', 'refused') AND coalesce(c.attempts, 0) < " +
          std::to_string(kCurationRetries) + "))",
      user.str(), day.iso(), static_cast<long long>(corpusStamp), versions.segment,
      versions.embed, versions.judge);

  if (rows.empty()) return std::nullopt;
  return DuePage{LocalDate{rows[0]["day"].as<std::string>()}, rows[0]["body"].as<std::string>(),
                 rows[0]["stamp_ms"].as<std::uint64_t>(), rows[0]["attempts"].as<int>(),
                 rows[0]["body_moved"].as<bool>()};
}

std::optional<DuePage> PgEchoRepository::pageAt(const UserId& user, const LocalDate& day) {
  // No due-ness clause: the reverse edge walks to pages owed nothing and needs their text anyway.
  // `bodyMoved` is false, since this page's own units still stand.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT p.body, p.stamp_ms, coalesce(c.attempts, 0) AS attempts "
      "FROM journal_page p "
      "LEFT JOIN journal_page_curation c ON c.user_id = p.user_id AND c.day = p.day "
      "WHERE p.user_id = $1::uuid AND p.day = $2::date",
      user.str(), day.iso());

  if (rows.empty()) return std::nullopt;
  return DuePage{day, rows[0]["body"].as<std::string>(), rows[0]["stamp_ms"].as<std::uint64_t>(),
                 rows[0]["attempts"].as<int>(), false};
}

std::vector<DuePage> PgEchoRepository::allPages(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT p.day::text AS day, p.body, p.stamp_ms, coalesce(c.attempts, 0) AS attempts "
      "FROM journal_page p "
      "LEFT JOIN journal_page_curation c ON c.user_id = p.user_id AND c.day = p.day "
      "WHERE p.user_id = $1::uuid ORDER BY p.day",
      user.str());

  std::vector<DuePage> pages;
  pages.reserve(rows.size());
  for (const auto& row : rows)
    pages.push_back(DuePage{LocalDate{row["day"].as<std::string>()},
                            row["body"].as<std::string>(),
                            row["stamp_ms"].as<std::uint64_t>(), row["attempts"].as<int>(), false});
  return pages;
}

std::vector<KnownSpan> PgEchoRepository::spansOf(const UserId& user, const LocalDate& day) {
  // Ordered by ord: reconciliation matches duplicated text within a page in document order.
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
  // A day's passages are always a complete set, and a carried span_id is re-inserted under the
  // identity the caller chose. No foreign key ties journal_echo to these rows, so an echo aimed at a
  // dead passage is orphaned: invisible at once, since echoesFor inner-joins both spans, and swept
  // when its own page is next derived.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM journal_span WHERE user_id = $1::uuid AND day = $2::date",
                  user.str(), day.iso());

  // RETURNING in ord order, the order corpusOf serves, so a warm corpus splices it in unchanged.
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
  // Bounded at kCorpusSpans, newest days first, then handed back oldest-first as the port promises.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT span_id, day::text AS day, text, encode(vector, 'hex') AS vector FROM ("
      "  SELECT span_id, day, ord, text, vector FROM journal_span "
      "  WHERE user_id = $1::uuid AND embed_version = $2 "
      "  ORDER BY day DESC, ord DESC LIMIT $3) recent "
      "ORDER BY day, ord",
      user.str(), embedVersion, kCorpusSpans);

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
  // Dismissals are keyed on content, so this resolves them back into span ids.
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
  // Stored as the two passages' content, never their ids, so the pair stays faded across an edit.
  // DISTINCT because two spans can carry identical hashes. Scoped by e.user_id and nothing else.
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
  // One statement, on the same content hashes the pair-level door writes. DISTINCT because two spans
  // on a page can carry the same hash pair; ON CONFLICT makes a second press idempotent. Scoped by
  // e.user_id and nothing else.
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
  // Retires the asking, never the echoes, so this does not touch journal_echo. Keyed on the day, so
  // re-deriving the page leaves the answer standing.
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
  // The retrieval score and the judging model are copied in rather than joined at read time, since
  // journal_echo is rewritten every night. ON CONFLICT DO NOTHING, so the first answer stands.
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
  // One statement, so a page's signals cannot half-land.
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
  // Additive: what goes is what can no longer be shown, plus what was raised again and refused. A
  // row this pass never raised is kept, and created_at survives either way.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "DELETE FROM journal_echo e WHERE e.user_id = $1::uuid AND e.trigger_day = $2::date AND ("
      "NOT EXISTS (SELECT 1 FROM journal_span s "
      "WHERE s.user_id = e.user_id AND s.span_id = e.trigger_span_id) "
      "OR NOT EXISTS (SELECT 1 FROM journal_span s "
      "WHERE s.user_id = e.user_id AND s.span_id = e.match_span_id))",
      user.str(), triggerDay.iso());

  // One statement per refused pairing, bounded by what one page proposed; one transaction.
  for (const SpanPair& pair : curated.refused)
    txn.exec_params(
        "DELETE FROM journal_echo WHERE user_id = $1::uuid AND trigger_span_id = $2 "
        "AND match_span_id = $3",
        user.str(), static_cast<long long>(pair.triggerSpanId),
        static_cast<long long>(pair.matchSpanId));

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

void PgEchoRepository::clearEchoes(const UserId& user, const LocalDate& triggerDay) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM journal_echo WHERE user_id = $1::uuid AND trigger_day = $2::date",
                  user.str(), triggerDay.iso());
  txn.commit();
}

void PgEchoRepository::recordCuration(const UserId& user, const LocalDate& day,
                                      const CurationOutcome& outcome) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};

  // An unsettled pass leaves both stamps where they were, and the due queries bring the page back on
  // its status — not on its stamps alone, because this branch does advance the version columns. It
  // records what the finished steps earned: a cut that reached storage was paid for, and a pass that
  // claimed none bought it again from the vendor every six hours forever. A step that did not run
  // hands back an empty string, which keeps what an earlier pass earned rather than clearing it.
  // `judge_version` is never written here: this pass judged nothing, and the stored echoes are still
  // the older judgement's. A refusal settles instead, in the branch below.
  if (!isSettled(outcome.status)) {
    txn.exec_params(
        "INSERT INTO journal_page_curation "
        "(user_id, day, status, attempts, last_error, segment_version, embed_version, updated_at) "
        "VALUES ($1::uuid, $2::date, $3, 1, $4, $5, $6, now()) "
        "ON CONFLICT (user_id, day) DO UPDATE "
        "SET status = EXCLUDED.status, attempts = journal_page_curation.attempts + 1, "
        "last_error = EXCLUDED.last_error, "
        "segment_version = coalesce(nullif(EXCLUDED.segment_version, ''), "
        "                           journal_page_curation.segment_version), "
        "embed_version = coalesce(nullif(EXCLUDED.embed_version, ''), "
        "                         journal_page_curation.embed_version), "
        "updated_at = now()",
        user.str(), day.iso(), statusText(outcome.status), outcome.error, outcome.versions.segment,
        outcome.versions.embed);
    txn.commit();
    return;
  }

  // Both stamps advance, so nothing but an edit to this body makes the page due again. `last_error`
  // is empty on a success and "refused" on the settled failure.
  txn.exec_params(
      "INSERT INTO journal_page_curation "
      "(user_id, day, body_stamp_ms, corpus_stamp, status, attempts, last_error, "
      " segment_version, embed_version, judge_version, updated_at) "
      "VALUES ($1::uuid, $2::date, $3, $4, $5, 0, $6, $7, $8, $9, now()) "
      "ON CONFLICT (user_id, day) DO UPDATE "
      "SET body_stamp_ms = EXCLUDED.body_stamp_ms, corpus_stamp = EXCLUDED.corpus_stamp, "
      "status = EXCLUDED.status, attempts = 0, last_error = EXCLUDED.last_error, "
      "segment_version = EXCLUDED.segment_version, embed_version = EXCLUDED.embed_version, "
      "judge_version = EXCLUDED.judge_version, updated_at = now()",
      user.str(), day.iso(), static_cast<long long>(outcome.bodyStampMs),
      static_cast<long long>(outcome.corpusStamp), statusText(outcome.status), outcome.error,
      outcome.versions.segment, outcome.versions.embed, outcome.versions.judge);
  txn.commit();
}

std::vector<LocalDate> PgEchoRepository::inboundPages(const UserId& user,
                                                      const LocalDate& matchDay) {
  // The reverse edge: which pages reach into this one and so must be derived again.
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
  // Both spans join INNER, so an echo whose passage is gone is not here. The dismissal check runs on
  // content hashes rather than ids. Ordered trigger day, then position on the page, then match day.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};

  // The match pages' bodies, once each.
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
      // Served rather than remembered by the device, so the next device knows it too.
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
  // A row holding only whitespace is a page they opened, not one they wrote.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT count(*)::int AS pages FROM journal_page "
      "WHERE user_id = $1::uuid AND btrim(body, E' \\t\\r\\n') <> ''",
      user.str());
  return rows.empty() ? 0 : rows[0]["pages"].as<int>();
}

}
