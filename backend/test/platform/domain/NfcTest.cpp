#include "platform/domain/Nfc.h"

#include "test/testing.h"

#include <string>

using namespace wm;

TEST(a_decomposed_letter_composes_to_its_one_code_point) {
  CHECK_EQ(nfc("Cafe\xCC\x81"), std::string("Caf\xC3\xA9"));
}

TEST(marks_are_put_in_canonical_order_before_they_compose) {
  CHECK_EQ(nfc("a\xCC\x82\xCC\xA3"), std::string("\xE1\xBA\xAD"));   // a + circumflex + dot below is U+1EAD
  CHECK_EQ(nfc("\xE2\x84\xAB"), std::string("\xC3\x85"));            // the angstrom sign is its letter, U+00C5
}

TEST(a_hangul_jamo_run_composes_to_its_syllable) {
  CHECK_EQ(nfc("\xE1\x84\x80\xE1\x85\xA1\xE1\x86\xA8"), std::string("\xEA\xB0\x81"));   // U+1100 U+1161 U+11A8 is U+AC01
}

TEST(composed_text_comes_back_byte_for_byte) {
  const std::string composed = "Bench \xF0\x9F\x8F\x8B\xEF\xB8\x8F\xE2\x80\x8D\xE2\x99\x80\xEF\xB8\x8F Caf\xC3\xA9 q\xCC\x87";
  CHECK_EQ(nfc(composed), composed);   // q + dot above has no composed form, so it stays two code points
  CHECK_EQ(nfc(""), std::string());
  CHECK_EQ(nfc(std::string("Keep\0it", 7)), std::string("Keep\0it", 7));
}

TEST(bytes_that_are_not_utf8_come_back_as_they_arrived) {
  CHECK_EQ(nfc("Caf\xC3"), std::string("Caf\xC3"));                   // cut mid-sequence
  CHECK_EQ(nfc("e\xCC\x81\xFF"), std::string("e\xCC\x81\xFF"));       // a byte no sequence starts with, after a mark
  CHECK_EQ(nfc("\xED\xA0\x80"), std::string("\xED\xA0\x80"));         // a lone surrogate half
  CHECK_EQ(nfc("\xC0\xAF"), std::string("\xC0\xAF"));                 // an overlong slash
}
