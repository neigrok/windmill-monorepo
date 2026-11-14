use crate::*;

impl Fund {
    pub fn decide(
        &self,
        existing: Option<&Grant>,
        account_grants: &[Grant],
    ) -> Result<GrantOutcome, StaticCode> {
        if self.plan != Plan::One || self.reference.is_empty() || self.reference.len() > 256 {
            return Err(StaticCode::InvalidRequest);
        }
        Principal::new("account", self.account_id.clone())?;
        Period::new(self.period.start, self.period.end)?;
        if let Some(grant) = existing {
            if grant.account_id == self.account_id && grant.period == self.period {
                return Ok(GrantOutcome::Replay);
            }
            return Ok(GrantOutcome::Conflict);
        }
        if account_grants.iter().any(|grant| {
            grant.source == GrantSource::Subscription
                && grant
                    .effective_period()
                    .is_some_and(|period| period.overlaps(self.period))
        }) {
            return Ok(GrantOutcome::Conflict);
        }
        Ok(GrantOutcome::Ok)
    }
}

impl Grant {
    pub fn close_at(&self, instant: i64) -> Result<i64, StaticCode> {
        if instant < 0 {
            return Err(StaticCode::InvalidRequest);
        }
        Ok(self
            .period
            .end
            .min(self.closed_at.unwrap_or(self.period.end))
            .min(instant))
    }

