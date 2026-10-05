#!/usr/bin/env python3
import argparse
import json
import math
import re
import subprocess
from pathlib import Path


ANDROID = Path(__file__).resolve().parents[1]
CONTRACT = ANDROID.parents[1] / "packages/api-contract/sync"
TARGET = ANDROID / "sync-schema/src/main/kotlin/works/windmill/sync/schema"
RESERVED = {"SyncSchema", "Registry", "Json", "String", "Boolean", "Int", "Long", "Double", "Types", "Commands", "Codes", "Defaults"}
ORACLE_TIMEOUT_SECONDS = 30


def load(path):
    def pairs(members):
        if len({key for key, value in members}) != len(members):
            raise ValueError("duplicate JSON key")
        return dict(members)

    def constant(value):
        raise ValueError("non-finite JSON number")

    return json.loads(path.read_bytes(), object_pairs_hook=pairs, parse_constant=constant)


# The checked-in schema uses this closed subset of draft 2020-12; unknown validation keywords fail closed.
def validate(schema, value, root, path="registry"):
    supported = {"$schema", "$id", "$defs", "$ref", "title", "description", "type", "required", "properties", "additionalProperties", "propertyNames", "allOf", "oneOf", "if", "then", "not", "const", "enum", "minimum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "pattern", "minProperties", "items", "minItems", "uniqueItems"}
    if schema is True:
        return
    if schema is False or set(schema) - supported:
        raise ValueError(path + ": unsupported or forbidden schema")
    if "$ref" in schema:
        target = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            target = target[part]
        validate(target, value, root, path)

    def conforms(subschema):
        try:
            validate(subschema, value, root, path)
            return True
        except ValueError:
            return False

    if "type" in schema:
        kind = schema["type"]
        numeric = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        valid = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str), "boolean": isinstance(value, bool), "number": numeric, "integer": numeric and int(value) == value}
        if not valid.get(kind, False):
            raise ValueError(path + ": type " + kind)
    if "const" in schema and value != schema["const"]:
        raise ValueError(path + ": const")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(path + ": enum")
    for child in schema.get("allOf", []):
        validate(child, value, root, path)
    if "oneOf" in schema and sum(conforms(child) for child in schema["oneOf"]) != 1:
        raise ValueError(path + ": oneOf")
    if "not" in schema and conforms(schema["not"]):
        raise ValueError(path + ": not")
    if "if" in schema and conforms(schema["if"]):
        validate(schema.get("then", True), value, root, path)
    if isinstance(value, dict):
        if set(schema.get("required", [])) - value.keys() or len(value) < schema.get("minProperties", 0):
            raise ValueError(path + ": required")
        for key, item in value.items():
            if "propertyNames" in schema:
                validate(schema["propertyNames"], key, root, path)
            child = schema.get("properties", {}).get(key, schema.get("additionalProperties", True))
            validate(child, item, root, path + "." + key)
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise ValueError(path + ": minItems")
        if schema.get("uniqueItems") and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
            raise ValueError(path + ": uniqueItems")
        for i, item in enumerate(value):
            validate(schema.get("items", True), item, root, path + "." + str(i))
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or ("pattern" in schema and re.search(schema["pattern"], value) is None):
            raise ValueError(path + ": pattern or minLength")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value < schema.get("minimum", -math.inf) or value <= schema.get("exclusiveMinimum", -math.inf) or value >= schema.get("exclusiveMaximum", math.inf):
            raise ValueError(path + ": bounds")


def validate_semantics(registries):
    oracle = CONTRACT / "reference/core/registry.js"
    program = """
        import {readFileSync} from 'node:fs';
        import {pathToFileURL} from 'node:url';
        const {Registry} = await import(pathToFileURL(process.argv[1]).href);
        for (const file of process.argv.slice(2)) new Registry(JSON.parse(readFileSync(file, 'utf8')));
    """
    subprocess.run(["node", "--input-type=module", "-e", program, str(oracle), *map(str, registries)], check=True, capture_output=True, text=True, timeout=ORACLE_TIMEOUT_SECONDS)


def string(text):
    return json.dumps(text, ensure_ascii=True).replace("$", "\\$")


def identifier(name):
    if not name or not all(c.isascii() and (c.isalnum() or c == "_") for c in name) or name[0].isdigit():
        raise ValueError("invalid Kotlin identifier")
    return "`" + name + "`"


def enum_name(name):
    return "".join(word[0].upper() + word[1:] for word in name.split("-"))


def camel(name):
    words = name.split("-")
    return words[0] + "".join(word[0].upper() + word[1:] for word in words[1:])


def members(entries):
    names = [member for member, value in entries]
    if len(names) != len(set(names)):
        raise ValueError("duplicate generated member")
    return ["        const val " + identifier(member) + " = " + string(value) for member, value in entries]


def literal(value):
    if value is None:
        return "Json.Null"
    if isinstance(value, bool):
        return "Json.of(" + str(value).lower() + ")"
    if isinstance(value, (int, float)):
        return "Json.of(" + repr(value) + ("L" if isinstance(value, int) else "") + ")"
    if isinstance(value, str):
        return "Json.of(" + string(value) + ")"
    return "Json.parse(" + string(json.dumps(value, ensure_ascii=True, separators=(",", ":"))) + ")"


