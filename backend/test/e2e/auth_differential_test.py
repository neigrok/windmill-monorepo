import sys
import unittest

sys.dont_write_bytecode = True
from auth_differential import compare, pinned_auth_changes


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

    def test_unordered_retired_cookie_lines_keep_live_cookie_first_and_every_byte(self):
        live = b'Set-Cookie: wm_session=' + b'a' * 43 + b'; Max-Age=7776000; Domain=auth.test; Path=/\r\n'
        retired = [b'Set-Cookie: wm_session=; Max-Age=0; Domain=old.auth.test; Path=/\r\n',
                   b'Set-Cookie: wm_session=; Max-Age=0; Path=/\r\n']
        left = (200, b'{}', [live, *retired])
        right = (200, b'{}', [live.replace(b'a' * 43, b'b' * 43), *reversed(retired)])
        compare([left, right], "unordered retired", minted=True)
        for changed in ([retired[0], live, retired[1]], [live, retired[0]],
                        [live, retired[0], retired[0]], [live, retired[0], retired[1].replace(b'Path=/', b'Path=/v1')]):
            with self.subTest(changed=changed), self.assertRaises(AssertionError):
                compare([left, (200, b'{}', changed)], "cookie regression", minted=True)

    def test_pinned_code_copy_requires_exact_old_and_new_contracts(self):
        left = (410, b'{"code":"expired","detail":"Codes work once and last 15 minutes.","error":"That code has expired"}', [])
        right = (410, b'{"code":"expired","detail":"Check the digits, or send a fresh one.","error":"That code didn\'t work"}', [])
        compare(pinned_auth_changes([left, right], "/v1/auth/verify-code", 410), "pinned copy")
        with self.assertRaises(AssertionError):
            pinned_auth_changes([left, (410, right[1].replace(b'expired', b'unknown'), [])], "/v1/auth/verify-code", 410)

    def test_pinned_methods_addition_preserves_body_bytes_and_refuses_extra_fields(self):
        left = (200, b'{"user":{"email":"sam@example.com","id":"u"}}', [])
        right = (200, b'{"signInMethods":[{"email":"sam@example.com","kind":"email"}],"user":{"email":"sam@example.com","id":"u"}}', [])
        compare(pinned_auth_changes([left, right], "/v1/me", 200), "pinned methods")
        with self.assertRaises(AssertionError):
            pinned_auth_changes([left, (200, right[1].replace(b'"id":"u"', b'"id":"different"'), [])], "/v1/me", 200)


if __name__ == "__main__":
    unittest.main()
