import base64
import json
import math
from pathlib import Path
import re
import struct
import unittest
import zlib

from anonymous_coach import photo_bytes, fixture_result


class AnonymousCoachTest(unittest.TestCase):
    def test_dialogue_fixture_greets_and_continues_without_a_routine(self):
        self.assertEqual(fixture_result({"mode": "conversation", "text": "Hi", "context": []}),
                         {"message": "Hello. What would you like to work on?", "routines": []})
        self.assertEqual(fixture_result({"mode": "conversation", "text": "Three days", "context": [{"role": "user", "text": "Hi"}]}),
                         {"message": "Three days gives us room to build gradually. Would you like a routine draft?", "routines": []})
        draft = fixture_result({"mode": "conversation", "text": "Make a routine", "context": []})
        self.assertEqual(draft["message"], "Here are your routine drafts. Review them before saving.")
        self.assertEqual(draft["routines"], fixture_result({"mode": "program"})["routines"])

    def test_maximum_photo_preserves_the_original_png_pixels(self):
        original = photo_bytes()
        maximum = photo_bytes(maximum=True)
        self.assertEqual(len(maximum), 1024 * 1024)
        self.assertEqual(maximum[:len(original) - 12], original[:-12])
        self.assertEqual(maximum[-12:], original[-12:])
        offset = len(original) - 12
        length = struct.unpack(">I", maximum[offset:offset + 4])[0]
        chunk = maximum[offset + 4:offset + 8 + length]
        checksum = struct.unpack(">I", maximum[offset + 8 + length:offset + 12 + length])[0]
        self.assertEqual(chunk[:4], b"tEXt")
        self.assertEqual(checksum, zlib.crc32(chunk))
        self.assertEqual(offset + length + 12, len(maximum) - 12)

    def test_accepted_photo_body_stays_below_drogon_disk_spool_threshold(self):
        backend = Path(__file__).resolve().parents[2]
        host = (backend / "platform/infra/main.cpp").read_text()
        match = re.search(r"setClientMaxMemoryBodySize\(([\d *]+)\)", host)
        self.assertIsNotNone(match)
        memory_limit = math.prod(int(factor.strip()) for factor in match[1].split("*"))
        image_limit = re.search(r"kOnboardingImageBytes = ([\d *]+);",
                                (backend / "products/gym/onboarding/Onboarding.h").read_text())
        self.assertIsNotNone(image_limit)
        decoded_limit = math.prod(int(factor.strip()) for factor in image_limit[1].split("*"))
        self.assertEqual(decoded_limit, len(photo_bytes(maximum=True)))
        self.assertLess(4 * ((decoded_limit + 2) // 3) + 131072, memory_limit)
        request = {"requestId": "12345678-1234-1234-1234-123456789abc", "mode": "photo",
                   "image": {"mimeType": "image/png", "data": base64.b64encode(photo_bytes(maximum=True)).decode()},
                   "note": "\x01" * 1000}
        self.assertLess(len(json.dumps(request).encode()), memory_limit)


if __name__ == "__main__":
    unittest.main()
