import sys
import unittest

sys.dont_write_bytecode = True
from auth_differential import compare


class AuthComparisonTest(unittest.TestCase):
    def response(self, body=b'{}', cookie=b'Set-Cookie: wm_session=; Max-Age=0; Path=/\r\n'):
        return 200, body, [cookie]

    def test_compares_body_bytes_without_json_normalization(self):
        for other in (b'{ }', b'{"user":1}', b'{}\n'):
            with self.subTest(other=other), self.assertRaises(AssertionError):
                compare([self.response(), self.response(other)], "body")

    def test_compares_every_cookie_header_byte_and_order(self):
        cookie = b'Set-Cookie: wm_session=; Max-Age=0; Path=/; HttpOnly\r\n'
        for other in (cookie.lower(), cookie.replace(b'Path=/', b'Path=/v1'),
                      cookie.replace(b'; HttpOnly', b''), cookie.replace(b': ', b':'),
                      cookie.replace(b'; Max-Age=0; Path=/', b'; Path=/; Max-Age=0')):
            with self.subTest(other=other), self.assertRaises(AssertionError):
                compare([self.response(cookie=cookie), self.response(cookie=other)], "cookie")
        with self.assertRaises(AssertionError):
            compare([(200, b'{}', [cookie, b'Set-Cookie: other=\r\n']),
                     (200, b'{}', [b'Set-Cookie: other=\r\n', cookie])], "cookie order")

    def test_only_normalizes_a_valid_fresh_session_secret(self):
        left = b'Set-Cookie: wm_session=' + b'a' * 43 + b'; Max-Age=7776000; Path=/\r\n'
        right = left.replace(b'a' * 43, b'b' * 43)
        compare([self.response(cookie=left), self.response(cookie=right)], "entropy", minted=True)
        for altered in (right.replace(b'7776000', b'0'), right.replace(b'b' * 43, b'short'),
                        right.replace(b'Path=/', b'Path=/v1')):
            with self.subTest(altered=altered), self.assertRaises(AssertionError):
                compare([self.response(cookie=left), self.response(cookie=altered)], "cookie", minted=True)
        with self.assertRaises(AssertionError):
            compare([self.response(cookie=left), self.response(cookie=right)], "no entropy normalization")


if __name__ == "__main__":
    unittest.main()
