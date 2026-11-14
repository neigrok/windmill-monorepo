use crate::{ModelClass, ModelRoute, NanoUsd, Provider, StaticCode, TextBudget, Tier, TokenUsage};

#[derive(Clone, Debug)]
pub struct PoolRule {
    pub name: String,
    pub limit: NanoUsd,
}

#[derive(Clone, Debug)]
pub struct TierRule {
    pub tier: Tier,
    pub amount: NanoUsd,
    pub month_pool: Option<PoolRule>,
    pub day_pool: Option<PoolRule>,
    pub in_flight: u32,
    pub calls_per_minute: u32,
    pub output_ceiling: u32,
    pub text: [ModelClass; 3],
    pub transcription: bool,
}

#[derive(Clone, Debug)]
pub struct TextModel {
    pub class: ModelClass,
    pub provider: Provider,
    pub model: String,
}

#[derive(Clone, Debug)]
pub struct LiveModel {
    pub provider: Provider,
    pub model: String,
    pub delay: String,
}

#[derive(Clone, Debug)]
pub struct TierTable {
    pub rows: Vec<TierRule>,
    pub models: Vec<TextModel>,
    pub transcription: LiveModel,
    pub labels: Vec<String>,
    pub owner_grants_max: u32,
    pub hourly_fuse: NanoUsd,
}

impl TierTable {
    pub fn row(&self, tier: Tier) -> Result<&TierRule, StaticCode> {
        self.rows
            .iter()
            .find(|row| row.tier == tier)
            .ok_or(StaticCode::InvalidRequest)
    }

    pub fn route(&self, tier: Tier, requested: ModelClass) -> Result<ModelRoute, StaticCode> {
        let index = match requested {
            ModelClass::Large => 0,
            ModelClass::Medium => 1,
            ModelClass::Small => 2,
        };
        let served = self.row(tier)?.text[index];
        let model = self
            .models
            .iter()
            .find(|model| model.class == served)
            .ok_or(StaticCode::InvalidRequest)?;
        Ok(ModelRoute {
            provider: model.provider,
            model: model.model.clone(),
            served,
        })
    }

    pub fn label(&self, label: &str) -> String {
        if self.labels.iter().any(|known| known == label) {
            return label.to_owned();
        }
        "other".to_owned()
    }

