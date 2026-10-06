import hashlib
import http.client
import json
import os
import secrets
import socket
import struct
import subprocess
import time
import unittest
import uuid


class HttpDisconnectTest(unittest.TestCase):
    def test_client_reset_during_large_reply_keeps_server_serving(self):
        database = os.environ["WM_E2E_DB"]
        port = int(os.environ["PORT"])
        account = str(uuid.uuid4())
        token = secrets.token_hex(24)
        digest = hashlib.sha256(token.encode()).hexdigest()

        def sql(statement):
            subprocess.run(["psql", database, "-q", "-v", "ON_ERROR_STOP=1"],
                           input=statement, text=True, check=True, capture_output=True, timeout=10)

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            sql(f"""begin;
                insert into users(id,email) values ('{account}','disconnect-{account}@example.com');
                insert into sessions(token_hash,user_id,expires_ms)
                  values ('{digest}','{account}',{int(time.time() * 1000) + 3600000});
                insert into journal_page(user_id,day,body)
                  select '{account}', date '2025-01-01' + n, repeat('x',65536)
                  from generate_series(0,255) as n;
                commit;""")
            for attempt in range(12):
                with self.subTest(attempt=attempt + 1):
                    with socket.socket() as client:
                        client.settimeout(10)
                        client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
                        client.connect(("127.0.0.1", port))
                        client.sendall(("GET /v1/journal/export HTTP/1.1\r\nHost: localhost\r\n"
                                        f"Authorization: Bearer {token}\r\n\r\n").encode())
                        received = b""
                        while b"\r\n\r\n" not in received:
                            chunk = client.recv(4096)
                            self.assertTrue(chunk, "server closed before its response headers")
                            received += chunk
                        head, body = received.split(b"\r\n\r\n", 1)
                        self.assertTrue(head.startswith(b"HTTP/1.1 200 OK\r\n"), head)
                        headers = dict(line.lower().split(b": ", 1) for line in head.split(b"\r\n")[1:])
                        length = int(headers[b"content-length"])
                        self.assertGreaterEqual(length, 16 * 1024 * 1024)
                        if not body:
                            body = client.recv(4096)
                        self.assertTrue(body)
                        self.assertLess(len(body), length)
                        client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))

                    connection.request("GET", "/v1/gym/preferences", headers={"Authorization": f"Bearer {token}"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), {
                        "units": "kg", "restSound": True, "confirmHaptic": True, "confirmSound": False})
        finally:
            connection.close()
            sql(f"delete from users where id='{account}'")


if __name__ == "__main__":
    unittest.main()
