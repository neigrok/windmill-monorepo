import { chromium, webkit } from 'playwright';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const missing = [chromium, webkit].filter((engine) => process.env.CI || !existsSync(engine.executablePath()));

if (missing.length > 0) {
  execFileSync(process.execPath, ['node_modules/playwright/cli.js', 'install',
    ...(process.env.CI && process.platform === 'linux' ? ['--with-deps'] : []), ...missing.map((engine) => engine.name())], { stdio: 'inherit' });
}