    pub fn validate(&self, prices: &PriceBook) -> Result<(), StaticCode> {
        if self.owner_grants_max == 0
            || self.hourly_fuse == NanoUsd::ZERO
            || !self.labels.iter().any(|label| label == "other")
        {
            return Err(StaticCode::InvalidRequest);
        }
        for tier in [Tier::Anonymous, Tier::Free, Tier::One] {
            if self.rows.iter().filter(|row| row.tier == tier).count() != 1 {
                return Err(StaticCode::InvalidRequest);
            }
            let row = self.row(tier)?;
            if row.amount == NanoUsd::ZERO
                || row.in_flight == 0
                || row.calls_per_minute == 0
                || row.output_ceiling == 0
            {
                return Err(StaticCode::InvalidRequest);
            }
            if tier == Tier::One {
                if row.month_pool.is_some() || row.day_pool.is_some() {
                    return Err(StaticCode::InvalidRequest);
                }
            } else if row.transcription || row.month_pool.is_none() || row.day_pool.is_none() {
                return Err(StaticCode::InvalidRequest);
            }
            for class in [ModelClass::Large, ModelClass::Medium, ModelClass::Small] {
                let route = self.route(tier, class)?;
                prices.model(route.provider, &route.model)?.token_rates(0)?;
            }
        }
        for model in &self.models {
            if self
                .models
                .iter()
                .filter(|other| other.class == model.class)
                .count()
                != 1
            {
                return Err(StaticCode::InvalidRequest);
            }
        }
        prices
            .model(self.transcription.provider, &self.transcription.model)?
            .audio_rate()?;
        prices.validate()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TokenRates {
    pub input: NanoUsd,
    pub output: NanoUsd,
    pub cache_write: NanoUsd,
    pub cache_write_1h: NanoUsd,
    pub cache_read: NanoUsd,
}

#[derive(Clone, Debug)]
pub struct ModelPrice {
    pub provider: Provider,
    pub model: String,
    pub tokens: Option<TokenRates>,
    pub long_prompt: Option<(u64, TokenRates)>,
    pub audio_per_minute: Option<NanoUsd>,
    pub audio_billing_verified: bool,
    pub source: String,
    pub checked_at: String,
}

impl ModelPrice {
    pub fn token_rates(&self, prompt_tokens: u64) -> Result<TokenRates, StaticCode> {
        if let Some((threshold, rates)) = self.long_prompt
            && prompt_tokens > threshold
        {
            return Ok(rates);
        }
        self.tokens.ok_or(StaticCode::InvalidRequest)
    }

    pub fn audio_rate(&self) -> Result<NanoUsd, StaticCode> {
        self.audio_per_minute.ok_or(StaticCode::InvalidRequest)
    }

    pub fn text_cost(&self, usage: TokenUsage) -> Result<NanoUsd, StaticCode> {
        let prompt = usage
            .input
            .checked_add(usage.cache_write)
            .and_then(|v| v.checked_add(usage.cache_write_1h))
            .and_then(|v| v.checked_add(usage.cache_read))
            .ok_or(StaticCode::InvalidRequest)?;
        let rates = self.token_rates(prompt)?;
        rates
            .input
            .checked_mul(usage.input)?
            .checked_add(rates.output.checked_mul(usage.output)?)?
            .checked_add(rates.cache_write.checked_mul(usage.cache_write)?)?
            .checked_add(rates.cache_write_1h.checked_mul(usage.cache_write_1h)?)?
            .checked_add(rates.cache_read.checked_mul(usage.cache_read)?)
    }

    pub fn audio_cost(&self, seconds: u64) -> Result<NanoUsd, StaticCode> {
        self.audio_rate()?.ratio_ceil(seconds, 60)
    }

    pub fn reserve_text(
        &self,
        request: TextBudget,
        ceiling: u32,
        budgets: &[(NanoUsd, StaticCode)],
    ) -> Result<(u32, NanoUsd), StaticCode> {
        let maximum = request.max_tokens.min(ceiling);
        let minimum = request.min_tokens.unwrap_or(maximum);
        if minimum == 0 || maximum == 0 || minimum > maximum {
            return Err(StaticCode::InvalidRequest);
        }
        let input = request
            .input_tokens
            .checked_mul(102)
            .and_then(|v| v.checked_add(99))
            .map(|v| v / 100)
            .and_then(|v| v.checked_add(64))
            .ok_or(StaticCode::InvalidRequest)?;
        let rates = self.token_rates(input)?;
        let input_cost = if request.cache {
            rates.cache_write
        } else {
            rates.input
        }
        .checked_mul(input)?;
        let minimum_cost = input_cost.checked_add(rates.output.checked_mul(u64::from(minimum))?)?;
        let maximum_cost = input_cost.checked_add(rates.output.checked_mul(u64::from(maximum))?)?;
        let mut cap = maximum;
        for (remaining, refusal) in budgets {
            if minimum_cost > *remaining {
                return Err(*refusal);
            }
            if maximum_cost > *remaining && rates.output > NanoUsd::ZERO {
                let affordable = remaining.checked_sub(input_cost)?.nanos() / rates.output.nanos();
                cap = cap.min(u32::try_from(affordable).unwrap_or(u32::MAX));
            }
        }
        Ok((
            cap,
            input_cost.checked_add(rates.output.checked_mul(u64::from(cap))?)?,
        ))
    }
}

#[derive(Clone, Debug)]
pub struct PriceBook {
    pub version: String,
    pub models: Vec<ModelPrice>,
}

impl PriceBook {
    pub fn model(&self, provider: Provider, model: &str) -> Result<&ModelPrice, StaticCode> {
        self.models
            .iter()
            .find(|price| price.provider == provider && price.model == model)
            .ok_or(StaticCode::InvalidRequest)
    }

    pub fn validate(&self) -> Result<(), StaticCode> {
        if self.version.is_empty() || self.version.len() > 64 {
            return Err(StaticCode::InvalidRequest);
        }
        for model in &self.models {
            if model.model.is_empty()
                || model.model.len() > 128
                || model.source.is_empty()
                || model.checked_at.is_empty()
                || (model.tokens.is_none() && model.audio_per_minute.is_none())
                || self
                    .models
                    .iter()
                    .filter(|price| price.provider == model.provider && price.model == model.model)
                    .count()
                    != 1
            {
                return Err(StaticCode::InvalidRequest);
            }
        }
        Ok(())
    }
}

pub fn rounded_audio_seconds(turn_bytes: &[u64]) -> Result<u64, StaticCode> {
    turn_bytes.iter().try_fold(0_u64, |total, bytes| {
        if bytes % 2 != 0 {
            return Err(StaticCode::InvalidRequest);
        }
        let seconds = bytes
            .checked_add(47_999)
            .ok_or(StaticCode::InvalidRequest)?
            / 48_000;
        total.checked_add(seconds).ok_or(StaticCode::InvalidRequest)
    })
}

pub fn validate_audio(bytes: u64, seconds: u64, turns: u32) -> Result<(), StaticCode> {
    if bytes == 0 {
        if seconds == 0 && turns == 0 {
            return Ok(());
        }
        return Err(StaticCode::InvalidRequest);
    }
    let minimum = rounded_audio_seconds(&[bytes])?;
    let maximum = minimum
        .checked_add(u64::from(turns.saturating_sub(1)))
        .ok_or(StaticCode::InvalidRequest)?;
    if turns == 0 || seconds < minimum || seconds > maximum || u64::from(turns) > seconds {
        return Err(StaticCode::InvalidRequest);
    }
    Ok(())
}
