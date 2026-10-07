from pathlib import Path
import re
import subprocess
import unittest


WORKFLOW = Path(__file__).resolve().parents[3] / ".github/workflows/deploy.yml"
SETTINGS = {"APPLE_NATIVE_ENABLED": "0", "APPLE_CLIENT_ID": ""}


class DeployAuthEnvironmentTest(unittest.TestCase):
    def test_account_backup_settings_use_vars_and_safe_defaults(self):
        workflow = WORKFLOW.read_text()
        for name, default in SETTINGS.items():
            with self.subTest(name=name):
                expected = f"{name}: ${{{{ vars.{name} || '{default}' }}}}"
                self.assertTrue(expected in workflow, f"missing {expected}")

    def test_render_preserves_account_backup_configuration(self):
        workflow = WORKFLOW.read_text()
        render = re.search(r"for key in POSTGRES_PASSWORD[\s\S]*?\n\s*done", workflow).group()
        names = render.partition("; do")[0].replace("\\", "").split()[3:]
        environment = {name: f"configured-{name}" for name in names}
        environment.update({name: f"configured-{name}" for name in SETTINGS})
        run = subprocess.run(["bash", "-euc", render], env=environment,
                             check=True, capture_output=True, text=True)
        rendered = dict(line.split("=", 1) for line in run.stdout.splitlines())
        for name in SETTINGS:
            with self.subTest(name=name):
                self.assertEqual(rendered.get(name), f"configured-{name}")


if __name__ == "__main__":
    unittest.main()
