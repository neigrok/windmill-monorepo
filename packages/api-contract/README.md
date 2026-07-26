# api-contract

The wire shapes shared across surfaces — backend, web, and (later) native. One place so the
four surfaces can never drift.

First tenant: the **genesis legend golden**. A locally-born tree's first sync converges with
the server's empty tree only while the frontend's genesis seed is byte-equal to the backend's
(`Legend::seededDefaults` + `Hlc{1,0,"genesis"}`). Before the monorepo these two repos guarded
against drift with a hand-copied constant in `web/vite.config.js`; here the seed is defined
once and imported, so the drift class disappears.

See `genesis.js`.
