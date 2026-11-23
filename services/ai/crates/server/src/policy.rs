use ai_domain::*;
use ai_providers::{Effort, ModelProfile, Reasoning};
use serde::Deserialize;

pub struct Policy {
    pub tiers: TierTable,
    pub prices: PriceBook,
    pub profiles: Vec<ModelProfile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TiersIn {
    owner_grants_max: u32,
    hourly_fuse: String,
    labels: Vec<String>,
    transcription: LiveIn,
    models: Vec<ModelIn>,
    rows: Vec<RowIn>,
    background: BackgroundIn,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveIn {
    provider: String,
    model: String,
    delay: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelIn {
    class: String,
    provider: String,
    model: String,
    reasoning: String,
    efforts: Vec<String>,
    image_token_ceiling: u64,
    tool_overhead_tokens: u64,
    count_source: Vec<String>,
    count_checked_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RowIn {
    tier: String,
    amount: String,
    month_pool: Option<PoolIn>,
    day_pool: Option<PoolIn>,
    in_flight: u32,
    calls_per_minute: u32,
    output_ceiling: u32,
    text: [String; 3],
    transcription: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackgroundIn {
    amount: String,
    month: String,
    day: String,
    hour: String,
    in_flight: u32,
    calls_per_minute: u32,
    output_ceiling: u32,
    text: [String; 3],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PoolIn {
    name: String,
    limit: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PricesIn {
    version: String,
    models: Vec<PriceIn>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PriceIn {
    provider: String,
    model: String,
    tokens: Option<RatesIn>,
    long_prompt: Option<LongIn>,
    audio_per_minute: Option<String>,
    audio_billing_verified: bool,
    source: String,
    checked_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RatesIn {
    input: String,
    output: String,
    cache_write: String,
    cache_write_1h: String,
    cache_read: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LongIn {
    threshold: u64,
    tokens: RatesIn,
}

impl RatesIn {
    fn domain(self) -> Result<TokenRates, StaticCode> {
        Ok(TokenRates {
            input: NanoUsd::from_usd(&self.input)?,
            output: NanoUsd::from_usd(&self.output)?,
            cache_write: NanoUsd::from_usd(&self.cache_write)?,
            cache_write_1h: NanoUsd::from_usd(&self.cache_write_1h)?,
            cache_read: NanoUsd::from_usd(&self.cache_read)?,
        })
    }
}
impl PoolIn {
    fn domain(self) -> Result<PoolRule, StaticCode> {
        Ok(PoolRule {
            name: self.name,
            limit: NanoUsd::from_usd(&self.limit)?,
        })
    }
}

impl Policy {
    pub fn parse(tiers: &str, prices: &str) -> Result<Self, StaticCode> {
        let tiers: TiersIn = toml::from_str(tiers).map_err(|_| StaticCode::InvalidRequest)?;
        let prices: PricesIn = toml::from_str(prices).map_err(|_| StaticCode::InvalidRequest)?;
        let mut rows = vec![];
        for row in tiers.rows {
            rows.push(TierRule {
                tier: Tier::parse(&row.tier)?,
                amount: NanoUsd::from_usd(&row.amount)?,
                month_pool: row.month_pool.map(PoolIn::domain).transpose()?,
                day_pool: row.day_pool.map(PoolIn::domain).transpose()?,
                in_flight: row.in_flight,
                calls_per_minute: row.calls_per_minute,
                output_ceiling: row.output_ceiling,
                text: [
                    ModelClass::parse(&row.text[0])?,
                    ModelClass::parse(&row.text[1])?,
                    ModelClass::parse(&row.text[2])?,
                ],
                transcription: row.transcription,
            });
        }
        let background = tiers.background;
        let background_pool = |limit: &str| {
            Ok::<_, StaticCode>(PoolRule {
                name: "background".to_owned(),
                limit: NanoUsd::from_usd(limit)?,
            })
        };
        rows.push(TierRule {
            tier: Tier::Background,
            amount: NanoUsd::from_usd(&background.amount)?,
            month_pool: Some(background_pool(&background.month)?),
            day_pool: Some(background_pool(&background.day)?),
            in_flight: background.in_flight,
            calls_per_minute: background.calls_per_minute,
            output_ceiling: background.output_ceiling,
            text: [
                ModelClass::parse(&background.text[0])?,
                ModelClass::parse(&background.text[1])?,
                ModelClass::parse(&background.text[2])?,
            ],
            transcription: false,
        });
        let mut models = vec![];
        let mut profiles = vec![];
        for model in tiers.models {
            models.push(TextModel {
                class: ModelClass::parse(&model.class)?,
                provider: Provider::parse(&model.provider)?,
                model: model.model.clone(),
            });
            let allowed = ["low", "medium", "high", "xhigh", "max"];
            let mut last = None;
            for effort in &model.efforts {
                let rank = allowed
                    .iter()
                    .position(|value| *value == effort)
                    .ok_or(StaticCode::InvalidRequest)?;
                if last.is_some_and(|previous| previous >= rank) {
                    return Err(StaticCode::InvalidRequest);
                }
                last = Some(rank);
            }
            if model.image_token_ceiling == 0
                || model.tool_overhead_tokens == 0
                || (model.count_source.is_empty()
                    || model.count_source.iter().any(String::is_empty))
                || model.count_checked_at.is_empty()
            {
                return Err(StaticCode::InvalidRequest);
            }
            let max_effort = match model.efforts.last().map(String::as_str) {
                Some("low") => Effort::Low,
                Some("medium") => Effort::Medium,
                Some("high") => Effort::High,
                Some("xhigh") => Effort::Xhigh,
                Some("max") => Effort::Max,
                _ => return Err(StaticCode::InvalidRequest),
            };
            profiles.push(ModelProfile {
                model: model.model,
                reasoning: match model.reasoning.as_str() {
                    "adaptive" => Reasoning::Adaptive,
                    "disabled" => Reasoning::Disabled,
                    "budget" => Reasoning::Budget,
                    _ => return Err(StaticCode::InvalidRequest),
                },
                max_effort,
                image_token_ceiling: model.image_token_ceiling,
                tool_overhead_tokens: model.tool_overhead_tokens,
            });
        }
        if models
            .iter()
            .any(|model| model.provider != Provider::Anthropic)
        {
            return Err(StaticCode::InvalidRequest);
        }
        if !matches!(
            Provider::parse(&tiers.transcription.provider)?,
            Provider::OpenAi | Provider::Azure
        ) {
            return Err(StaticCode::InvalidRequest);
        }
        let tiers = TierTable {
            rows,
            models,
            transcription: LiveModel {
                provider: Provider::parse(&tiers.transcription.provider)?,
                model: tiers.transcription.model,
                delay: tiers.transcription.delay,
            },
            labels: tiers.labels,
            owner_grants_max: tiers.owner_grants_max,
            hourly_fuse: NanoUsd::from_usd(&tiers.hourly_fuse)?,
            background_hour: NanoUsd::from_usd(&background.hour)?,
        };
        let mut models = vec![];
        for price in prices.models {
            models.push(ModelPrice {
                provider: Provider::parse(&price.provider)?,
                model: price.model,
                tokens: price.tokens.map(RatesIn::domain).transpose()?,
                long_prompt: price
                    .long_prompt
                    .map(|value| Ok::<_, StaticCode>((value.threshold, value.tokens.domain()?)))
                    .transpose()?,
                audio_per_minute: price
                    .audio_per_minute
                    .map(|value| NanoUsd::from_usd(&value))
                    .transpose()?,
                audio_billing_verified: price.audio_billing_verified,
                source: price.source,
                checked_at: price.checked_at,
            });
        }
        let prices = PriceBook {
            version: prices.version,
            models,
        };
        tiers.validate(&prices)?;
        Ok(Self {
            tiers,
            prices,
            profiles,
        })
    }
}
