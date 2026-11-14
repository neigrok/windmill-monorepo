CREATE TABLE ai_budgets (
    id BIGSERIAL PRIMARY KEY,
    budget_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('installation', 'account_month', 'free_month', 'free_day', 'grant')),
    principal_kind TEXT,
    principal_id TEXT,
    period_start BIGINT,
    period_end BIGINT,
    limit_nanos BIGINT NOT NULL CHECK (limit_nanos >= 0),
    spent BIGINT NOT NULL DEFAULT 0 CHECK (spent >= 0),
    held BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
    CHECK ((period_start IS NULL AND period_end IS NULL) OR period_start < period_end)
);

CREATE TABLE ai_grants (
    id BIGSERIAL PRIMARY KEY,
    reference TEXT NOT NULL,
    account_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('subscription', 'owner')),
    plan TEXT NOT NULL CHECK (plan = 'one'),
    period_start BIGINT NOT NULL,
    period_end BIGINT NOT NULL,
    closed_at BIGINT,
    budget_id BIGINT NOT NULL UNIQUE REFERENCES ai_budgets(id),
    UNIQUE (source, reference),
    CHECK (period_start >= 0 AND period_start < period_end)
);
CREATE INDEX ai_grants_account ON ai_grants(account_id, source, period_start, period_end);

CREATE TABLE ai_bindings (
    installation_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    bound_at BIGINT NOT NULL
);
CREATE INDEX ai_bindings_account ON ai_bindings(account_id);

CREATE TABLE ai_installation_months (
    installation_id TEXT NOT NULL,
    month_start BIGINT NOT NULL,
    spent BIGINT NOT NULL DEFAULT 0 CHECK (spent >= 0),
    held BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
    PRIMARY KEY (installation_id, month_start)
);

CREATE TABLE ai_calls (
    id BIGSERIAL PRIMARY KEY,
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('installation', 'account')),
    principal_id TEXT NOT NULL,
    caller_id TEXT NOT NULL,
    capability TEXT NOT NULL CHECK (capability IN ('text', 'transcription')),
    tier TEXT NOT NULL CHECK (tier IN ('anonymous', 'free', 'one')),
    requested TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    served TEXT NOT NULL,
    price_version TEXT NOT NULL,
    label TEXT NOT NULL,
    client TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'settled', 'unconsumed', 'assumed')),
    reservation BIGINT NOT NULL CHECK (reservation >= 0),
    applied BIGINT NOT NULL DEFAULT 0 CHECK (applied >= 0),
    held BIGINT NOT NULL CHECK (held >= 0),
    charged BIGINT CHECK (charged >= 0),
    original_charge BIGINT CHECK (original_charge >= 0),
    max_tokens INTEGER,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cache_write_tokens BIGINT,
    cache_write_1h_tokens BIGINT,
    cache_read_tokens BIGINT,
    audio_bytes BIGINT NOT NULL DEFAULT 0 CHECK (audio_bytes >= 0),
    audio_seconds BIGINT NOT NULL DEFAULT 0 CHECK (audio_seconds >= 0),
    turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
    slices INTEGER NOT NULL DEFAULT 0 CHECK (slices >= 0),
    provider_request_id TEXT,
    stop TEXT,
    code TEXT,
    month_start BIGINT NOT NULL,
    instance TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    dispatched_at BIGINT,
    ended_at BIGINT,
    UNIQUE(principal_kind, principal_id, caller_id),
    CHECK ((state IN ('reserved', 'dispatched') AND charged IS NULL AND ended_at IS NULL)
        OR (state IN ('settled', 'unconsumed', 'assumed') AND charged IS NOT NULL AND ended_at IS NOT NULL AND held = 0))
);
CREATE INDEX ai_calls_open ON ai_calls(principal_kind, principal_id) WHERE state IN ('reserved', 'dispatched');
CREATE INDEX ai_calls_ended ON ai_calls(ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX ai_calls_caller ON ai_calls(caller_id);

CREATE TABLE ai_call_prices (
    call_id BIGINT PRIMARY KEY REFERENCES ai_calls(id) ON DELETE CASCADE,
    input_rate BIGINT,
    output_rate BIGINT,
    cache_write_rate BIGINT,
    cache_write_1h_rate BIGINT,
    cache_read_rate BIGINT,
    long_threshold BIGINT,
    long_input_rate BIGINT,
    long_output_rate BIGINT,
    long_cache_write_rate BIGINT,
    long_cache_write_1h_rate BIGINT,
    long_cache_read_rate BIGINT,
    audio_rate BIGINT,
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL
);

CREATE TABLE ai_call_budgets (
    call_id BIGINT NOT NULL REFERENCES ai_calls(id) ON DELETE CASCADE,
    budget_id BIGINT NOT NULL REFERENCES ai_budgets(id),
    PRIMARY KEY(call_id, budget_id)
);

CREATE TABLE ai_spend_events (
    id BIGSERIAL PRIMARY KEY,
    call_id BIGINT REFERENCES ai_calls(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    at BIGINT NOT NULL,
    delta BIGINT NOT NULL
);
CREATE INDEX ai_spend_events_provider_time ON ai_spend_events(provider, at);

CREATE TABLE ai_thresholds (
    budget_id BIGINT NOT NULL REFERENCES ai_budgets(id),
    percent SMALLINT NOT NULL CHECK (percent IN (50, 80, 95)),
    PRIMARY KEY(budget_id, percent)
);
CREATE TABLE ai_threshold_outbox (
    budget_id BIGINT NOT NULL REFERENCES ai_budgets(id),
    percent SMALLINT NOT NULL,
    PRIMARY KEY(budget_id, percent)
);
