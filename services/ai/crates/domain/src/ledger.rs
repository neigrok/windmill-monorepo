use crate::{NanoUsd, Period};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaticCode {
    Ok,
    InvalidRequest,
    Conflict,
    NotFound,
    CallUnknown,
    DeviceBound,
    FundingRequired,
    ConcurrencyExhausted,
    SubjectExhausted,
    FreeMonthExhausted,
    FreeDayExhausted,
    RateLimited,
    Busy,
    Paused,
    AccountingUnavailable,
    ProviderRejected,
    ProviderUnavailable,
    ProviderFailed,
    OwnerGrantCap,
    BindingContradiction,
    ResultGone,
    SessionLimit,
    Idle,
    WentAway,
    Restarting,
    TooLarge,
}

impl StaticCode {
    pub fn parse(value: &str) -> Result<Self, Self> {
        [
            Self::Ok,
            Self::InvalidRequest,
            Self::Conflict,
            Self::NotFound,
            Self::CallUnknown,
            Self::DeviceBound,
            Self::FundingRequired,
            Self::ConcurrencyExhausted,
            Self::SubjectExhausted,
            Self::FreeMonthExhausted,
            Self::FreeDayExhausted,
            Self::RateLimited,
            Self::Busy,
            Self::Paused,
            Self::AccountingUnavailable,
            Self::ProviderRejected,
            Self::ProviderUnavailable,
            Self::ProviderFailed,
            Self::OwnerGrantCap,
            Self::BindingContradiction,
            Self::ResultGone,
            Self::SessionLimit,
            Self::Idle,
            Self::WentAway,
            Self::Restarting,
            Self::TooLarge,
        ]
        .into_iter()
        .find(|code| code.as_str() == value)
        .ok_or(Self::InvalidRequest)
    }
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::InvalidRequest => "invalid_request",
            Self::Conflict => "conflict",
            Self::NotFound => "not_found",
            Self::CallUnknown => "call_unknown",
            Self::DeviceBound => "device_bound",
            Self::FundingRequired => "funding_required",
            Self::ConcurrencyExhausted => "concurrency_exhausted",
            Self::SubjectExhausted => "subject_exhausted",
            Self::FreeMonthExhausted => "free_month_exhausted",
            Self::FreeDayExhausted => "free_day_exhausted",
            Self::RateLimited => "rate_limited",
            Self::Busy => "busy",
            Self::Paused => "paused",
            Self::AccountingUnavailable => "accounting_unavailable",
            Self::ProviderRejected => "provider_rejected",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::ProviderFailed => "provider_failed",
            Self::OwnerGrantCap => "owner_grant_cap",
            Self::BindingContradiction => "binding_contradiction",
            Self::ResultGone => "result_gone",
            Self::SessionLimit => "session_limit",
            Self::Idle => "idle",
            Self::WentAway => "went_away",
            Self::Restarting => "restarting",
            Self::TooLarge => "too_large",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum Principal {
    Installation(String),
    Account(String),
}

impl Principal {
    pub fn new(kind: &str, id: String) -> Result<Self, StaticCode> {
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
            return Err(StaticCode::InvalidRequest);
        }
        match kind {
            "installation" => Ok(Self::Installation(id)),
            "account" => Ok(Self::Account(id)),
            _ => Err(StaticCode::InvalidRequest),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Installation(_) => "installation",
            Self::Account(_) => "account",
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Self::Installation(id) | Self::Account(id) => id,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CallerId(String);

impl CallerId {
    pub fn new(value: String) -> Result<Self, StaticCode> {
        if !(22..=64).contains(&value.len())
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err(StaticCode::InvalidRequest);
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    None,
    One,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Anonymous,
    Free,
    One,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capability {
    Text,
    Transcription,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelClass {
    Large,
    Medium,
    Small,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenAi,
    Azure,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    Ios,
    Android,
    Web,
    Server,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallState {
    Reserved,
    Dispatched,
    Settled,
    Unconsumed,
    Assumed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Completed,
    ToolCalls,
    Truncated,
    Declined,
    Cut,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantSource {
    Subscription,
    Owner,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantOutcome {
    Ok,
    Replay,
    Conflict,
    NotFound,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AllowancePeriod {
    Lifetime,
    CalendarMonthUtc,
    BillingPeriod,
}

macro_rules! labels {
    ($kind:ty, $($variant:path => $label:literal),+ $(,)?) => {
        impl $kind {
            pub const fn as_str(self) -> &'static str { match self { $($variant => $label),+ } }
            pub fn parse(value: &str) -> Result<Self, StaticCode> { match value { $($label => Ok($variant),)+ _ => Err(StaticCode::InvalidRequest) } }
        }
    };
}
labels!(Plan, Plan::None => "none", Plan::One => "one");
labels!(Tier, Tier::Anonymous => "anonymous", Tier::Free => "free", Tier::One => "one");
labels!(Capability, Capability::Text => "text", Capability::Transcription => "transcription");
labels!(ModelClass, ModelClass::Large => "large", ModelClass::Medium => "medium", ModelClass::Small => "small");
labels!(Provider, Provider::Anthropic => "anthropic", Provider::OpenAi => "openai", Provider::Azure => "azure");
labels!(Client, Client::Ios => "ios", Client::Android => "android", Client::Web => "web", Client::Server => "server");
labels!(CallState, CallState::Reserved => "reserved", CallState::Dispatched => "dispatched", CallState::Settled => "settled", CallState::Unconsumed => "unconsumed", CallState::Assumed => "assumed");
labels!(Stop, Stop::Completed => "completed", Stop::ToolCalls => "tool_calls", Stop::Truncated => "truncated", Stop::Declined => "declined", Stop::Cut => "cut");
labels!(GrantSource, GrantSource::Subscription => "subscription", GrantSource::Owner => "owner");
labels!(GrantOutcome, GrantOutcome::Ok => "ok", GrantOutcome::Replay => "replay", GrantOutcome::Conflict => "conflict", GrantOutcome::NotFound => "not_found");
labels!(AllowancePeriod, AllowancePeriod::Lifetime => "lifetime", AllowancePeriod::CalendarMonthUtc => "calendar_month_utc", AllowancePeriod::BillingPeriod => "billing_period");

impl CallState {
    pub fn is_open(self) -> bool {
        matches!(self, Self::Reserved | Self::Dispatched)
    }
}

#[derive(Clone)]
pub struct Identity {
    pub principal: Principal,
    pub plan: Plan,
    pub owner_grant: bool,
    pub installation: Option<String>,
    pub client: Client,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_write_1h: u64,
    pub cache_read: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRoute {
    pub provider: Provider,
    pub model: String,
    pub served: ModelClass,
}

#[derive(Clone, Copy, Debug)]
pub struct TextBudget {
    pub input_tokens: u64,
    pub max_tokens: u32,
    pub min_tokens: Option<u32>,
    pub cache: bool,
}

#[derive(Clone, Debug)]
pub enum Reservation {
    Text(TextBudget),
    Transcription,
}

pub struct Admission {
    pub identity: Identity,
    pub caller_id: CallerId,
    pub label: String,
    pub requested: ModelClass,
    pub expected_route: ModelRoute,
    pub reservation: Reservation,
}

#[derive(Clone)]
pub struct Call {
    pub id: i64,
    pub principal: Principal,
    pub caller_id: CallerId,
    pub capability: Capability,
    pub tier: Tier,
    pub requested: ModelClass,
    pub route: ModelRoute,
    pub price_version: String,
    pub label: String,
    pub client: Client,
    pub state: CallState,
    pub reservation: NanoUsd,
    pub charged: Option<NanoUsd>,
    pub original_charge: Option<NanoUsd>,
    pub max_tokens: Option<u32>,
    pub usage: Option<TokenUsage>,
    pub audio_bytes: u64,
    pub audio_seconds: u64,
    pub turns: u32,
    pub slices: u32,
    pub provider_request_id: Option<String>,
    pub stop: Option<Stop>,
    pub code: Option<StaticCode>,
    pub created_at: i64,
    pub ended_at: Option<i64>,
}

pub enum AdmissionOutcome {
    Admitted(Call),
    Existing(Call),
}

#[derive(Clone, Debug)]
pub struct Allowance {
    pub tier: Tier,
    pub period: AllowancePeriod,
    pub limit: NanoUsd,
    pub used: NanoUsd,
    pub reserved: NanoUsd,
    pub remaining: NanoUsd,
    pub resets_at: Option<i64>,
    pub budget_resets_at: Option<i64>,
    pub code: StaticCode,
    pub text: [ModelClass; 3],
    pub transcription: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum Charge {
    Usage(TokenUsage),
    Audio {
        bytes: u64,
        seconds: u64,
        turns: u32,
    },
    Unconsumed,
    Assumed,
}

#[derive(Clone)]
pub struct Settlement {
    pub charge: Charge,
    pub stop: Option<Stop>,
    pub code: Option<StaticCode>,
    pub provider_request_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SettlementOutcome {
    pub state: CallState,
    pub charged: NanoUsd,
    pub excess: NanoUsd,
    pub replay: bool,
}

#[derive(Clone, Debug)]
pub struct LiveProgress {
    pub slice: u32,
    pub audio_bytes: u64,
    pub audio_seconds: u64,
    pub turns: u32,
}

pub struct Fund {
    pub reference: String,
    pub account_id: String,
    pub plan: Plan,
    pub period: Period,
}

#[derive(Clone)]
pub struct Grant {
    pub id: i64,
    pub reference: String,
    pub account_id: String,
    pub source: GrantSource,
    pub period: Period,
    pub closed_at: Option<i64>,
    pub amount: NanoUsd,
    pub spent: NanoUsd,
    pub held: NanoUsd,
}

impl Grant {
    pub fn in_force(&self, now: i64) -> bool {
        self.period.contains(now) && self.closed_at.is_none_or(|end| now < end)
    }
    pub fn effective_period(&self) -> Option<Period> {
        let end = self
            .closed_at
            .unwrap_or(self.period.end)
            .min(self.period.end);
        if end <= self.period.start {
            return None;
        }
        Some(Period {
            start: self.period.start,
            end,
        })
    }
}

#[derive(Clone, Debug)]
pub enum LedgerEvent {
    Threshold { budget_id: i64, percent: u8 },
    OwnerGrant { outcome: &'static str },
    InstallationBind { outcome: &'static str },
    SweepEnd { call_id: i64, state: CallState },
}

#[derive(Clone, Debug, Default)]
pub struct Preparation {
    pub events: Vec<LedgerEvent>,
}

#[derive(Clone, Debug)]
pub struct Budget {
    pub id: i64,
    pub kind: String,
    pub period: Option<Period>,
    pub limit: NanoUsd,
    pub spent: NanoUsd,
    pub held: NanoUsd,
}

pub struct PrincipalLedger {
    pub budgets: Vec<Budget>,
    pub grants: Vec<Grant>,
    pub installations: Vec<String>,
    pub calls: Vec<Call>,
}

#[derive(Clone, Debug)]
pub struct ProviderFuse {
    pub provider: Provider,
    pub spent: NanoUsd,
    pub limit: NanoUsd,
    pub paused: bool,
}
#[derive(Clone, Debug)]
pub struct SharedLedger {
    pub budgets: Vec<Budget>,
    pub fuses: Vec<ProviderFuse>,
}
#[derive(Clone, Debug, Default)]
pub struct SweepOutcome {
    pub events: Vec<LedgerEvent>,
    pub deleted: u64,
}
