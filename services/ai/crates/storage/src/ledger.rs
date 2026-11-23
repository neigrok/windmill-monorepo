use crate::rows;
use ai_domain::*;
use sqlx::{
    Acquire, ConnectOptions, Connection, PgConnection, PgPool, Postgres,
    pool::PoolConnection,
    postgres::{PgConnectOptions, PgPoolOptions, PgRow},
};
use std::{str::FromStr, sync::Arc, time::Duration};
use tokio::sync::Mutex;

const SERVICE_LOCK: i64 = 6_291_402_738_116_021;
const RETENTION_MS: i64 = 90 * 86_400_000;

#[derive(Clone)]
pub struct Ledger {
    pool: PgPool,
    writer: Arc<Mutex<Option<PoolConnection<Postgres>>>>,
    tiers: Arc<TierTable>,
    prices: Arc<PriceBook>,
    instance: Arc<String>,
}

impl Ledger {
    pub async fn connect(
        url: &str,
        tiers: TierTable,
        prices: PriceBook,
    ) -> Result<Self, StaticCode> {
        tiers.validate(&prices)?;
        let options = PgConnectOptions::from_str(url)
            .map_err(|_| StaticCode::AccountingUnavailable)?
            .disable_statement_logging();
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET statement_timeout = '5s'")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET lock_timeout = '2s'")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET idle_in_transaction_session_timeout = '10s'")
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(Self {
            pool,
            writer: Arc::new(Mutex::new(None)),
            tiers: Arc::new(tiers),
            prices: Arc::new(prices),
            instance: Arc::new(uuid::Uuid::new_v4().to_string()),
        })
    }

    pub async fn acquire_lock(&self) -> Result<bool, StaticCode> {
        let mut writer = self.writer.lock().await;
        if let Some(connection) = writer.as_mut()
            && connection.ping().await.is_ok()
        {
            return Ok(true);
        }
        *writer = None;
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let held: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
            .bind(SERVICE_LOCK)
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        if held {
            connection.close_on_drop();
            *writer = Some(connection);
        }
        Ok(held)
    }

    pub async fn lock_alive(&self) -> bool {
        let mut writer = self.writer.lock().await;
        let Some(connection) = writer.as_mut() else {
            return false;
        };
        if connection.ping().await.is_ok() {
            return true;
        }
        *writer = None;
        false
    }

    pub async fn prepare(&self, identity: &Identity, now: i64) -> Result<Preparation, StaticCode> {
        let mut result = Preparation::default();
        if !identity.background()
            && let Principal::Account(account) = &identity.principal
        {
            if let Some(installation) = &identity.installation {
                Principal::new("installation", installation.clone())?;
                let mut writer = self.writer.lock().await;
                let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
                let mut tx = connection
                    .begin()
                    .await
                    .map_err(|_| StaticCode::AccountingUnavailable)?;
                let existing: Option<String> = sqlx::query_scalar(
                    "SELECT account_id FROM ai_bindings WHERE installation_id=$1",
                )
                .bind(installation)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|_| StaticCode::AccountingUnavailable)?;
                match existing {
                    None => {
                        sqlx::query("INSERT INTO ai_bindings(installation_id,account_id,bound_at) VALUES($1,$2,$3)").bind(installation).bind(account).bind(now).execute(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
                        result
                            .events
                            .push(LedgerEvent::InstallationBind { outcome: "ok" });
                    }
                    Some(existing) if existing != *account => {
                        result.events.push(LedgerEvent::InstallationBind {
                            outcome: "binding_contradiction",
                        })
                    }
                    Some(_) => {}
                }
                tx.commit()
                    .await
                    .map_err(|_| StaticCode::AccountingUnavailable)?;
            }
            if identity.owner_grant && identity.plan == Plan::One {
                let month = Period::month(now)?;
                let mut writer = self.writer.lock().await;
                let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
                let mut tx = connection
                    .begin()
                    .await
                    .map_err(|_| StaticCode::AccountingUnavailable)?;
                let active = active_grant(&mut tx, account, now).await?.is_some();
                let prior: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_grants WHERE account_id=$1 AND source='owner' AND period_start=$2)").bind(account).bind(month.start).fetch_one(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM ai_grants WHERE source='owner' AND period_start=$1",
                )
                .bind(month.start)
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| StaticCode::AccountingUnavailable)?;
                match owner_grant(
                    active,
                    prior,
                    u64::try_from(count).map_err(|_| StaticCode::AccountingUnavailable)?,
                    self.tiers.owner_grants_max,
                ) {
                    OwnerGrantDecision::Existing => {}
                    OwnerGrantDecision::Cap => result.events.push(LedgerEvent::OwnerGrant {
                        outcome: "owner_grant_cap",
                    }),
                    OwnerGrantDecision::Fund => {
                        let reference = format!("{}:{}:{}", account.len(), account, month.start);
                        create_grant(
                            &mut tx,
                            &reference,
                            account,
                            GrantSource::Owner,
                            month,
                            self.tiers.row(Tier::One)?.amount,
                        )
                        .await?;
                        result
                            .events
                            .push(LedgerEvent::OwnerGrant { outcome: "ok" });
                    }
                }
                tx.commit()
                    .await
                    .map_err(|_| StaticCode::AccountingUnavailable)?;
            }
        }
        Ok(result)
    }

    pub async fn lookup(
        &self,
        principal: &Principal,
        caller: &CallerId,
    ) -> Result<Option<Call>, StaticCode> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        lookup(&mut connection, principal, caller).await
    }

    pub async fn allowance(&self, identity: &Identity, now: i64) -> Result<Allowance, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let scope = scope(&mut tx, &self.tiers, identity, now).await?;
        let row = self.tiers.row(scope.tier)?;
        let mut code = StaticCode::Ok;
        let mut budget_resets_at = None;
        if scope.bound {
            code = StaticCode::DeviceBound;
        } else if scope.in_flight >= i64::from(row.in_flight) {
            code = StaticCode::ConcurrencyExhausted;
        } else {
            for budget in scope.budgets() {
                if budget.limit.remaining(budget.spent, budget.held)? == NanoUsd::ZERO {
                    code = budget.kind.refusal();
                    budget_resets_at = budget.period.map(|period| period.end);
                    break;
                }
            }
            if code == StaticCode::Ok && scope.hour == Some(NanoUsd::ZERO) {
                code = StaticCode::Paused;
            }
        }
        let result = Allowance {
            tier: scope.tier,
            period: scope.period,
            limit: scope.own.limit,
            used: scope.own.spent,
            reserved: scope.own.held,
            remaining: scope.own.limit.remaining(scope.own.spent, scope.own.held)?,
            resets_at: scope.own.period.map(|period| period.end),
            budget_resets_at,
            code,
            text: row.text,
            transcription: row.transcription,
        };
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(result)
    }

    pub async fn admit(
        &self,
        request: Admission,
        now: i64,
    ) -> Result<AdmissionOutcome, StaticCode> {
        let capability = match request.reservation {
            Reservation::Text(_) => Capability::Text,
            Reservation::Transcription => Capability::Transcription,
        };
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        if let Some(call) = lookup(&mut tx, &request.identity.principal, &request.caller_id).await?
        {
            replay_call(call.capability, capability)?;
            return Ok(AdmissionOutcome::Existing(call));
        }
        let scope = scope(&mut tx, &self.tiers, &request.identity, now).await?;
        let rule = self.tiers.row(scope.tier)?;
        admission_gate(
            scope.bound,
            capability,
            rule,
            u64::try_from(scope.in_flight).map_err(|_| StaticCode::AccountingUnavailable)?,
        )?;
        let route = match capability {
            Capability::Text => self.tiers.route(scope.tier, request.requested)?,
            Capability::Transcription => ModelRoute {
                provider: self.tiers.transcription.provider,
                model: self.tiers.transcription.model.clone(),
                served: request.requested,
            },
        };
        if route != request.expected_route {
            return Err(StaticCode::AccountingUnavailable);
        }
        if fuse(&mut tx, route.provider, self.tiers.hourly_fuse, now)
            .await?
            .paused
        {
            return Err(StaticCode::Paused);
        }
        let price = self.prices.model(route.provider, &route.model)?;
        let limits = scope.limits()?;
        let (max_tokens, reservation, slices) = match request.reservation {
            Reservation::Text(text) => {
                let (cap, cost) = price.reserve_text(text, rule.output_ceiling, &limits)?;
                (
                    Some(i32::try_from(cap).map_err(|_| StaticCode::InvalidRequest)?),
                    cost,
                    0_i32,
                )
            }
            Reservation::Transcription => {
                let cost = price.audio_rate()?;
                for (remaining, refusal) in &limits {
                    if cost > *remaining {
                        return Err(*refusal);
                    }
                }
                (None, cost, 1_i32)
            }
        };
        let month = Period::month(now)?;
        let row = sqlx::query("INSERT INTO ai_calls(principal_kind,principal_id,caller_id,capability,tier,requested,provider,model,served,price_version,label,client,state,reservation,held,max_tokens,slices,month_start,instance,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved',$13,$13,$14,$15,$16,$17,$18) RETURNING *")
            .bind(request.identity.principal.kind()).bind(request.identity.principal.id()).bind(request.caller_id.as_str()).bind(capability.as_str()).bind(scope.tier.as_str()).bind(request.requested.as_str()).bind(route.provider.as_str()).bind(&route.model).bind(route.served.as_str()).bind(&self.prices.version).bind(self.tiers.label(&request.label)).bind(request.identity.client.as_str()).bind(reservation.nanos()).bind(max_tokens).bind(slices).bind(month.start).bind(self.instance.as_str()).bind(now).fetch_one(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let call = rows::call(&row)?;
        for budget in scope.budgets() {
            sqlx::query("INSERT INTO ai_call_budgets(call_id,budget_id) VALUES($1,$2)")
                .bind(call.id)
                .bind(budget.id)
                .execute(&mut *tx)
                .await
                .map_err(|_| StaticCode::AccountingUnavailable)?;
        }
        snapshot_price(&mut tx, call.id, price).await?;
        move_money(&mut tx, &call, month.start, 0, reservation.nanos(), now).await?;
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(AdmissionOutcome::Admitted(call))
    }

    pub async fn dispatch(&self, id: i64, now: i64) -> Result<(), StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let result = sqlx::query("UPDATE ai_calls SET state='dispatched',dispatched_at=$2 WHERE id=$1 AND state='reserved' AND instance=$3").bind(id).bind(now).bind(self.instance.as_str()).execute(&mut **connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        if result.rows_affected() != 1 {
            return Err(StaticCode::Conflict);
        }
        Ok(())
    }

    pub async fn fund(&self, request: Fund, _now: i64) -> Result<GrantOutcome, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let existing = sqlx::query("SELECT g.*,b.limit_nanos,b.spent,b.held FROM ai_grants g JOIN ai_budgets b ON b.id=g.budget_id WHERE g.source='subscription' AND g.reference=$1").bind(&request.reference).fetch_optional(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let existing = existing.as_ref().map(rows::grant).transpose()?;
        let grants = account_grants(&mut tx, &request.account_id).await?;
        let decision = request.decide(existing.as_ref(), &grants)?;
        if decision != GrantOutcome::Ok {
            return Ok(decision);
        }
        create_grant(
            &mut tx,
            &request.reference,
            &request.account_id,
            GrantSource::Subscription,
            request.period,
            self.tiers.row(Tier::One)?.amount,
        )
        .await?;
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(GrantOutcome::Ok)
    }

    pub async fn close(&self, reference: &str, closed_at: i64) -> Result<GrantOutcome, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let row = sqlx::query("SELECT g.*,b.limit_nanos,b.spent,b.held FROM ai_grants g JOIN ai_budgets b ON b.id=g.budget_id WHERE g.source='subscription' AND g.reference=$1").bind(reference).fetch_optional(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let Some(row) = row else {
            return Ok(GrantOutcome::NotFound);
        };
        let grant = rows::grant(&row)?;
        let instant = grant.close_at(closed_at)?;
        sqlx::query("UPDATE ai_grants SET closed_at=$2 WHERE id=$1")
            .bind(grant.id)
            .bind(instant)
            .execute(&mut *tx)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(GrantOutcome::Ok)
    }

    pub async fn reopen(&self, reference: &str) -> Result<GrantOutcome, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let row = sqlx::query("SELECT g.*,b.limit_nanos,b.spent,b.held FROM ai_grants g JOIN ai_budgets b ON b.id=g.budget_id WHERE g.source='subscription' AND g.reference=$1").bind(reference).fetch_optional(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let Some(row) = row else {
            return Ok(GrantOutcome::NotFound);
        };
        let grant = rows::grant(&row)?;
        let grants = account_grants(&mut tx, &grant.account_id).await?;
        let outcome = grant.reopen_outcome(&grants);
        if outcome != GrantOutcome::Ok {
            return Ok(outcome);
        }
        sqlx::query("UPDATE ai_grants SET closed_at=NULL WHERE id=$1")
            .bind(grant.id)
            .execute(&mut *tx)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(GrantOutcome::Ok)
    }

    pub async fn settle(
        &self,
        id: i64,
        settlement: Settlement,
        now: i64,
    ) -> Result<SettlementOutcome, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let row = call_row(&mut tx, id).await?;
        let result = settle(&mut tx, &row, settlement, now).await?;
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(result)
    }

    pub async fn extend_live(
        &self,
        id: i64,
        progress: LiveProgress,
        now: i64,
    ) -> Result<Call, StaticCode> {
        validate_audio(progress.audio_bytes, progress.audio_seconds, progress.turns)?;
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let row = call_row(&mut tx, id).await?;
        let call = rows::call(&row)?;
        if call.state != CallState::Dispatched || call.capability != Capability::Transcription {
            return Err(StaticCode::Conflict);
        }
        if progress.is_replay(&call) {
            return Ok(call);
        }
        let grant_active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_grants g JOIN ai_call_budgets p ON p.budget_id=g.budget_id WHERE p.call_id=$1 AND g.period_start<=$2 AND g.period_end>$2 AND (g.closed_at IS NULL OR g.closed_at>$2))").bind(id).bind(now).fetch_one(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let fuse_open = fuse(&mut tx, call.route.provider, self.tiers.hourly_fuse, now)
            .await?
            .paused;
        let price_row = sqlx::query("SELECT * FROM ai_call_prices WHERE call_id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let price = rows::price(&price_row, &call)?;
        let budget_rows = sqlx::query("SELECT b.* FROM ai_budgets b JOIN ai_call_budgets p ON b.id=p.budget_id WHERE p.call_id=$1 ORDER BY b.id FOR UPDATE OF b").bind(id).fetch_all(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let budgets = budget_rows
            .iter()
            .map(|row| {
                let budget = rows::budget(row)?;
                budget.limit.remaining(budget.spent, budget.held)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let slice = progress.reserve(
            &call,
            &price,
            LiveCapacity {
                applied: rows::money(&row, "applied")?,
                held: rows::money(&row, "held")?,
                grant_active,
                fuse_open,
                budgets: &budgets,
            },
        )?;
        let reservation = slice.reservation;
        let cost = slice.cost;
        let held = slice.held;
        move_money(
            &mut tx,
            &call,
            rows::value(&row, "month_start")?,
            slice.spent_delta,
            slice.held_delta,
            now,
        )
        .await?;
        let row = sqlx::query("UPDATE ai_calls SET reservation=$2,applied=$3,held=$4,audio_bytes=$5,audio_seconds=$6,turns=$7,slices=$8 WHERE id=$1 AND state='dispatched' RETURNING *").bind(id).bind(reservation.nanos()).bind(cost.nanos()).bind(held.nanos()).bind(i64::try_from(progress.audio_bytes).map_err(|_| StaticCode::InvalidRequest)?).bind(i64::try_from(progress.audio_seconds).map_err(|_| StaticCode::InvalidRequest)?).bind(i32::try_from(progress.turns).map_err(|_| StaticCode::InvalidRequest)?).bind(i32::try_from(progress.slice).map_err(|_| StaticCode::InvalidRequest)?).fetch_one(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let call = rows::call(&row)?;
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(call)
    }

    pub async fn correct(
        &self,
        id: i64,
        cost: NanoUsd,
        _now: i64,
    ) -> Result<SettlementOutcome, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let row = call_row(&mut tx, id).await?;
        let call = rows::call(&row)?;
        let delta = call.correction(cost)?;
        let replay = delta == 0 && call.original_charge.is_some();
        if !replay {
            move_money(
                &mut tx,
                &call,
                rows::value(&row, "month_start")?,
                delta,
                0,
                call.ended_at.ok_or(StaticCode::AccountingUnavailable)?,
            )
            .await?;
            sqlx::query("UPDATE ai_calls SET original_charge=COALESCE(original_charge,charged),charged=$2,applied=$2 WHERE id=$1 AND state='assumed'").bind(id).bind(cost.nanos()).execute(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        }
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(SettlementOutcome {
            state: CallState::Assumed,
            charged: cost,
            excess: NanoUsd::new(cost.nanos().saturating_sub(call.reservation.nanos()).max(0))?,
            replay,
        })
    }

    pub async fn call(&self, id: i64) -> Result<Option<Call>, StaticCode> {
        let row = sqlx::query("SELECT * FROM ai_calls WHERE id=$1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        row.as_ref().map(rows::call).transpose()
    }

    pub async fn calls(
        &self,
        state: Option<CallState>,
        since: Option<i64>,
        caller: Option<&CallerId>,
        before: Option<i64>,
    ) -> Result<Vec<Call>, StaticCode> {
        let rows = sqlx::query("SELECT * FROM ai_calls WHERE ($1::text IS NULL OR state=$1) AND ($2::bigint IS NULL OR ended_at>=$2) AND ($3::text IS NULL OR caller_id=$3) AND ($4::bigint IS NULL OR id<$4) ORDER BY id DESC LIMIT 1001").bind(state.map(CallState::as_str)).bind(since).bind(caller.map(CallerId::as_str)).bind(before).fetch_all(&self.pool).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        rows.iter().map(rows::call).collect()
    }

    pub async fn principal(
        &self,
        principal: &Principal,
        _now: i64,
        before: Option<i64>,
    ) -> Result<PrincipalLedger, StaticCode> {
        let budget_rows = sqlx::query(
            "SELECT * FROM ai_budgets WHERE principal_kind=$1 AND principal_id=$2 ORDER BY id",
        )
        .bind(principal.kind())
        .bind(principal.id())
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StaticCode::AccountingUnavailable)?;
        let grant_rows = sqlx::query("SELECT g.*,b.limit_nanos,b.spent,b.held FROM ai_grants g JOIN ai_budgets b ON b.id=g.budget_id WHERE $1='account' AND account_id=$2 ORDER BY g.id").bind(principal.kind()).bind(principal.id()).fetch_all(&self.pool).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let installations = sqlx::query_scalar("SELECT installation_id FROM ai_bindings WHERE ($1='account' AND account_id=$2) OR ($1='installation' AND installation_id=$2) ORDER BY installation_id").bind(principal.kind()).bind(principal.id()).fetch_all(&self.pool).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let calls = sqlx::query("SELECT c.* FROM ai_calls c WHERE ((c.principal_kind=$1 AND c.principal_id=$2) OR ($1='account' AND c.principal_kind='installation' AND EXISTS(SELECT 1 FROM ai_bindings b WHERE b.installation_id=c.principal_id AND b.account_id=$2))) AND ($3::bigint IS NULL OR c.id<$3) ORDER BY id DESC LIMIT 1001").bind(principal.kind()).bind(principal.id()).bind(before).fetch_all(&self.pool).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(PrincipalLedger {
            budgets: budget_rows
                .iter()
                .map(rows::budget)
                .collect::<Result<_, _>>()?,
            grants: grant_rows
                .iter()
                .map(rows::grant)
                .collect::<Result<_, _>>()?,
            installations,
            calls: calls.iter().map(rows::call).collect::<Result<_, _>>()?,
        })
    }

    pub async fn fuse(&self, provider: Provider, now: i64) -> Result<ProviderFuse, StaticCode> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        fuse(&mut connection, provider, self.tiers.hourly_fuse, now).await
    }

    pub async fn shared(&self, now: i64) -> Result<SharedLedger, StaticCode> {
        let rows = sqlx::query("SELECT * FROM ai_budgets WHERE kind=ANY($1) ORDER BY id")
            .bind(BudgetKind::SHARED.map(BudgetKind::as_str))
            .fetch_all(&self.pool)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let budgets = rows.iter().map(rows::budget).collect::<Result<_, _>>()?;
        let mut fuses = Vec::new();
        for provider in [Provider::Anthropic, Provider::OpenAi, Provider::Azure] {
            fuses.push(self.fuse(provider, now).await?);
        }
        Ok(SharedLedger { budgets, fuses })
    }

    pub async fn drain_events(&self) -> Result<Vec<LedgerEvent>, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let rows = sqlx::query("DELETE FROM ai_threshold_outbox o USING ai_budgets b WHERE b.id=o.budget_id RETURNING o.budget_id,b.kind,o.percent")
            .fetch_all(&mut **connection)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        rows.iter()
            .map(|row| {
                Ok(LedgerEvent::Threshold {
                    budget_id: rows::value(row, "budget_id")?,
                    kind: BudgetKind::parse(rows::value(row, "kind")?)?,
                    percent: u8::try_from(rows::value::<i16>(row, "percent")?)
                        .map_err(|_| StaticCode::AccountingUnavailable)?,
                })
            })
            .collect()
    }

    pub async fn sweep(&self, active: &[i64], now: i64) -> Result<SweepOutcome, StaticCode> {
        let mut writer = self.writer.lock().await;
        let connection = writer.as_mut().ok_or(StaticCode::AccountingUnavailable)?;
        let mut tx = connection
            .begin()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        let rows = sqlx::query("SELECT * FROM ai_calls WHERE state IN ('reserved','dispatched') AND (instance<>$1 OR NOT(id=ANY($2))) ORDER BY id FOR UPDATE").bind(self.instance.as_str()).bind(active).fetch_all(&mut *tx).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        let mut result = SweepOutcome::default();
        for row in rows {
            let call = rows::call(&row)?;
            let charge = if call.state == CallState::Reserved {
                Charge::Unconsumed
            } else {
                Charge::Assumed
            };
            let outcome = settle(
                &mut tx,
                &row,
                Settlement {
                    charge,
                    stop: None,
                    code: Some(StaticCode::ProviderFailed),
                    provider_request_id: None,
                },
                now,
            )
            .await?;
            result.events.push(LedgerEvent::SweepEnd {
                call_id: call.id,
                state: outcome.state,
            });
        }
        result.deleted = sqlx::query("DELETE FROM ai_calls WHERE ended_at<=$1")
            .bind(now.saturating_sub(RETENTION_MS))
            .execute(&mut *tx)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?
            .rows_affected();
        sqlx::query("DELETE FROM ai_spend_events WHERE at<=$1")
            .bind(now.saturating_sub(RETENTION_MS))
            .execute(&mut *tx)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        tx.commit()
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
        Ok(result)
    }
}

struct Scope {
    tier: Tier,
    period: AllowancePeriod,
    own: Budget,
    month: Option<Budget>,
    day: Option<Budget>,
    hour: Option<NanoUsd>,
    in_flight: i64,
    bound: bool,
}

impl Scope {
    fn budgets(&self) -> Vec<&Budget> {
        [Some(&self.own), self.month.as_ref(), self.day.as_ref()]
            .into_iter()
            .flatten()
            .collect()
    }

    fn limits(&self) -> Result<Vec<(NanoUsd, StaticCode)>, StaticCode> {
        let mut limits = self
            .budgets()
            .into_iter()
            .map(|budget| {
                Ok((
                    budget.limit.remaining(budget.spent, budget.held)?,
                    budget.kind.refusal(),
                ))
            })
            .collect::<Result<Vec<_>, StaticCode>>()?;
        if let Some(hour) = self.hour {
            limits.push((hour, StaticCode::Paused));
        }
        Ok(limits)
    }
}

async fn scope(
    connection: &mut PgConnection,
    tiers: &TierTable,
    identity: &Identity,
    now: i64,
) -> Result<Scope, StaticCode> {
    if identity.background() {
        return background_scope(connection, tiers, &identity.principal, now).await;
    }
    let month = Period::month(now)?;
    let day = Period::day(now)?;
    let principal = &identity.principal;
    let in_flight = in_flight(connection, principal, false).await?;
    if let Principal::Account(account) = principal
        && identity.plan == Plan::One
        && let Some(row) = active_grant(connection, account, now).await?
    {
        let source = GrantSource::parse(rows::value(&row, "source")?)?;
        let own = get_budget(connection, rows::value(&row, "budget_id")?).await?;
        return Ok(Scope {
            tier: Tier::One,
            period: if source == GrantSource::Owner {
                AllowancePeriod::CalendarMonthUtc
            } else {
                AllowancePeriod::BillingPeriod
            },
            own,
            month: None,
            day: None,
            hour: None,
            in_flight,
            bound: false,
        });
    }
    let (tier, own_kind, own_period, period) = match principal {
        Principal::Installation(_) => (
            Tier::Anonymous,
            BudgetKind::Installation,
            None,
            AllowancePeriod::Lifetime,
        ),
        Principal::Account(_) => (
            Tier::Free,
            BudgetKind::AccountMonth,
            Some(month),
            AllowancePeriod::CalendarMonthUtc,
        ),
    };
    let rule = tiers.row(tier)?;
    let mut own = ensure_budget(
        connection,
        own_kind,
        principal.id(),
        Some(principal),
        own_period,
        rule.amount,
    )
    .await?;
    if tier == Tier::Free {
        let row = sqlx::query("SELECT COALESCE(sum(m.spent),0)::bigint AS spent,COALESCE(sum(m.held),0)::bigint AS held FROM ai_installation_months m JOIN ai_bindings b ON b.installation_id=m.installation_id WHERE b.account_id=$1 AND m.month_start=$2").bind(principal.id()).bind(month.start).fetch_one(&mut *connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        own.spent = own.spent.checked_add(rows::money(&row, "spent")?)?;
        own.held = own.held.checked_add(rows::money(&row, "held")?)?;
    }
    let month_budget = pool_budget(
        connection,
        BudgetKind::FreeMonth,
        rule.month_pool.as_ref(),
        month,
    )
    .await?;
    let day_budget =
        pool_budget(connection, BudgetKind::FreeDay, rule.day_pool.as_ref(), day).await?;
    let bound = if tier == Tier::Anonymous {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_bindings WHERE installation_id=$1)")
            .bind(principal.id())
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?
    } else {
        false
    };
    Ok(Scope {
        tier,
        period,
        own,
        month: month_budget,
        day: day_budget,
        hour: None,
        in_flight,
        bound,
    })
}

async fn background_scope(
    connection: &mut PgConnection,
    tiers: &TierTable,
    principal: &Principal,
    now: i64,
) -> Result<Scope, StaticCode> {
    let month = Period::month(now)?;
    let rule = tiers.row(Tier::Background)?;
    let own = ensure_budget(
        connection,
        BudgetKind::BackgroundAccountMonth,
        principal.id(),
        Some(principal),
        Some(month),
        rule.amount,
    )
    .await?;
    let month_budget = pool_budget(
        connection,
        BudgetKind::BackgroundMonth,
        rule.month_pool.as_ref(),
        month,
    )
    .await?;
    let day_budget = pool_budget(
        connection,
        BudgetKind::BackgroundDay,
        rule.day_pool.as_ref(),
        Period::day(now)?,
    )
    .await?;
    let hour = sqlx::query("SELECT (SELECT GREATEST(COALESCE(sum(e.delta),0),0) FROM ai_spend_events e JOIN ai_calls c ON c.id=e.call_id WHERE c.tier='background' AND e.at>$1 AND e.at<=$2)::bigint AS spent,(SELECT COALESCE(sum(held),0) FROM ai_calls WHERE tier='background' AND state IN ('reserved','dispatched'))::bigint AS held").bind(now.saturating_sub(3_600_000)).bind(now).fetch_one(&mut *connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    Ok(Scope {
        tier: Tier::Background,
        period: AllowancePeriod::CalendarMonthUtc,
        own,
        month: month_budget,
        day: day_budget,
        hour: Some(
            tiers
                .background_hour
                .remaining(rows::money(&hour, "spent")?, rows::money(&hour, "held")?)?,
        ),
        in_flight: in_flight(connection, principal, true).await?,
        bound: false,
    })
}

async fn in_flight(
    connection: &mut PgConnection,
    principal: &Principal,
    background: bool,
) -> Result<i64, StaticCode> {
    sqlx::query_scalar("SELECT count(*) FROM ai_calls c WHERE c.state IN ('reserved','dispatched') AND (c.tier='background')=$3 AND ((c.principal_kind=$1 AND c.principal_id=$2) OR ($1='account' AND c.principal_kind='installation' AND EXISTS(SELECT 1 FROM ai_bindings b WHERE b.installation_id=c.principal_id AND b.account_id=$2)))").bind(principal.kind()).bind(principal.id()).bind(background).fetch_one(connection).await.map_err(|_| StaticCode::AccountingUnavailable)
}

async fn pool_budget(
    connection: &mut PgConnection,
    kind: BudgetKind,
    pool: Option<&PoolRule>,
    period: Period,
) -> Result<Option<Budget>, StaticCode> {
    let Some(pool) = pool else {
        return Ok(None);
    };
    Ok(Some(
        ensure_budget(connection, kind, &pool.name, None, Some(period), pool.limit).await?,
    ))
}

async fn ensure_budget(
    connection: &mut PgConnection,
    kind: BudgetKind,
    owner: &str,
    principal: Option<&Principal>,
    period: Option<Period>,
    limit: NanoUsd,
) -> Result<Budget, StaticCode> {
    let key = format!(
        "{}:{}:{owner}:{}",
        kind.as_str(),
        owner.len(),
        period.map_or(0, |period| period.start)
    );
    let row = sqlx::query("INSERT INTO ai_budgets(budget_key,kind,principal_kind,principal_id,period_start,period_end,limit_nanos) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(budget_key) DO UPDATE SET budget_key=EXCLUDED.budget_key RETURNING *").bind(key).bind(kind.as_str()).bind(principal.map(Principal::kind)).bind(principal.map(Principal::id)).bind(period.map(|period| period.start)).bind(period.map(|period| period.end)).bind(limit.nanos()).fetch_one(&mut *connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    rows::budget(&row)
}

async fn get_budget(connection: &mut PgConnection, id: i64) -> Result<Budget, StaticCode> {
    let row = sqlx::query("SELECT * FROM ai_budgets WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(connection)
        .await
        .map_err(|_| StaticCode::AccountingUnavailable)?;
    rows::budget(&row)
}

async fn active_grant(
    connection: &mut PgConnection,
    account: &str,
    now: i64,
) -> Result<Option<PgRow>, StaticCode> {
    sqlx::query("SELECT * FROM ai_grants WHERE account_id=$1 AND period_start<=$2 AND period_end>$2 AND (closed_at IS NULL OR closed_at>$2) ORDER BY CASE WHEN source='subscription' THEN 0 ELSE 1 END,id LIMIT 1").bind(account).bind(now).fetch_optional(connection).await.map_err(|_| StaticCode::AccountingUnavailable)
}

async fn create_grant(
    connection: &mut PgConnection,
    reference: &str,
    account: &str,
    source: GrantSource,
    period: Period,
    amount: NanoUsd,
) -> Result<(), StaticCode> {
    let owner = format!("{}:{}:{reference}", source.as_str(), reference.len());
    let principal = Principal::Account(account.to_owned());
    let budget = ensure_budget(
        connection,
        BudgetKind::Grant,
        &owner,
        Some(&principal),
        Some(period),
        amount,
    )
    .await?;
    sqlx::query("INSERT INTO ai_grants(reference,account_id,source,plan,period_start,period_end,budget_id) VALUES($1,$2,$3,'one',$4,$5,$6)").bind(reference).bind(account).bind(source.as_str()).bind(period.start).bind(period.end).bind(budget.id).execute(connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    Ok(())
}

async fn account_grants(
    connection: &mut PgConnection,
    account: &str,
) -> Result<Vec<Grant>, StaticCode> {
    let rows = sqlx::query("SELECT g.*,b.limit_nanos,b.spent,b.held FROM ai_grants g JOIN ai_budgets b ON b.id=g.budget_id WHERE account_id=$1 ORDER BY g.id").bind(account).fetch_all(connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    rows.iter().map(rows::grant).collect()
}

async fn lookup(
    connection: &mut PgConnection,
    principal: &Principal,
    caller: &CallerId,
) -> Result<Option<Call>, StaticCode> {
    let row = sqlx::query("SELECT c.* FROM ai_calls c WHERE c.caller_id=$3 AND ((c.principal_kind=$1 AND c.principal_id=$2) OR ($1='account' AND c.principal_kind='installation' AND EXISTS(SELECT 1 FROM ai_bindings b WHERE b.installation_id=c.principal_id AND b.account_id=$2))) ORDER BY CASE WHEN c.principal_kind=$1 AND c.principal_id=$2 THEN 0 ELSE 1 END,c.id LIMIT 1").bind(principal.kind()).bind(principal.id()).bind(caller.as_str()).fetch_optional(connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    row.as_ref().map(rows::call).transpose()
}

async fn snapshot_price(
    connection: &mut PgConnection,
    id: i64,
    price: &ModelPrice,
) -> Result<(), StaticCode> {
    let long = price.long_prompt.map(|(_, rates)| rates);
    sqlx::query("INSERT INTO ai_call_prices(call_id,input_rate,output_rate,cache_write_rate,cache_write_1h_rate,cache_read_rate,long_threshold,long_input_rate,long_output_rate,long_cache_write_rate,long_cache_write_1h_rate,long_cache_read_rate,audio_rate,source,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
        .bind(id).bind(price.tokens.map(|rates| rates.input.nanos())).bind(price.tokens.map(|rates| rates.output.nanos())).bind(price.tokens.map(|rates| rates.cache_write.nanos())).bind(price.tokens.map(|rates| rates.cache_write_1h.nanos())).bind(price.tokens.map(|rates| rates.cache_read.nanos())).bind(price.long_prompt.map(|(threshold, _)| i64::try_from(threshold).map_err(|_| StaticCode::InvalidRequest)).transpose()?).bind(long.map(|rates| rates.input.nanos())).bind(long.map(|rates| rates.output.nanos())).bind(long.map(|rates| rates.cache_write.nanos())).bind(long.map(|rates| rates.cache_write_1h.nanos())).bind(long.map(|rates| rates.cache_read.nanos())).bind(price.audio_per_minute.map(NanoUsd::nanos)).bind(&price.source).bind(&price.checked_at).execute(connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    Ok(())
}

async fn move_money(
    connection: &mut PgConnection,
    call: &Call,
    month: i64,
    spent_delta: i64,
    held_delta: i64,
    at: i64,
) -> Result<(), StaticCode> {
    sqlx::query("UPDATE ai_budgets SET spent=spent+$2,held=held+$3 WHERE id IN (SELECT budget_id FROM ai_call_budgets WHERE call_id=$1)").bind(call.id).bind(spent_delta).bind(held_delta).execute(&mut *connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    if let Principal::Installation(installation) = &call.principal {
        sqlx::query("INSERT INTO ai_installation_months(installation_id,month_start) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(installation).bind(month).execute(&mut *connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
        sqlx::query("UPDATE ai_installation_months SET spent=spent+$3,held=held+$4 WHERE installation_id=$1 AND month_start=$2").bind(installation).bind(month).bind(spent_delta).bind(held_delta).execute(&mut *connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    }
    if spent_delta != 0 {
        sqlx::query("INSERT INTO ai_spend_events(call_id,provider,at,delta) VALUES($1,$2,$3,$4)")
            .bind(call.id)
            .bind(call.route.provider.as_str())
            .bind(at)
            .bind(spent_delta)
            .execute(&mut *connection)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
    }
    sqlx::query("WITH crossed AS (INSERT INTO ai_thresholds(budget_id,percent) SELECT b.id,p.percent FROM ai_budgets b CROSS JOIN (VALUES(50),(80),(95)) p(percent) WHERE b.id IN (SELECT budget_id FROM ai_call_budgets WHERE call_id=$1) AND b.kind=ANY($2) AND (b.spent::numeric+b.held::numeric)*100>=b.limit_nanos::numeric*p.percent ON CONFLICT DO NOTHING RETURNING budget_id,percent) INSERT INTO ai_threshold_outbox(budget_id,percent) SELECT budget_id,percent FROM crossed").bind(call.id).bind(BudgetKind::SHARED.map(BudgetKind::as_str)).execute(connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    Ok(())
}

async fn fuse(
    connection: &mut PgConnection,
    provider: Provider,
    limit: NanoUsd,
    now: i64,
) -> Result<ProviderFuse, StaticCode> {
    let spent: i64 = sqlx::query_scalar("SELECT GREATEST(COALESCE(sum(delta),0),0)::bigint FROM ai_spend_events WHERE provider=$1 AND at>$2 AND at<=$3").bind(provider.as_str()).bind(now.saturating_sub(3_600_000)).bind(now).fetch_one(connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    let spent = NanoUsd::new(spent)?;
    Ok(ProviderFuse {
        provider,
        spent,
        limit,
        paused: spent > limit,
    })
}

async fn call_row(connection: &mut PgConnection, id: i64) -> Result<PgRow, StaticCode> {
    sqlx::query("SELECT * FROM ai_calls WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(connection)
        .await
        .map_err(|_| StaticCode::AccountingUnavailable)?
        .ok_or(StaticCode::CallUnknown)
}

async fn settle(
    connection: &mut PgConnection,
    row: &PgRow,
    settlement: Settlement,
    now: i64,
) -> Result<SettlementOutcome, StaticCode> {
    let call = rows::call(row)?;
    if !call.state.is_open() {
        return Ok(SettlementOutcome {
            state: call.state,
            charged: call.charged.ok_or(StaticCode::AccountingUnavailable)?,
            excess: NanoUsd::ZERO,
            replay: true,
        });
    }
    if call.state == CallState::Reserved && !matches!(settlement.charge, Charge::Unconsumed) {
        return Err(StaticCode::Conflict);
    }
    if let Some(id) = &settlement.provider_request_id
        && (id.len() > 256
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b':')))
    {
        return Err(StaticCode::InvalidRequest);
    }
    let price_row = sqlx::query("SELECT * FROM ai_call_prices WHERE call_id=$1")
        .bind(call.id)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| StaticCode::AccountingUnavailable)?;
    let price = rows::price(&price_row, &call)?;
    let change = call.settlement(
        settlement.charge,
        &price,
        rows::money(row, "applied")?,
        rows::money(row, "held")?,
    )?;
    let state = change.state;
    let cost = change.cost;
    let usage = change.usage;
    let audio = (change.audio_bytes, change.audio_seconds, change.turns);
    move_money(
        connection,
        &call,
        rows::value(row, "month_start")?,
        change.spent_delta,
        change.held_delta,
        now,
    )
    .await?;
    sqlx::query("DELETE FROM ai_spend_events WHERE call_id=$1")
        .bind(call.id)
        .execute(&mut *connection)
        .await
        .map_err(|_| StaticCode::AccountingUnavailable)?;
    if cost != NanoUsd::ZERO {
        sqlx::query("INSERT INTO ai_spend_events(call_id,provider,at,delta) VALUES($1,$2,$3,$4)")
            .bind(call.id)
            .bind(call.route.provider.as_str())
            .bind(now)
            .bind(cost.nanos())
            .execute(&mut *connection)
            .await
            .map_err(|_| StaticCode::AccountingUnavailable)?;
    }
    sqlx::query("UPDATE ai_calls SET state=$2,charged=$3,applied=$3,held=0,input_tokens=$4,output_tokens=$5,cache_write_tokens=$6,cache_write_1h_tokens=$7,cache_read_tokens=$8,audio_bytes=$9,audio_seconds=$10,turns=$11,provider_request_id=$12,stop=$13,code=$14,ended_at=$15 WHERE id=$1 AND state=$16")
        .bind(call.id).bind(state.as_str()).bind(cost.nanos()).bind(usage.map(|usage| i64::try_from(usage.input)).transpose().map_err(|_| StaticCode::InvalidRequest)?).bind(usage.map(|usage| i64::try_from(usage.output)).transpose().map_err(|_| StaticCode::InvalidRequest)?).bind(usage.map(|usage| i64::try_from(usage.cache_write)).transpose().map_err(|_| StaticCode::InvalidRequest)?).bind(usage.map(|usage| i64::try_from(usage.cache_write_1h)).transpose().map_err(|_| StaticCode::InvalidRequest)?).bind(usage.map(|usage| i64::try_from(usage.cache_read)).transpose().map_err(|_| StaticCode::InvalidRequest)?).bind(i64::try_from(audio.0).map_err(|_| StaticCode::InvalidRequest)?).bind(i64::try_from(audio.1).map_err(|_| StaticCode::InvalidRequest)?).bind(i32::try_from(audio.2).map_err(|_| StaticCode::InvalidRequest)?).bind(settlement.provider_request_id).bind(settlement.stop.map(Stop::as_str)).bind(settlement.code.map(StaticCode::as_str)).bind(now).bind(call.state.as_str()).execute(connection).await.map_err(|_| StaticCode::AccountingUnavailable)?;
    Ok(SettlementOutcome {
        state,
        charged: cost,
        excess: NanoUsd::new(cost.nanos().saturating_sub(call.reservation.nanos()).max(0))?,
        replay: false,
    })
}