def generate(contract):
    composition = load(contract / "composition.json")
    schema = load(CONTRACT / "registry.schema.json")
    if set(composition) != {"composition", "registries"} or not composition["registries"] or len(composition["registries"]) != len(set(composition["registries"])):
        raise ValueError("invalid composition")
    files = {}
    parts = []
    products, types, commands, codes = set(), set(), set(), set()
    version = None
    for filename in composition["registries"]:
        if Path(filename).name != filename or not filename.endswith(".registry.json"):
            raise ValueError("invalid registry filename")
        registry = load(contract / filename)
        validate(schema, registry, schema)
        pair = (registry["version"], registry["minVersion"])
        if version is not None and pair != version:
            raise ValueError("registry version disagreement")
        version = pair
        part = enum_name(registry["registry"])
        if part in RESERVED or part in parts:
            raise ValueError("reserved or duplicate generated object")
        parts.append(part)
        if len(registry["products"]) != 1:
            raise ValueError("a product registry declares exactly one product")
        product = next(iter(registry["products"]))
        for category, values in [(products, [product]), (types, [t["type"] for t in registry["types"]]), (commands, [c["name"] for c in registry["commands"]]), (codes, registry["products"][product].get("codes", []))]:
            for value in values:
                if value in category:
                    raise ValueError("duplicate composition member: " + value)
                category.add(value)
        lines = ["// Generated by tools/schema_gen.py from packages/api-contract/sync/" + filename + ". Do not edit.",
                 "package works.windmill.sync.schema", "", "import works.windmill.sync.core.Json", "import works.windmill.sync.core.Registry", "",
                 "object " + part + " {", "    const val scope = " + string("self/" + product), "    object Types {"]
        lines += members([(t["type"], t["type"]) for t in registry["types"]]) + ["    }"]
        for group, entries in [("Commands", [(c["name"].split(".", 1)[1], c["name"]) for c in registry["commands"]]),
                               ("Codes", [(camel(c), c) for c in registry["products"][product].get("codes", [])])]:
            if entries:
                lines += ["    object " + group + " {"] + members(entries) + ["    }"]
        declaring = [t for t in registry["types"] if any("default" in f for f in t["fields"].values())]
        if declaring:
            lines += ["    object Defaults {"]
            for t in declaring:
                name = enum_name(t["type"])
                if name in RESERVED:
                    raise ValueError("reserved defaults object")
                lines += ["        object " + name + " {"]
                for field, f in t["fields"].items():
                    if "default" not in f:
                        continue
                    domain = f.get("domain", {})
                    kind = domain.get("type")
                    scalar = {"string": "String", "boolean": "Boolean", "number": "Long" if domain.get("integer") else "Double"}.get(kind)
                    if f["kind"] == "ranked":
                        scalar = "String"
                    if scalar:
                        value = f["default"]
                        encoded = "null" if value is None else string(value) if isinstance(value, str) else str(value).lower() if isinstance(value, bool) else repr(float(value)) if scalar == "Double" else str(value) + "L"
                        lines += ["            val " + identifier(field) + ": " + scalar + ("?" if domain.get("nullable") else "") + " = " + encoded]
                    else:
                        lines += ["            val " + identifier(field) + ": Json = " + literal(f["default"])]
                lines += ["        }"]
            lines += ["    }"]
        raw = {key: value for key, value in registry.items() if key != "$schema"}
        lines += ["    val registry: Registry = Registry(Json.parse(", "        listOf("]
        lines += ["            " + string(line) + "," for line in json.dumps(raw, ensure_ascii=True, indent=2).splitlines()]
        lines += ["        ).joinToString(\"\\n\"),", "    ))", "}", ""]
        files[part + ".generated.kt"] = "\n".join(lines)
    validate_semantics([contract / filename for filename in composition["registries"]])
    files["SyncSchema.generated.kt"] = "\n".join([
        "// Generated by tools/schema_gen.py from packages/api-contract/sync/composition.json. Do not edit.",
        "package works.windmill.sync.schema", "", "import works.windmill.sync.core.Registry", "", "object SyncSchema {",
        "    val registry = Registry.compose(" + string(composition["composition"]) + ", listOf(" + ", ".join(part + ".registry" for part in parts) + "))",
        "    val version = registry.version", "}", "",
    ])
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--contract", type=Path, default=CONTRACT)
    parser.add_argument("--output", type=Path, default=TARGET)
    args = parser.parse_args()
    generated = generate(args.contract)
    existing = {p.name: p.read_bytes() for p in args.output.glob("*.kt")}
    stale = sorted(name for name in generated.keys() | existing.keys() if (generated[name].encode() if name in generated else None) != existing.get(name))
    if args.check:
        if stale:
            parser.exit(1, "schema stale: " + ", ".join(stale) + "\n")
    else:
        args.output.mkdir(parents=True, exist_ok=True)
        for name in stale:
            if name in generated:
                (args.output / name).write_text(generated[name])
            else:
                (args.output / name).unlink()
    print("schema: " + str(len(generated)) + " files, " + str(len(stale)) + " stale")


if __name__ == "__main__":
    main()
