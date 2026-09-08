# Journal scroll verification

Verified on 2026-09-08 for the web journal with a guest, device-local entry. iOS is outside this verification.

The composer reserves its current height while the textarea is measured, then releases the reservation. This keeps the scroll extent stable during measurement while allowing deleted text to reduce the field height.

- Local Chromium, desktop 1280 × 800 and narrow 390 × 800: a long 20-paragraph scratch entry stays in place when input preserves its height or adds paragraphs, with no upward scroll jump.
- Replacing the scratch entry with short text reduces the textarea height to 28px.
- All 313 journal tests and all 1,728 web tests pass.
- Independent review has no findings.

Keep the layout reservation local to composer measurement; manual scroll restoration is unnecessary.

The local MCP cannot find dogfood tree `t_9362d9bc883e0a1e` (`no such tree`), so its tracker update is pending.
