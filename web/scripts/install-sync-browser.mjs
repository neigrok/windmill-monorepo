import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (process.env.CI || !existsSync(chromium.executablePath())) {
  execFileSync(process.execPath, ['node_modules/playwright/cli.js', 'install',
    ...(process.env.CI && process.platform === 'linux' ? ['--with-deps'] : []), 'chromium'], { stdio: 'inherit' });
}
