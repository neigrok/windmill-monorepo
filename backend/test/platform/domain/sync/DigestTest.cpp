#include "platform/domain/sync/Digest.h"

#include "platform/domain/sync/Jcs.h"

#include "test/testing.h"

#include <map>
#include <optional>
#include <random>
#include <string>
#include <vector>

using namespace wm::sync;

// Row hashes and scope sums are pinned by sync_corpus/digest/*; these cases pin the vendored SHA-256
// and prove §11.2.6.

TEST(sha256_answers_the_fips_180_4_vectors) {
  CHECK_EQ(sha256("").hex(), std::string("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
  CHECK_EQ(sha256("abc").hex(), std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  CHECK_EQ(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq").hex(),
           std::string("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
  CHECK_EQ(sha256("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu").hex(),
           std::string("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"));
  CHECK_EQ(sha256(std::string(1'000'000, 'a')).hex(), std::string("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
}

TEST(sha256_hashes_bytes_above_0x7f_as_unsigned) {
  CHECK_EQ(sha256("\xff").hex(), std::string("a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89"));
}

TEST(digest_arithmetic_wraps_modulo_2_to_the_256) {
  const Digest256 zero;
  const Digest256 one = *Digest256::fromHex(std::string(63, '0') + "1");
  const Digest256 top = *Digest256::fromHex(std::string(64, 'f'));
  CHECK_EQ((top + one).hex(), std::string(64, '0'));
  CHECK_EQ((zero - one).hex(), std::string(64, 'f'));
  CHECK_EQ((top + top).hex(), std::string(63, 'f') + "e");
  CHECK_EQ(zero.hex(), std::string(64, '0'));
}

TEST(digest_hex_is_exactly_64_lowercase_characters) {
  const std::string hex = "00ff" + std::string(60, 'a');
  CHECK_EQ(Digest256::fromHex(hex)->hex(), hex);
  CHECK_EQ(Digest256::fromHex(std::string(64, 'A')), std::nullopt);
  CHECK_EQ(Digest256::fromHex(std::string(63, '0')), std::nullopt);
  CHECK_EQ(Digest256::fromHex(std::string(65, '0')), std::nullopt);
  CHECK_EQ(Digest256::fromHex(std::string(63, '0') + "g"), std::nullopt);
}

TEST(a_dead_row_and_an_absent_row_hash_to_zero) {
  const Json::Value dead = parseJson(R"({"t":"card","id":"c1","life":["dead","5:0:a"],"seq":1,"rc":1,"ru":1})");
  CHECK(rowHash(dead) == Digest256{});
  CHECK(rowHash(Json::Value(Json::nullValue)) == Digest256{});
  const Json::Value lifeless = parseJson(R"({"t":"meta","id":"meta","seq":1,"rc":1,"ru":1})");
  CHECK(rowHash(lifeless) == sha256(jcs(lifeless)));
}

// §11.2.6: a digest kept by `- h(before) + h(after)` over inserts, replacements and deletions equals
// the digest recomputed from the rows those changes leave.
TEST(an_incremental_scope_digest_equals_the_recomputed_one) {
  std::mt19937_64 random(611);
  auto pick = [&random](int bound) { return static_cast<int>(random() % static_cast<std::uint64_t>(bound)); };
  auto randomRow = [&](const std::string& id, int seq) {
    Json::Value row(Json::objectValue);
    row["t"] = pick(3) == 0 ? "meta" : "card";
    row["id"] = id;
    if (row["t"] == "card") {
      Json::Value life(Json::arrayValue);
      life.append(pick(3) == 0 ? "dead" : "alive");
      life.append(std::to_string(pick(50)) + ":" + std::to_string(pick(3)) + ":r_a");
      row["life"] = life;
    }
    Json::Value title(Json::arrayValue);
    title.append(std::string(static_cast<std::size_t>(pick(5)), static_cast<char>('a' + pick(26))));
    title.append(std::to_string(pick(50)) + ":0:r_b");
    row["f"]["title"] = title;
    row["seq"] = seq;
    row["rc"] = pick(1000);
    row["ru"] = pick(1000);
    return row;
  };

  for (int run = 0; run < 40; ++run) {
    std::map<std::string, Json::Value> rows;
    Digest256 digest;
    for (int seq = 1; seq <= 200; ++seq) {
      const std::string id = "c" + std::to_string(pick(25));
      const auto stored = rows.find(id);
      const Json::Value before = stored == rows.end() ? Json::Value(Json::nullValue) : stored->second;
      const Json::Value after = stored != rows.end() && pick(4) == 0 ? Json::Value(Json::nullValue) : randomRow(id, seq);
      digest = digest - rowHash(before) + rowHash(after);
      if (after.isNull()) rows.erase(id);
      else rows[id] = after;

      std::vector<Json::Value> recount;
      for (const auto& [rowId, row] : rows) recount.push_back(row);
      REQUIRE_EQ(digest.hex(), scopeDigest(recount).hex());
    }
  }
}
