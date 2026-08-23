// Self-hosted fonts (via @fontsource) — no external network request: Baloo 2 (display), Nunito
// (body/UI), JetBrains Mono (numeric).
//
// Only the latin + latin-ext subsets are imported. Anything outside those ranges falls back to a
// system font for those glyphs. To restore a script, add its subset entry point here.

// Baloo 2 — display: 500 / 600 / 700 / 800
import '@fontsource/baloo-2/latin-500.css';
import '@fontsource/baloo-2/latin-ext-500.css';
import '@fontsource/baloo-2/latin-600.css';
import '@fontsource/baloo-2/latin-ext-600.css';
import '@fontsource/baloo-2/latin-700.css';
import '@fontsource/baloo-2/latin-ext-700.css';
import '@fontsource/baloo-2/latin-800.css';
import '@fontsource/baloo-2/latin-ext-800.css';

// Nunito — body/UI: 400 / 500 / 600 / 700 / 800
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-ext-400.css';
import '@fontsource/nunito/latin-500.css';
import '@fontsource/nunito/latin-ext-500.css';
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-ext-600.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/nunito/latin-ext-700.css';
import '@fontsource/nunito/latin-800.css';
import '@fontsource/nunito/latin-ext-800.css';

// JetBrains Mono — numeric counters & IDs (ASCII only): 400 / 500 / 600
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
