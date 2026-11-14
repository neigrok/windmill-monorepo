use ai_domain::*;
use sqlx::{Decode, Postgres, Row, Type, postgres::PgRow};

pub(crate) fn value<'r, T: Decode<'r, Postgres> + Type<Postgres>>(
    row: &'r PgRow,
    name: &str,
) -> Result<T, StaticCode> {
    row.try_get(name)
        .map_err(|_| StaticCode::AccountingUnavailable)
}

pub(crate) fn money(row: &PgRow, name: &str) -> Result<NanoUsd, StaticCode> {
    NanoUsd::new(value(row, name)?).map_err(|_| StaticCode::AccountingUnavailable)
}

pub(crate) fn budget(row: &PgRow) -> Result<Budget, StaticCode> {
    let start: Option<i64> = value(row, "period_start")?;
    let end: Option<i64> = value(row, "period_end")?;
    let period = match (start, end) {
        (Some(start), Some(end)) => Some(Period::new(start, end)?),
        (None, None) => None,
        _ => return Err(StaticCode::AccountingUnavailable),
    };
    Ok(Budget {
        id: value(row, "id")?,
        kind: value(row, "kind")?,
        period,
        limit: money(row, "limit_nanos")?,
        spent: money(row, "spent")?,
        held: money(row, "held")?,
    })
}

pub(crate) fn grant(row: &PgRow) -> Result<Grant, StaticCode> {
    Ok(Grant {
        id: value(row, "id")?,
        reference: value(row, "reference")?,
        account_id: value(row, "account_id")?,
        source: GrantSource::parse(value(row, "source")?)?,
        period: Period::new(value(row, "period_start")?, value(row, "period_end")?)?,
        closed_at: value(row, "closed_at")?,
        amount: money(row, "limit_nanos")?,
        spent: money(row, "spent")?,
        held: money(row, "held")?,
    })
}

pub(crate) fn call(row: &PgRow) -> Result<Call, StaticCode> {
    let input: Option<i64> = value(row, "input_tokens")?;
    let usage = if let Some(input) = input {
        Some(TokenUsage {
            input: u64::try_from(input).map_err(|_| StaticCode::AccountingUnavailable)?,
            output: unsigned(row, "output_tokens")?,
            cache_write: unsigned(row, "cache_write_tokens")?,
            cache_write_1h: unsigned(row, "cache_write_1h_tokens")?,
            cache_read: unsigned(row, "cache_read_tokens")?,
        })
    } else {
        None
    };
    let charge: Option<i64> = value(row, "charged")?;
    let original: Option<i64> = value(row, "original_charge")?;
    let max_tokens: Option<i32> = value(row, "max_tokens")?;
    let stop: Option<&str> = value(row, "stop")?;
    let code: Option<&str> = value(row, "code")?;
    Ok(Call {
        id: value(row, "id")?,
        principal: Principal::new(value(row, "principal_kind")?, value(row, "principal_id")?)?,
        caller_id: CallerId::new(value(row, "caller_id")?)?,
        capability: Capability::parse(value(row, "capability")?)?,
        tier: Tier::parse(value(row, "tier")?)?,
        requested: ModelClass::parse(value(row, "requested")?)?,
        route: ModelRoute {
            provider: Provider::parse(value(row, "provider")?)?,
            model: value(row, "model")?,
            served: ModelClass::parse(value(row, "served")?)?,
        },
        price_version: value(row, "price_version")?,
        label: value(row, "label")?,
        client: Client::parse(value(row, "client")?)?,
        state: CallState::parse(value(row, "state")?)?,
        reservation: money(row, "reservation")?,
        charged: charge.map(NanoUsd::new).transpose()?,
        original_charge: original.map(NanoUsd::new).transpose()?,
        max_tokens: max_tokens
            .map(|value| u32::try_from(value).map_err(|_| StaticCode::AccountingUnavailable))
            .transpose()?,
        usage,
        audio_bytes: unsigned(row, "audio_bytes")?,
        audio_seconds: unsigned(row, "audio_seconds")?,
        turns: u32::try_from(value::<i32>(row, "turns")?)
            .map_err(|_| StaticCode::AccountingUnavailable)?,
        slices: u32::try_from(value::<i32>(row, "slices")?)
            .map_err(|_| StaticCode::AccountingUnavailable)?,
        provider_request_id: value(row, "provider_request_id")?,
        stop: stop.map(Stop::parse).transpose()?,
        code: code.map(StaticCode::parse).transpose()?,
        created_at: value(row, "created_at")?,
        ended_at: value(row, "ended_at")?,
    })
}

pub(crate) fn unsigned(row: &PgRow, name: &str) -> Result<u64, StaticCode> {
    u64::try_from(value::<i64>(row, name)?).map_err(|_| StaticCode::AccountingUnavailable)
}

pub(crate) fn price(row: &PgRow, call: &Call) -> Result<ModelPrice, StaticCode> {
    let input: Option<i64> = value(row, "input_rate")?;
    let tokens = if let Some(input) = input {
        Some(TokenRates {
            input: NanoUsd::new(input)?,
            output: money(row, "output_rate")?,
            cache_write: money(row, "cache_write_rate")?,
            cache_write_1h: money(row, "cache_write_1h_rate")?,
            cache_read: money(row, "cache_read_rate")?,
        })
    } else {
        None
    };
    let threshold: Option<i64> = value(row, "long_threshold")?;
    let long_prompt = if let Some(threshold) = threshold {
        Some((
            u64::try_from(threshold).map_err(|_| StaticCode::AccountingUnavailable)?,
            TokenRates {
                input: money(row, "long_input_rate")?,
                output: money(row, "long_output_rate")?,
                cache_write: money(row, "long_cache_write_rate")?,
                cache_write_1h: money(row, "long_cache_write_1h_rate")?,
                cache_read: money(row, "long_cache_read_rate")?,
            },
        ))
    } else {
        None
    };
    let audio: Option<i64> = value(row, "audio_rate")?;
    Ok(ModelPrice {
        provider: call.route.provider,
        model: call.route.model.clone(),
        tokens,
        long_prompt,
        audio_per_minute: audio.map(NanoUsd::new).transpose()?,
        audio_billing_verified: false,
        source: value(row, "source")?,
        checked_at: value(row, "checked_at")?,
    })
}
