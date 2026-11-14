#!/usr/bin/env python3
from pathlib import Path
import os
import re
import subprocess
import tempfile
import textwrap
import unittest


class AiInfrastructureTest(unittest.TestCase):
    def test_deploy_render_refuses_missing_and_malformed_secrets_without_disclosing_them(self):
        root = Path(__file__).resolve().parents[3]
        workflow = (root / ".github/workflows/deploy.yml").read_text()
        start = workflow.index("          missing=\n")
        guard = textwrap.dedent(workflow[start:workflow.index('          if [ "$AI_INSTALLATIONS_ENABLED"', start)])
        environment = {**os.environ, **{key: "configured" for key in
            ("DOMAIN_APP", "DOMAIN_API", "ACME_EMAIL", "POSTGRES_PASSWORD", "RESEND_FROM", "CF_IPS")},
            "SUBSCRIPTIONS_DB_PASSWORD": "a" * 64, "AI_DB_PASSWORD": "c" * 64, "AI_PASS_KEYS": "{}",
            "AI_CARRY_KEY": "A" * 43, "AI_FUNDING_SECRET": "f" * 32, "AI_OPERATOR_SECRET": "o" * 32}
        for key in ("AI_DB_PASSWORD", "AI_CARRY_KEY", "AI_FUNDING_SECRET", "AI_OPERATOR_SECRET"):
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", guard],
                env={**environment, key: ""}, capture_output=True, text=True, timeout=5)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1,
                "Refusing to render — these required values are unset: " + key + "\n"
                "Set them (variables for the domains/email/sender, the database passwords and AI service secrets) and re-run.\n"
                "(CF_IPS is not configured anywhere — if it is listed, both the live fetch and the compose fallback came back empty.)\n", ""))
        for changes in ({"AI_CARRY_KEY": "PRIVATE_CARRY_CANARY"},
                        {"AI_OPERATOR_SECRET": "f" * 32},
                        {"AI_PASS_KEYS": '{"test-private":"' + "A" * 43 + '"}'},
                        {"AI_ANTHROPIC_KEY": "PRIVATE_PROVIDER_CANARY\ninjected=true"},
                        {"AI_OPENAI_KEY": "PRIVATE_PROVIDER_$CANARY"}):
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", guard],
                env={**environment, **changes}, capture_output=True, text=True, timeout=5)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "",
                "Refusing to render — AI database, carry, public keys or internal secrets are invalid.\n"))

    def test_dependency_rule_rejects_normal_and_build_edges_including_renames(self):
        root = Path(__file__).resolve().parents[3]
        script = root / "services/ai/check-dependencies.sh"
        with tempfile.TemporaryDirectory(prefix="ai-dependency-rule-") as directory:
            workspace = Path(directory)
            (workspace / "Cargo.toml").write_text('[workspace]\nmembers = ["domain", "providers", "storage", "server"]\nresolver = "3"\n')
            for name in ("domain", "providers", "storage", "server"):
                crate = workspace / name
                (crate / "src").mkdir(parents=True)
                (crate / "src/lib.rs").write_text("")
                (crate / "Cargo.toml").write_text(f'[package]\nname = "ai-{name}"\nversion = "0.1.0"\nedition = "2024"\n')
            environment = {**os.environ, "RUSTUP_TOOLCHAIN": "1.99.1"}
            for source, target, kind in (("providers", "domain", "dependencies"), ("domain", "storage", "dependencies"), ("providers", "storage", "build-dependencies"), ("storage", "providers", "dependencies"), ("server", "providers", "dependencies")):
                manifest = workspace / source / "Cargo.toml"
                original = manifest.read_text()
                manifest.write_text(original + f'\n[{kind}]\nrenamed = {{ package = "ai-{target}", path = "../{target}" }}\n')
                result = subprocess.run(["bash", str(script), str(workspace)], env=environment, capture_output=True, text=True, timeout=30)
                manifest.write_text(original)
                allowed = target == "domain" or source == "server"
                self.assertEqual(result.returncode, 0 if allowed else 1, result.stderr)
                if not allowed:
                    self.assertIn(f"FAIL AI dependency rule: ai-{source} -> ai-{target}", result.stderr)

    def test_container_grace_covers_service_drain_and_provider_timeout(self):
        root = Path(__file__).resolve().parents[3]
        compose = (root / "backend/deploy/docker-compose.yml").read_text().split("\n  ai:\n", 1)[1].split("\n  caddy:", 1)[0]
        config = (root / "services/ai/crates/server/src/config.rs").read_text()
        grace = int(re.search(r"stop_grace_period: (\d+)s", compose)[1])
        drain = int(re.search(r"pub const DRAIN: Duration = Duration::from_secs\((\d+)\)", config)[1])
        timeout = int(re.search(r"pub const CALL_TIMEOUT: Duration = Duration::from_secs\((\d+)\)", config)[1])
        self.assertGreater(grace, drain)
        self.assertGreater(drain, timeout)
        self.assertEqual((grace, drain, timeout), (720, 660, 600))
        self.assertIn("read_only: true", compose)
        self.assertNotIn("\n    ports:", compose)
        self.assertIn("core:\n        soft: 0\n        hard: 0", compose)
        dockerfile = (root / "services/ai/Dockerfile").read_text()
        self.assertIn("FROM rust:1.99.1-slim-trixie", dockerfile)
        self.assertIn("USER windmill-ai", dockerfile)
        self.assertIn("--bin windmill-ai", dockerfile)


if __name__ == "__main__":
    unittest.main()
