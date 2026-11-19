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
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.output = Path(self.scratch.name) / "generated"

    def command(self, checking):
        return subprocess.run([sys.executable, str(Path(gen.__file__)), "--output", str(self.output), *( ["--check"] if checking else [] )], capture_output=True, text=True, timeout=60)

    def test_generate_and_check(self):
        self.assertEqual(0, self.command(False).returncode)
        self.assertEqual(0, self.command(True).returncode)
        self.assertEqual(len(gen.load(gen.CONTRACT / "composition.json")["registries"]) + 1, len(list(self.output.glob("*.kt"))))

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

    def test_scoped_commands_validate_and_engine_and_inverse_commands_keep_their_shapes(self):
        schema = gen.load(gen.CONTRACT / "registry.schema.json")
        probe = gen.load(gen.CONTRACT / "probe.registry.json")
        gen.validate(schema, probe, schema)

        def command(registry, name):
            return next(command for command in registry["commands"] if command["name"] == name)
        mutations = [
            lambda r: command(r, "probe.capture")["args"].update(id={"type": "ref<card>"}),
            lambda r: command(r, "probe.capture").pop("scopedEffects"),
            lambda r: command(r, "probe.capture").update(scopedEffects=False),
            lambda r: command(r, "probe.capture").update(engine="replay"),
            lambda r: command(r, "probe.restore").pop("predicts"),
            lambda r: command(r, "probe.restore").update(refPaths=[]),
            lambda r: command(r, "probe.unbranch").pop("scopedEffects"),
            lambda r: command(r, "probe.unbranch").update(engine="capture"),
            lambda r: command(r, "probe.unbranch").update(inverse=False),
            lambda r: command(r, "probe.unbranch")["args"].update(evidence={"type": "json"}),
        ]
        for mutate in mutations:
            registry = copy.deepcopy(probe)
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

    def test_three_products_preserve_order_and_literals_and_refuse_an_invalid_third(self):
        directory = Path(self.scratch.name)
        names = ["beta", "alpha", "gamma"]
        manifest = {"composition": "three", "registries": [name + ".registry.json" for name in names]}
        (directory / "composition.json").write_text(gen.json.dumps(manifest))
        documents = {}
        for name in reversed(names):
            documents[name] = {"registry": name, "version": 3, "minVersion": 2, "products": {name: {}},
                "types": [{"type": name, "scope": "product:" + name, "identity": "singleton", "singletonId": name,
                    "idPattern": "^" + name + "$", "life": False, "origins": ["replica"],
                    "fields": {"value": {"kind": "lww", "writer": "client", "domain": {"type": "string", "enum": ['café 🌳 $ " \\ \n']}}}}],
                "commands": [{"name": name + ".set", "scope": "product:" + name, "origins": ["server"], "serverInternal": False, "args": {}}]}
            (directory / (name + ".registry.json")).write_text(gen.json.dumps(documents[name]))
        (directory / "unused.registry.json").write_text("{}")
        sources = gen.generate(directory)
        self.assertEqual({"Alpha.generated.kt", "Beta.generated.kt", "Gamma.generated.kt", "SyncSchema.generated.kt"}, set(sources))
        self.assertEqual('\n'.join([
            "// Generated by tools/schema_gen.py from packages/api-contract/sync/composition.json. Do not edit.",
            "package works.windmill.sync.schema", "", "import works.windmill.sync.core.Registry", "", "object SyncSchema {",
            '    val registry = Registry.compose("three", listOf(Beta.registry, Alpha.registry, Gamma.registry))',
            "    val version = registry.version", "}", "",
        ]), sources["SyncSchema.generated.kt"])
        for name in names:
            lines = sources[name.capitalize() + ".generated.kt"].splitlines()
            start = lines.index("        listOf(") + 1
            end = lines.index('        ).joinToString("\\n"),')
            literal = "\n".join(gen.json.loads(line.strip().removesuffix(",").replace("\\$", "$")) for line in lines[start:end])
            self.assertEqual(gen.json.dumps(documents[name], ensure_ascii=True, indent=2), literal)
        for key in ["version", "minVersion", "product", "type", "command"]:
            third = copy.deepcopy(documents["gamma"])
            if key == "version":
                third[key] = 4
            elif key == "minVersion":
                third[key] = 1
            elif key == "product":
                third["products"] = {"alpha": {}}
            elif key == "type":
                third["types"][0]["type"] = "alpha"
            else:
                third["commands"][0]["name"] = "alpha.set"
            (directory / "gamma.registry.json").write_text(gen.json.dumps(third))
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

    def test_generator_preserves_the_id_domain_in_its_registry_literal(self):
        vectors = gen.load(gen.CONTRACT / "corpus/registry/refusals.json")
        registry = next(v["input"]["registry"] for v in vectors if v["name"] == "a derived type declares a Unicode id domain")
        registry["products"] = {"p": {}}
        with tempfile.TemporaryDirectory() as directory:
            contract = Path(directory)
            (contract / "composition.json").write_text(gen.json.dumps({"composition": "windmill", "registries": ["mini.registry.json"]}))
            (contract / "mini.registry.json").write_text(gen.json.dumps(registry))
            sources = gen.generate(contract)
        lines = sources["Mini.generated.kt"].splitlines()
        start = lines.index("        listOf(") + 1
        end = lines.index('        ).joinToString("\\n"),')
        literal = "\n".join(gen.json.loads(line.strip().removesuffix(",")) for line in lines[start:end])
        self.assertEqual(gen.json.dumps(registry, ensure_ascii=True, indent=2), literal)
        self.assertEqual(registry, gen.json.loads(literal))


if __name__ == "__main__":
    unittest.main()
