#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
from differential_harness import Differential, command, database_url


ACCOUNT = "40000000-0000-4000-8000-000000000001"
EMAIL = "auth-diff@example.com"
CODE = "654321"
SESSION = re.compile(rb"(?<=wm_session=)[A-Za-z0-9_-]+(?=;)")


def compare(responses, label, minted=False):
    normalized = []
    for status, body, cookies in responses:
        if minted:
            secrets = [SESSION.findall(line) for line in cookies]
            assert sum(map(len, secrets)) == 1, (label, "expected one live session cookie", cookies)
            assert len(next(secret[0] for secret in secrets if secret)) == 43, (label, "bad session entropy")
            cookies = [SESSION.sub(b"auth-differential-session", line) for line in cookies]
        if cookies and cookies[0].lower().startswith(b"set-cookie: wm_session=") and all(
                line.startswith(b"Set-Cookie: wm_session=; Max-Age=0;") for line in cookies[1:]):
            cookies = [cookies[0], *sorted(cookies[1:])]
        normalized.append((status, body, cookies))
    assert normalized[0] == normalized[1], (label, normalized)


class Connection:
    def __init__(self, port):
        self.socket = socket.create_connection(("127.0.0.1", port), timeout=15)
        self.reader = self.socket.makefile("rb")

    def close(self):
        self.reader.close()
        self.socket.close()

    def request(self, method, target, body=None, headers=None):
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode() if body is not None else b""
        fields = {"Host": "auth.test", "Content-Type": "application/json", "Content-Length": str(len(payload)),
                  "Connection": "keep-alive", **(headers or {})}
        request = f"{method} {target} HTTP/1.1\r\n".encode()
        request += b"".join(f"{key}: {value}\r\n".encode() for key, value in fields.items())
        self.socket.sendall(request + b"\r\n" + payload)
        status = int(self.reader.readline().split()[1])
        cookies, response_headers = [], {}
        while True:
            line = self.reader.readline()
            if line == b"\r\n":
                break
            assert line, "server closed before response headers"
            name, value = line.split(b":", 1)
            response_headers[name.lower()] = value.strip()
            if name.lower() == b"set-cookie":
                cookies.append(line)
        if status == 204:
            content = b""
        elif response_headers.get(b"transfer-encoding") == b"chunked":
            content = b""
            while True:
                length = int(self.reader.readline().split(b";", 1)[0], 16)
                if not length:
                    assert self.reader.readline() == b"\r\n"
                    break
                content += self.reader.read(length)
                assert self.reader.read(2) == b"\r\n"
        else:
            content = self.reader.read(int(response_headers[b"content-length"]))
        return status, content, cookies


