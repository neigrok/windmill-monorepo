import copy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import schema_gen as gen


class SchemaGeneratorTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=gen.ANDROID / "build")
        self.addCleanup(self.scratch.cleanup)
        self.output = Path(self.scratch.name) / "generated"

    def command(self, checking):
        return subprocess.run([sys.executable, str(Path(gen.__file__)), "--output", str(self.output), *( ["--check"] if checking else [] )], capture_output=True, text=True, timeout=60)

    def test_generate_and_check(self):
        self.assertEqual(0, self.command(False).returncode)
        self.assertEqual(0, self.command(True).returncode)
        self.assertEqual(3, len(list(self.output.glob("*.kt"))))

    def test_missing_changed_extra_and_line_endings(self):
        for change in ["missing", "changed", "extra", "crlf"]:
            with self.subTest(change=change):
                self.assertEqual(0, self.command(False).returncode)
                target = self.output / "SyncSchema.generated.kt"
                if change == "missing":
                    target.unlink()
                elif change == "changed":
                    target.write_text("stale")
                elif change == "extra":
                    (self.output / "Obsolete.kt").write_text("stale")
                else:
                    target.write_bytes(target.read_bytes().replace(b"\n", b"\r\n"))
                self.assertEqual(1, self.command(True).returncode)
                self.assertEqual(0, self.command(False).returncode)
                self.assertEqual(0, self.command(True).returncode)

    def test_schema_rejects_wrong_shape(self):
        schema = gen.load(gen.CONTRACT / "registry.schema.json")
        original = gen.load(gen.CONTRACT / "gym.registry.json")
        mutations = [
            lambda r: r.update(version=0),
            lambda r: r.update(unknown=True),
            lambda r: r["types"][0].update(unknown=True),
            lambda r: r["types"][0].update(origins=["replica", "replica"]),
            lambda r: r["products"]["gym"].update(surfaces=["space"]),
            lambda r: r["types"][0].update(scope="bad"),
        ]
        for mutate in mutations:
            registry = copy.deepcopy(original)
            mutate(registry)
            with self.assertRaises(ValueError):
                gen.validate(schema, registry, schema)

    def test_unknown_schema_validation_keyword_fails(self):
        with self.assertRaises(ValueError):
            gen.validate({"unknownValidation": True}, {}, {})

    def test_semantic_oracle_refuses_invalid_quantum(self):
        directory = Path(self.scratch.name)
        registry = gen.load(gen.CONTRACT / "probe.registry.json")
        field = next(t for t in registry["types"] if t["type"] == "card")["fields"]["size"]
        field["domain"]["quantum"] = 0.3
        source = directory / "bad.registry.json"
        source.write_text(gen.json.dumps(registry))
        with self.assertRaises(subprocess.CalledProcessError):
            gen.validate_semantics([source])

    def test_stalled_semantic_oracle_times_out(self):
        contract = Path(self.scratch.name)
        oracle = contract / "reference/core/registry.js"
        oracle.parent.mkdir(parents=True)
        (contract / "package.json").write_text('{"type":"module"}')
        oracle.write_text("export class Registry { constructor() { while (true) {} } }")
        registry = contract / "registry.json"
        registry.write_text("{}")
        with patch.object(gen, "CONTRACT", contract), patch.object(gen, "ORACLE_TIMEOUT_SECONDS", 0.2):
            with self.assertRaises(subprocess.TimeoutExpired):
                gen.validate_semantics([registry])

    def test_composition_versions_and_duplicate_names(self):
        directory = Path(self.scratch.name)
        gym = gen.load(gen.CONTRACT / "gym.registry.json")
        journal = gen.load(gen.CONTRACT / "journal.registry.json")
        composition = gen.load(gen.CONTRACT / "composition.json")
        (directory / "composition.json").write_text(gen.json.dumps(composition))
        (directory / "gym.registry.json").write_text(gen.json.dumps(gym))
        for mutation in ["version", "type", "code"]:
            value = copy.deepcopy(journal)
            if mutation == "version":
                value["version"] += 1
            elif mutation == "type":
                value["types"][0]["type"] = gym["types"][0]["type"]
            else:
                value["products"]["journal"]["codes"] = gym["products"]["gym"]["codes"][:1]
            (directory / "journal.registry.json").write_text(gen.json.dumps(value))
            with self.assertRaises(ValueError):
                gen.generate(directory)

    def test_literal_escaping(self):
        self.assertEqual('"\\$a\\\"b\\\\c\\n\\u00e9\\ud83d\\ude00"', gen.string('$a"b\\c\né😀'))
        self.assertEqual('`when`', gen.identifier('when'))

    def test_duplicate_json_keys_are_rejected(self):
        source = Path(self.scratch.name) / "duplicate.json"
        source.write_text('{"a":1,"a":2}')
        with self.assertRaises(ValueError):
            gen.load(source)


if __name__ == "__main__":
    unittest.main()
