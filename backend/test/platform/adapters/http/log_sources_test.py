from pathlib import Path
import re
import unittest

# Every line the server logs passes privacySafeLogBody (platform/adapters/http/LogFormat.cpp) on its way to the log and to
# Sentry Logs, and a line from a file not in its ownedSources comes out as "framework diagnostic suppressed". So every
# file of platform/ and products/ that writes a LOG_ line is named there, and every name there is a file that writes one.

SOURCES = ("platform", "products")
LOGGED = re.compile(r"\bLOG_(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL|SYSERR)\b")
OWNED = re.compile(r"ownedSources\{(.*?)\};", re.DOTALL)


def logging_files(backend):
    return {path.name for top in SOURCES for path in (backend / top).rglob("*")
            if path.suffix in (".h", ".cpp") and LOGGED.search(re.sub(r"//.*", "", path.read_text(errors="replace")))}


def owned_sources(backend):
    listed = OWNED.search((backend / "platform/adapters/http/LogFormat.cpp").read_text()).group(1)
    return set(re.findall(r'"([^"]+)"', listed))


class LogSourcesTest(unittest.TestCase):
    def test_every_file_that_logs_is_an_owned_source_and_every_owned_source_logs(self):
        backend = Path(__file__).resolve().parents[4]
        logging, owned = logging_files(backend), owned_sources(backend)
        self.assertEqual((sorted(logging - owned), sorted(owned - logging)), ([], []))


if __name__ == "__main__":
    unittest.main()