class AuthDifferential(Differential):
    def __init__(self, args, directory):
        super().__init__(args, directory)
        self.ports = [args.port, args.port + 1]
        self.requests = 0
        self.main_binary = args.main_bin
        self.tokens = [None, None]

    def stop_servers(self):
        for connection in self.connections:
            connection.close()
        self.connections.clear()
        for port, process in zip(self.ports, self.processes):
            result = subprocess.run(["lsof", "-tiTCP:" + str(port), "-sTCP:LISTEN"], capture_output=True)
            for pid in result.stdout.split():
                assert int(pid) == process.pid, (port, "listener is not the harness server")
                os.kill(int(pid), signal.SIGTERM)
        for process in self.processes:
            process.wait(timeout=15)
        self.processes.clear()

    def setup(self):
        for port in self.ports:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
        if self.main_binary is None:
            self.build_main()
        for side, schema in enumerate(self.schemas()):
            name = f"wm_auth_diff_{os.getpid()}_{time.time_ns()}_{side}"
            command(["createdb", "--maintenance-db=" + self.args.maintenance_db, name])
            database = database_url(self.args.maintenance_db, name)
            self.databases.append((name, database))
            command(["psql", database, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(schema)])
            self.sql(database, f"INSERT INTO users(id,email,name) VALUES ('{ACCOUNT}','{EMAIL}','Auth');")

    def start(self, secure):
        for side, (_, database) in enumerate(self.databases):
            environment = {"DATABASE_URL": database, "PORT": str(self.ports[side]), "WINDMILL_HOST": "127.0.0.1",
                "WINDMILL_APP_URL": ("https" if secure else "http") + "://auth.test",
                "WINDMILL_API_URL": "http://auth.test", "WINDMILL_COOKIE_DOMAIN": "auth.test" if secure else "",
                "WINDMILL_COOKIE_RETIRED_DOMAINS": "old.auth.test,.older.auth.test" if secure else "",
                "APPLE_NATIVE_ENABLED": "0", "APPLE_CLIENT_ID": "",
                "JOURNAL_NUDGE_ENABLED": "0", "JOURNAL_ECHO_ADMIN_TOKEN": "", "REMINDERS_ENABLED": "0",
                "TENDING_ENABLED": "0", "RESEND_API_KEY": "", "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "",
                "SENTRY_DSN": "", "AMPLITUDE_API_KEY": "", "WINDMILL_MCP_TOKEN": "",
                "WM_TEST_CLOCK_FILE": str(self.clock_file)}
            binary = self.main_binary if side == 0 else self.args.bin_dir / "windmill_server_test_clock"
            with (self.directory / f"server-{int(secure)}-{side}.log").open("wb") as output:
                process = subprocess.Popen([str(binary)], cwd=self.directory, env={**os.environ, **environment},
                                           stdout=output, stderr=output)
            self.processes.append(process)
            for attempt in range(100):
                try:
                    connection = Connection(self.ports[side])
                    response = connection.request("GET", "/v1/me")
                    assert response[0] == 401, response
                    self.connections.append(connection)
                    break
                except OSError:
                    if process.poll() is not None:
                        raise AssertionError(f"server {side} exited: see {self.directory}")
                    time.sleep(0.1)
            else:
                raise AssertionError("server did not listen")

    def pair(self, method, target, body=None, expected=200, minted=False, authenticated=False):
        self.clock_ms += 1000
        self.clock_file.write_text(str(self.clock_ms))
        responses = []
        for side, connection in enumerate(self.connections):
            headers = {"Cookie": "wm_session=" + self.tokens[side]} if authenticated else {}
            responses.append(connection.request(method, target, body, headers))
        label = f"{method} {target} #{self.requests + 1}"
        assert [response[0] for response in responses] == [expected, expected], (label, responses)
        compare(responses, label, minted)
        if minted:
            for side, (_, _, cookies) in enumerate(responses):
                self.tokens[side] = next(SESSION.search(line).group().decode() for line in cookies if SESSION.search(line))
                stored = self.sql(self.databases[side][1], "SELECT user_id::text FROM sessions WHERE token_hash='" +
                    hashlib.sha256(self.tokens[side].encode()).hexdigest() + "'")
                assert stored == ACCOUNT, (label, "minted session is not persisted for the account", stored)
        self.requests += 1
        return responses

    def seed_code(self, expired=False):
        secret = f"auth-differential-link-{self.requests}"
        digest = hashlib.sha256(secret.encode()).hexdigest()
        code_hash = hashlib.sha256(CODE.encode()).hexdigest()
        for _, database in self.databases:
            self.sql(database, "DELETE FROM magic_links; " +
                f"INSERT INTO magic_links(token_hash,code_hash,email,created_ms,expires_ms) VALUES " +
                f"('{digest}','{code_hash}','{EMAIL}',{self.clock_ms - 1000}," +
                str(self.clock_ms - 1 if expired else self.clock_ms + 900000) + ");")
        return secret

    def sequence(self):
        for secure in (False, True):
            self.start(secure)
            for door in (None, "app"):
                for malformed in (b"not json", {}, {"email": "sam@"}):
                    self.pair("POST", "/v1/auth/magic-link", malformed, 400)
                self.seed_code()
                for _, database in self.databases:
                    self.sql(database, "DELETE FROM magic_links")
                for index in range(10):
                    request = {"email": EMAIL, **({"door": door} if door else {})}
                    self.pair("POST", "/v1/auth/magic-link", request, 502 if index < 9 else 429)
                for _, database in self.databases:
                    assert self.sql(database, "SELECT count(*) FROM magic_links") == "9"
                    self.sql(database, "UPDATE magic_links SET consumed_ms=created_ms "
                        "WHERE created_ms < (SELECT max(created_ms) FROM magic_links); " +
                        f"UPDATE magic_links SET code_hash='{hashlib.sha256(CODE.encode()).hexdigest()}' "
                        "WHERE consumed_ms IS NULL")
                self.pair("POST", "/v1/auth/verify-code", {"email": EMAIL, "code": CODE}, minted=True)
                self.pair("GET", "/v1/me", authenticated=True)
                self.pair("POST", "/v1/auth/verify-code", {"email": EMAIL, "code": CODE}, 410)
                self.pair("POST", "/v1/auth/logout", expected=204, authenticated=True)
                self.pair("GET", "/v1/me", expected=401, authenticated=True)
                for endpoint in ("verify", "verify-code"):
                    for transport in (None, "cookie", True):
                        secret = self.seed_code()
                        body = {"token": secret} if endpoint == "verify" else {"email": EMAIL, "code": CODE}
                        if transport is not None:
                            body["sessionTransport"] = transport
                        self.pair("POST", "/v1/auth/" + endpoint, body, minted=True)
                        self.pair("GET", "/v1/me", authenticated=True)
                        self.pair("POST", "/v1/auth/" + endpoint, body, 410)
                        self.pair("POST", "/v1/auth/logout", expected=204, authenticated=True)
                        self.pair("GET", "/v1/me", expected=401, authenticated=True)
                for endpoint in ("verify", "verify-code"):
                    for body in (b"not json", {}):
                        self.pair("POST", "/v1/auth/" + endpoint, body, 400)
                for expired in (False, True):
                    secret = self.seed_code(expired)
                    self.pair("POST", "/v1/auth/verify-code", {"email": "unknown@example.com", "code": CODE}, 410)
                    self.pair("POST", "/v1/auth/verify", {"token": "unknown"}, 410)
                    if expired:
                        self.pair("POST", "/v1/auth/verify-code", {"email": EMAIL, "code": CODE}, 410)
                        self.pair("POST", "/v1/auth/verify", {"token": secret}, 410)
                    else:
                        for attempt in range(5):
                            self.pair("POST", "/v1/auth/verify-code", {"email": EMAIL, "code": "000000"}, 410)
                        self.pair("POST", "/v1/auth/verify-code", {"email": EMAIL, "code": CODE}, 410)
                self.pair("POST", "/v1/auth/logout", expected=204)
            self.stop_servers()
        return {"passed": True, "pairedRequests": self.requests, "bodies": "exact bytes",
                "setCookie": "raw header bytes; fresh 43-byte session substituted; live cookie first, unordered retired lines sorted",
                "configurations": ["HTTP host-only", "HTTPS live and retired domains"],
                "mail": "unconfigured local provider returns 502; persisted request codes verified"}

    def cleanup(self):
        self.stop_servers()
        for name, _ in self.databases:
            command(["dropdb", "--maintenance-db=" + self.args.maintenance_db, name])
        self.databases.clear()


def main():
    parser = argparse.ArgumentParser(description="Compare origin/main and tree legacy auth bodies and raw Set-Cookie bytes")
    parser.add_argument("--bin-dir", type=lambda path: Path(path).resolve(), required=True)
    parser.add_argument("--main-bin", type=lambda path: Path(path).resolve())
    parser.add_argument("--maintenance-db", default=os.environ.get("WM_MAINTENANCE_DB", "postgresql:///postgres?host=/tmp"))
    parser.add_argument("--drogon-prefix", type=Path)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--port", type=int, default=18870)
    args = parser.parse_args()
    assert 18860 <= args.port < 18879, "two server ports must be within 18860–18879"
    with tempfile.TemporaryDirectory(prefix="wm-auth-diff-") as directory:
        differential = AuthDifferential(args, Path(directory))
        try:
            differential.setup()
            print(json.dumps(differential.sequence(), sort_keys=True))
        finally:
            differential.cleanup()


if __name__ == "__main__":
    main()
