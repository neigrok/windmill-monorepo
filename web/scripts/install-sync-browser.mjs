import { chromium, webkit } from 'playwright';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// On CI, .github/actions/browser-system-libraries installs the Ubuntu libraries these browsers need.
const missing = [chromium, webkit].filter((engine) => !existsSync(engine.executablePath()));

if (missing.length > 0) {
  execFileSync(process.execPath, ['node_modules/playwright/cli.js', 'install', ...missing.map((engine) => engine.name())],
    { stdio: 'inherit' });
}
