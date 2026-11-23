ALTER TABLE ai_calls DROP CONSTRAINT ai_calls_tier_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_tier_check
    CHECK (tier IN ('anonymous', 'free', 'one', 'background'));

ALTER TABLE ai_budgets DROP CONSTRAINT ai_budgets_kind_check;
ALTER TABLE ai_budgets ADD CONSTRAINT ai_budgets_kind_check
    CHECK (kind IN ('installation', 'account_month', 'free_month', 'free_day', 'grant',
        'background_account_month', 'background_month', 'background_day'));

CREATE INDEX ai_spend_events_time ON ai_spend_events(at);
