use ai_domain::*;
use serde::Deserialize;
use serde_json::{Value, json};

pub fn allowance(value: &Allowance) -> Option<Value> {
    if value.tier == Tier::Background {
        return None;
    }
    Some(json!({
        "tier":value.tier.as_str(),
        "period":value.period.as_str(),
        "limit":value.limit.usd(),
        "used":value.used.usd(),
        "reserved":value.reserved.usd(),
        "remaining":value.remaining.usd(),
        "resetsAt":value.resets_at,
        "budgetResetsAt":value.budget_resets_at,
        "code":value.code.as_str(),
        "capabilities":{"text":{"large":value.text[0].as_str(),
        "medium":value.text[1].as_str(),
        "small":value.text[2].as_str()},
        "transcription":value.transcription}
    }))
}

pub fn status(call: &Call) -> Value {
    json!({
        "callId":call.caller_id.as_str(),
        "capability":call.capability.as_str(),
        "state":call.state.as_str(),
        "stop":call.stop.map(Stop::as_str),
        "code":call.code.map(StaticCode::as_str),
        "served":call.route.served.as_str(),
        "charged":call.charged.map(NanoUsd::usd),
        "endedAt":call.ended_at
    })
}

pub fn call(call: &Call) -> Value {
    json!({
        "id":call.id,
        "principal":{"kind":call.principal.kind(),
        "id":call.principal.id()},
        "callId":call.caller_id.as_str(),
        "capability":call.capability.as_str(),
        "tier":call.tier.as_str(),
        "requested":call.requested.as_str(),
        "served":call.route.served.as_str(),
        "provider":call.route.provider.as_str(),
        "model":call.route.model,
        "priceVersion":call.price_version,
        "label":call.label,
        "client":call.client.as_str(),
        "state":call.state.as_str(),
        "reservation":call.reservation.usd(),
        "charged":call.charged.map(NanoUsd::usd),
        "originalCharge":call.original_charge.map(NanoUsd::usd),
        "maxTokens":call.max_tokens,
        "usage":call.usage.map(|usage|json!({
        "input":usage.input,
        "output":usage.output,
        "cacheWrite":usage.cache_write,
        "cacheWrite1h":usage.cache_write_1h,
        "cacheRead":usage.cache_read})),
        "audioBytes":call.audio_bytes,
        "audioSeconds":call.audio_seconds,
        "turns":call.turns,
        "slices":call.slices,
        "providerRequestId":call.provider_request_id,
        "stop":call.stop.map(Stop::as_str),
        "code":call.code.map(StaticCode::as_str),
        "createdAt":call.created_at,
        "endedAt":call.ended_at
    })
}

pub fn budget(budget: &Budget) -> Value {
    json!({
        "id":budget.id,
        "kind":budget.kind.as_str(),
        "period":budget.period.map(|period|json!({
        "start":period.start,
        "end":period.end})),
        "limit":budget.limit.usd(),
        "spent":budget.spent.usd(),
        "held":budget.held.usd()
    })
}

pub fn principal(mut ledger: PrincipalLedger) -> Value {
    let more = ledger.calls.len() > 1000;
    ledger.calls.truncate(1000);
    let next_before_id = if more {
        ledger.calls.last().map(|call| call.id)
    } else {
        None
    };
    json!({
        "budgets":ledger.budgets.iter().map(budget).collect::<Vec<_>>(),
        "grants":ledger.grants.iter().map(|grant|json!({
        "id":grant.id,
        "reference":grant.reference,
        "accountId":grant.account_id,
        "source":grant.source.as_str(),
        "period":{"start":grant.period.start,
        "end":grant.period.end},
        "closedAt":grant.closed_at,
        "amount":grant.amount.usd(),
        "spent":grant.spent.usd(),
        "held":grant.held.usd()})).collect::<Vec<_>>(),
        "installations":ledger.installations,
        "nextBeforeId":next_before_id,
        "calls":ledger.calls.iter().map(call).collect::<Vec<_>>()
    })
}

pub fn shared(ledger: SharedLedger) -> Value {
    json!({
        "budgets":ledger.budgets.iter().map(budget).collect::<Vec<_>>(),
        "fuses":ledger.fuses.iter().map(|fuse|json!({
        "provider":fuse.provider.as_str(),
        "spent":fuse.spent.usd(),
        "limit":fuse.limit.usd(),
        "paused":fuse.paused})).collect::<Vec<_>>(),
        "backgroundHour":{"spent":ledger.background_hour.spent.usd(),
        "held":ledger.background_hour.held.usd(),
        "limit":ledger.background_hour.limit.usd()}
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FundRequest {
    pub account_id: String,
    pub plan: String,
    pub period: PeriodRequest,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeriodRequest {
    pub start: i64,
    pub end: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloseRequest {
    pub closed_at: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorrectRequest {
    pub charged: String,
}

pub fn identity(claims: crate::pass::Claims) -> Identity {
    Identity {
        principal: match claims.sub.account {
            Some(id) => Principal::Account(id),
            None => Principal::Installation(claims.sub.installation.unwrap_or_default()),
        },
        plan: if claims.plan == Some(crate::pass::Plan::One) {
            Plan::One
        } else {
            Plan::None
        },
        owner_grant: claims.owner_grant == Some(true),
        installation: claims.installation,
        client: match claims.client {
            crate::pass::Client::Ios => Client::Ios,
            crate::pass::Client::Android => Client::Android,
            crate::pass::Client::Web => Client::Web,
            crate::pass::Client::Server => Client::Server,
        },
    }
}