    pub fn reopen_outcome(&self, account_grants: &[Grant]) -> GrantOutcome {
        if account_grants.iter().any(|grant| {
            grant.id != self.id
                && grant.source == GrantSource::Subscription
                && grant
                    .effective_period()
                    .is_some_and(|period| period.overlaps(self.period))
        }) {
            return GrantOutcome::Conflict;
        }
        GrantOutcome::Ok
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerGrantDecision {
    Existing,
    Fund,
    Cap,
}

pub fn owner_grant(
    active: bool,
    funded_this_month: bool,
    funded_accounts: u64,
    cap: u32,
) -> OwnerGrantDecision {
    if active || funded_this_month {
        return OwnerGrantDecision::Existing;
    }
    if funded_accounts >= u64::from(cap) {
        return OwnerGrantDecision::Cap;
    }
    OwnerGrantDecision::Fund
}

pub fn replay_call(existing: Capability, requested: Capability) -> Result<(), StaticCode> {
    if existing != requested || requested == Capability::Transcription {
        return Err(StaticCode::Conflict);
    }
    Ok(())
}

pub fn admission_gate(
    bound: bool,
    capability: Capability,
    tier: &TierRule,
    in_flight: u64,
) -> Result<(), StaticCode> {
    if bound {
        return Err(StaticCode::DeviceBound);
    }
    if capability == Capability::Transcription && !tier.transcription {
        return Err(StaticCode::FundingRequired);
    }
    if in_flight >= u64::from(tier.in_flight) {
        return Err(StaticCode::ConcurrencyExhausted);
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct MoneyChange {
    pub state: CallState,
    pub cost: NanoUsd,
    pub spent_delta: i64,
    pub held_delta: i64,
    pub excess: NanoUsd,
    pub usage: Option<TokenUsage>,
    pub audio_bytes: u64,
    pub audio_seconds: u64,
    pub turns: u32,
}

impl Call {
    pub fn settlement(
        &self,
        charge: Charge,
        price: &ModelPrice,
        applied: NanoUsd,
        held: NanoUsd,
    ) -> Result<MoneyChange, StaticCode> {
        if !self.state.is_open()
            || (self.state == CallState::Reserved && !matches!(charge, Charge::Unconsumed))
        {
            return Err(StaticCode::Conflict);
        }
        let mut usage = None;
        let mut audio = (self.audio_bytes, self.audio_seconds, self.turns);
        let (state, cost) = match charge {
            Charge::Usage(counts) => {
                if self.capability != Capability::Text {
                    return Err(StaticCode::InvalidRequest);
                }
                usage = Some(counts);
                (CallState::Settled, price.text_cost(counts)?)
            }
            Charge::Audio {
                bytes,
                seconds,
                turns,
            } => {
                if self.capability != Capability::Transcription {
                    return Err(StaticCode::InvalidRequest);
                }
                validate_audio(bytes, seconds, turns)?;
                if bytes < self.audio_bytes
                    || seconds < self.audio_seconds
                    || turns < self.turns
                    || seconds > u64::from(self.slices) * 60
                {
                    return Err(StaticCode::InvalidRequest);
                }
                audio = (bytes, seconds, turns);
                (CallState::Settled, price.audio_cost(seconds)?)
            }
            Charge::Unconsumed => {
                if applied != NanoUsd::ZERO {
                    return Err(StaticCode::Conflict);
                }
                (CallState::Unconsumed, NanoUsd::ZERO)
            }
            Charge::Assumed => (CallState::Assumed, self.reservation),
        };
        Ok(MoneyChange {
            state,
            cost,
            spent_delta: cost
                .nanos()
                .checked_sub(applied.nanos())
                .ok_or(StaticCode::InvalidRequest)?,
            held_delta: -held.nanos(),
            excess: NanoUsd::new(cost.nanos().saturating_sub(self.reservation.nanos()).max(0))?,
            usage,
            audio_bytes: audio.0,
            audio_seconds: audio.1,
            turns: audio.2,
        })
    }

    pub fn correction(&self, cost: NanoUsd) -> Result<i64, StaticCode> {
        if self.state != CallState::Assumed {
            return Err(StaticCode::Conflict);
        }
        cost.nanos()
            .checked_sub(
                self.charged
                    .ok_or(StaticCode::AccountingUnavailable)?
                    .nanos(),
            )
            .ok_or(StaticCode::InvalidRequest)
    }
}

#[derive(Clone, Debug)]
pub struct LiveSlice {
    pub reservation: NanoUsd,
    pub cost: NanoUsd,
    pub held: NanoUsd,
    pub spent_delta: i64,
    pub held_delta: i64,
}

pub struct LiveCapacity<'a> {
    pub applied: NanoUsd,
    pub held: NanoUsd,
    pub grant_active: bool,
    pub fuse_open: bool,
    pub budgets: &'a [NanoUsd],
}

impl LiveProgress {
    pub fn is_replay(&self, call: &Call) -> bool {
        self.slice == call.slices
            && self.audio_bytes == call.audio_bytes
            && self.audio_seconds == call.audio_seconds
            && self.turns == call.turns
    }

    pub fn reserve(
        &self,
        call: &Call,
        price: &ModelPrice,
        capacity: LiveCapacity<'_>,
    ) -> Result<LiveSlice, StaticCode> {
        validate_audio(self.audio_bytes, self.audio_seconds, self.turns)?;
        if call.capability != Capability::Transcription || call.state != CallState::Dispatched {
            return Err(StaticCode::Conflict);
        }
        if self.slice
            != call
                .slices
                .checked_add(1)
                .ok_or(StaticCode::InvalidRequest)?
            || self.audio_bytes < call.audio_bytes
            || self.audio_seconds < call.audio_seconds
            || self.turns < call.turns
            || self.audio_seconds > u64::from(call.slices) * 60
            || self.slice > 55
        {
            return Err(StaticCode::InvalidRequest);
        }
        if !capacity.grant_active {
            return Err(StaticCode::FundingRequired);
        }
        if capacity.fuse_open {
            return Err(StaticCode::Paused);
        }
        let reservation = price.audio_rate()?.checked_mul(u64::from(self.slice))?;
        let extra = reservation.checked_sub(call.reservation)?;
        if capacity.budgets.iter().any(|remaining| extra > *remaining) {
            return Err(StaticCode::SubjectExhausted);
        }
        let cost = price.audio_cost(self.audio_seconds)?;
        let next_held = reservation.checked_sub(cost)?;
        Ok(LiveSlice {
            reservation,
            cost,
            held: next_held,
            spent_delta: cost.checked_sub(capacity.applied)?.nanos(),
            held_delta: next_held
                .nanos()
                .checked_sub(capacity.held.nanos())
                .ok_or(StaticCode::InvalidRequest)?,
        })
    }
}
