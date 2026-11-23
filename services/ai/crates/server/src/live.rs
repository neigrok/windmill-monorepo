use crate::{
    ActiveCall, Service, authenticate_token, bearer, config::*, principal_key, refusal, reject,
    settle, telemetry, wire,
};
use ai_domain::*;
use ai_providers::{FailureKind, LiveEvent, LiveSession, ProviderFailure};
use axum::{
    extract::{
        FromRequestParts, Path, Request, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::header,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Control {
    Context { keywords: Vec<String> },
    Commit,
    End,
}

struct Turn {
    bytes: u64,
    text: String,
    final_text: Option<String>,
    committed: Option<Instant>,
}
struct Transcript {
    turns: Vec<Turn>,
    items: HashMap<String, usize>,
    commits: VecDeque<usize>,
    pending_commit: bool,
    bytes: u64,
    last_text_bytes: u64,
    failure_kind: Option<FailureKind>,
}

impl Transcript {
    fn new() -> Self {
        Self {
            turns: vec![Turn {
                bytes: 0,
                text: String::new(),
                final_text: None,
                committed: None,
            }],
            items: HashMap::new(),
            commits: VecDeque::new(),
            pending_commit: false,
            bytes: 0,
            last_text_bytes: 0,
            failure_kind: None,
        }
    }
    fn seconds(&self) -> u64 {
        self.turns
            .iter()
            .map(|turn| turn.bytes.div_ceil(AUDIO_BYTES_PER_SECOND))
            .sum()
    }
    fn candidate_seconds(&self, bytes: u64) -> u64 {
        self.seconds()
            - self
                .turns
                .last()
                .unwrap()
                .bytes
                .div_ceil(AUDIO_BYTES_PER_SECOND)
            + (self.turns.last().unwrap().bytes + bytes).div_ceil(AUDIO_BYTES_PER_SECOND)
    }
    fn text(&self) -> String {
        self.turns
            .iter()
            .map(|turn| turn.final_text.as_ref().unwrap_or(&turn.text).as_str())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn completed_turns(&self) -> u32 {
        self.turns.iter().filter(|turn| turn.bytes > 0).count() as u32
    }
    fn timed_out(&self) -> bool {
        self.turns.iter().any(|turn| {
            turn.final_text.is_none() && turn.committed.is_some_and(|at| at.elapsed() >= TURN_WAIT)
        })
    }
    fn outstanding(&self) -> bool {
        self.turns
            .iter()
            .any(|turn| turn.bytes > 0 && turn.final_text.is_none())
    }
    fn provider_error(&mut self, failure: ProviderFailure) -> StaticCode {
        self.failure_kind = Some(failure.kind);
        StaticCode::ProviderFailed
    }

    async fn forward(&mut self, provider: &mut LiveSession, pcm: &[u8]) -> Result<(), StaticCode> {
        self.bytes += pcm.len() as u64;
        self.turns.last_mut().unwrap().bytes += pcm.len() as u64;
        provider
            .send_audio(pcm)
            .await
            .map_err(|failure| self.provider_error(failure))
    }

    async fn commit(&mut self, provider: &mut LiveSession, force: bool) -> Result<(), StaticCode> {
        let index = self.turns.len() - 1;
        let bytes = self.turns[index].bytes;
        if bytes == 0 {
            return Ok(());
        }
        if !force && bytes < AUDIO_BYTES_PER_SECOND {
            self.pending_commit = true;
            return Ok(());
        }
        provider
            .commit()
            .await
            .map_err(|failure| self.provider_error(failure))?;
        self.turns[index].committed = Some(Instant::now());
        self.commits.push_back(index);
        self.turns.push(Turn {
            bytes: 0,
            text: String::new(),
            final_text: None,
            committed: None,
        });
        self.pending_commit = false;
        Ok(())
    }
    fn event(&mut self, event: LiveEvent) -> Result<Option<Value>, StaticCode> {
        match event {
            LiveEvent::Committed { item_id, .. } => {
                let index = self.commits.pop_front().ok_or(StaticCode::ProviderFailed)?;
                if self
                    .items
                    .get(&item_id)
                    .is_some_and(|known| *known != index)
                {
                    return Err(StaticCode::ProviderFailed);
                }
                self.items.insert(item_id, index);
                Ok(None)
            }
            LiveEvent::Text { item_id, delta } => {
                let next = self
                    .commits
                    .front()
                    .copied()
                    .unwrap_or(self.turns.len() - 1);
                if !self.items.contains_key(&item_id)
                    && self.items.values().any(|index| *index == next)
                {
                    return Err(StaticCode::ProviderFailed);
                }
                let index = *self.items.entry(item_id).or_insert(next);
                if self
                    .turns
                    .iter()
                    .map(|turn| turn.text.len() + turn.final_text.as_ref().map_or(0, String::len))
                    .sum::<usize>()
                    + delta.len()
                    > LINGER_PER_PRINCIPAL
                {
                    return Err(StaticCode::ProviderFailed);
                }
                self.turns[index].text.push_str(&delta);
                self.last_text_bytes = self.bytes;
                Ok(Some(json!({"type":"text","turn":index+1,"delta":delta})))
            }
            LiveEvent::Completed { item_id, text } => {
                let index = *self.items.get(&item_id).ok_or(StaticCode::ProviderFailed)?;
                if self.turns[index].final_text.is_some() {
                    return Err(StaticCode::ProviderFailed);
                }
                if text.len() > LINGER_PER_PRINCIPAL
                    || self
                        .turns
                        .iter()
                        .map(|turn| {
                            turn.text.len() + turn.final_text.as_ref().map_or(0, String::len)
                        })
                        .sum::<usize>()
                        + text.len()
                        > LINGER_PER_PRINCIPAL
                {
                    return Err(StaticCode::ProviderFailed);
                }
                self.turns[index].text.clear();
                self.turns[index].final_text = Some(text.clone());
                self.last_text_bytes = self.bytes;
                Ok(Some(json!({"type":"turn","turn":index+1,"text":text})))
            }
            LiveEvent::Failed { failure, .. } => Err(self.provider_error(failure)),
            LiveEvent::Closed => Err(StaticCode::ProviderFailed),
        }
    }
}

async fn write_while_active(
    service: &Service,
    deadline: tokio::time::Instant,
    write: impl std::future::Future<Output = Result<(), StaticCode>>,
) -> Result<(), StaticCode> {
    tokio::select! {
        biased;
        _=service.drain.cancelled()=>Err(StaticCode::Restarting),
        _=tokio::time::sleep_until(deadline)=>Err(StaticCode::SessionLimit),
        result=write=>result,
    }
}

pub async fn upgrade(
    State(service): State<Arc<Service>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let protocols = request
        .headers()
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(',').map(str::trim))
        .collect::<Vec<_>>();
    let has_protocol = protocols
        .iter()
        .filter(|value| **value == "wm-live.v1")
        .count()
        == 1;
    let offered_passes = protocols
        .iter()
        .filter(|value| value.starts_with("wm-pass."))
        .copied()
        .collect::<Vec<_>>();
    let header_pass = match bearer(request.headers()) {
        Ok(token) => token,
        Err(code) => {
            service.refusals.count(code);
            return refusal(code, None);
        }
    };
    if !has_protocol
        || offered_passes.len() > 1
        || (header_pass.is_some() && !offered_passes.is_empty())
        || protocols.len() > 1 + offered_passes.len()
    {
        service.refusals.count("pass_malformed");
        return refusal("pass_malformed", None);
    }
    let token = header_pass.or(offered_passes.first().copied());
    let identity = match authenticate_token(&service, token).await {
        Ok(identity) => identity,
        Err(code) => return refusal(code, None),
    };
    let label = service.policy.tiers.label(
        &url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .find(|(key, _)| key == "label")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default(),
    );
    let (mut parts, _) = request.into_parts();
    let socket = match WebSocketUpgrade::from_request_parts(&mut parts, &service).await {
        Ok(socket) => socket,
        Err(_) => {
            return reject(
                &service,
                &identity,
                StaticCode::InvalidRequest,
                "call.transcription",
            )
            .await;
        }
    };
    socket
        .protocols(["wm-live.v1"])
        .max_frame_size(MAX_AUDIO_FRAME)
        .max_message_size(MAX_AUDIO_FRAME)
        .on_upgrade(move |socket| session(service, identity, id, label, socket))
        .into_response()
}

async fn first_failure(
    service: &Service,
    identity: &Identity,
    label: &str,
    started: Instant,
    socket: &mut WebSocket,
    code: StaticCode,
) {
    let allowance = if code == StaticCode::AccountingUnavailable {
        None
    } else {
        crate::database(
            "ledger.allowance",
            service.ledger.allowance(identity, service.now()),
        )
        .await
        .ok()
    };
    if matches!(code, StaticCode::RateLimited | StaticCode::Busy) {
        service.refusals.count(code.as_str());
    } else {
        tracing::info!(
            operation = "call.transcription",
            product = "ai",
            door = "public",
            code = code.wire().as_str(),
            ceiling = code.ceiling(),
            client = identity.client.as_str(),
            tier = allowance.as_ref().map(|value| value.tier.as_str()),
            label,
            environment = service.config.environment.label(),
            duration_ms = started.elapsed().as_millis() as u64,
            "refused"
        );
    }
    let message = json!({"type":"failed","code":code.wire().as_str(),"text":"","seconds":0,"charged":null,"allowance":allowance.as_ref().and_then(wire::allowance)});
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        socket.send(Message::Text(message.to_string().into())),
    )
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.close()).await;
}

async fn session(
    service: Arc<Service>,
    identity: Identity,
    id: String,
    label: String,
    mut socket: WebSocket,
) {
    let started = Instant::now();
    let caller = match CallerId::new(id) {
        Ok(caller) => caller,
        Err(code) => {
            first_failure(&service, &identity, &label, started, &mut socket, code).await;
            return;
        }
    };
    match crate::database(
        "ledger.lookup",
        service.ledger.lookup(&identity.principal, &caller),
    )
    .await
    {
        Ok(Some(_)) => {
            let code = if crate::read_rate(&service, &identity) {
                StaticCode::Conflict
            } else {
                StaticCode::RateLimited
            };
            first_failure(&service, &identity, &label, started, &mut socket, code).await;
            return;
        }
        Ok(None) => {}
        Err(code) => {
            first_failure(&service, &identity, &label, started, &mut socket, code).await;
            return;
        }
    }
    let lifecycle = match crate::lifecycle(&service).await {
        Ok(guard) => guard,
        Err(code) => {
            first_failure(&service, &identity, &label, started, &mut socket, code).await;
            return;
        }
    };
    let admission = async {
        if service.drain.is_cancelled() {
            return Err(StaticCode::Busy);
        }
        if !crate::ledger_ready(&service.ledger).await {
            return Err(StaticCode::AccountingUnavailable);
        }
        let permit = service
            .calls
            .clone()
            .try_acquire_owned()
            .map_err(|_| StaticCode::Busy)?;
        let session_permit = service
            .sessions
            .clone()
            .try_acquire_owned()
            .map_err(|_| StaticCode::Busy)?;
        let allowance = crate::database(
            "ledger.allowance",
            service.ledger.allowance(&identity, service.now()),
        )
        .await?;
        let row = service.policy.tiers.row(allowance.tier)?;
        if !service.rates.allow(
            crate::rate_key(&identity),
            true,
            row.calls_per_minute as usize,
        ) {
            return Err(StaticCode::RateLimited);
        }
        if !allowance.transcription {
            return Err(StaticCode::FundingRequired);
        }
        if allowance.code != StaticCode::Ok {
            return Err(allowance.code);
        }
        let provider = service.policy.tiers.transcription.provider;
        if crate::database("ledger.fuse", service.ledger.fuse(provider, service.now()))
            .await?
            .paused
        {
            return Err(StaticCode::Paused);
        }
        if service.drain.is_cancelled() {
            return Err(StaticCode::Busy);
        }
        if service.live.is_none() {
            return Err(StaticCode::ProviderUnavailable);
        }
        if service.config.environment == crate::pass::Environment::Production
            && !service
                .policy
                .prices
                .model(provider, &service.policy.tiers.transcription.model)?
                .audio_billing_verified
        {
            return Err(StaticCode::ProviderUnavailable);
        }
        let call = match crate::database(
            "ledger.admit",
            service.ledger.admit(
                Admission {
                    expected_route: ModelRoute {
                        provider,
                        model: service.policy.tiers.transcription.model.clone(),
                        served: ModelClass::Small,
                    },
                    identity: identity.clone(),
                    caller_id: caller,
                    label: label.clone(),
                    requested: ModelClass::Small,
                    reservation: Reservation::Transcription,
                },
                service.now(),
            ),
        )
        .await?
        {
            AdmissionOutcome::Admitted(call) => call,
            AdmissionOutcome::Existing(_) => return Err(StaticCode::Conflict),
        };
        Ok((call, permit, session_permit))
    }
    .await;
    let (mut call, permit, _session_permit) = match admission {
        Ok(value) => value,
        Err(code) => {
            first_failure(&service, &identity, &label, started, &mut socket, code).await;
            return;
        }
    };
    let active = ActiveCall::new(service.clone(), call.id, permit);
    let entry = service
        .results
        .create(call.id.to_string(), principal_key(&call.principal), true);
    let _producer = entry.producer();
    drop(lifecycle);
    let call_start = Instant::now();
    if let Err(code) = crate::dispatch(&service, call.id).await {
        let charged = settle(
            service.clone(),
            call.clone(),
            Settlement {
                charge: Charge::Unconsumed,
                stop: None,
                code: Some(code),
                provider_request_id: None,
            },
            active,
            telemetry::CallSignal::new(call_start),
        )
        .await;
        let message = json!({"type":"failed","code":code.as_str(),"text":"","seconds":0,"charged":charged.map(NanoUsd::usd),"allowance":null});
        service
            .results
            .push(&entry, "failed", message.clone(), true);
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            socket.send(Message::Text(message.to_string().into())),
        )
        .await;
        return;
    }
    let mut provider = match service.live.as_ref().unwrap().open().await {
        Ok(provider) => provider,
        Err(failure) => {
            service.provider_health.observe(
                call.route.provider,
                failure.http_status,
                service.now(),
            );
            let signal = telemetry::CallSignal {
                started: call_start,
                http_status: failure.http_status,
                failure_kind: Some(failure.kind),
                refusal: failure.refusal,
                usage: None,
            };
            if failure.key_account_fault {
                telemetry::report_failure("provider.transcription", "provider_credentials", None);
            }
            let charged = settle(
                service.clone(),
                call.clone(),
                Settlement {
                    charge: Charge::Unconsumed,
                    stop: None,
                    code: Some(StaticCode::ProviderUnavailable),
                    provider_request_id: failure.request_id,
                },
                active,
                signal,
            )
            .await;
            let allowance = crate::database(
                "ledger.allowance",
                service.ledger.allowance(&identity, service.now()),
            )
            .await
            .ok()
            .and_then(|value| wire::allowance(&value));
            let message = json!({"type":"failed","code":"provider_unavailable","text":"","seconds":0,"charged":charged.map(NanoUsd::usd),"allowance":allowance});
            service
                .results
                .push(&entry, "failed", message.clone(), true);
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                socket.send(Message::Text(message.to_string().into())),
            )
            .await;
            return;
        }
    };
    service
        .provider_health
        .observe(call.route.provider, Some(101), service.now());
    let provider_request_id = provider.request_id.clone();
    let start = Instant::now();
    let deadline = tokio::time::Instant::now() + MAX_SESSION;
    let mut last_audio = start;
    let mut last_sent = start;
    let mut ping: Option<Instant> = None;
    let (mut sink, mut source) = socket.split();
    let (sender, mut receiver) = mpsc::channel::<Message>(32);
    let disconnected = CancellationToken::new();
    let writer_disconnect = disconnected.clone();
    let writer = tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), sink.send(message)).await,
                Ok(Ok(()))
            ) {
                writer_disconnect.cancel();
                break;
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
    });
    let remaining = crate::database(
        "ledger.allowance",
        service.ledger.allowance(&identity, service.now()),
    )
    .await
    .ok()
    .and_then(|a| {
        service
            .policy
            .prices
            .model(call.route.provider, &call.route.model)
            .ok()
            .and_then(|price| price.audio_rate().ok())
            .map(|rate| {
                u64::try_from(
                    u128::try_from(a.remaining.nanos().saturating_add(call.reservation.nanos()))
                        .unwrap_or_default()
                        * 60
                        / u128::try_from(rate.nanos().max(1)).unwrap_or(1),
                )
                .unwrap_or(u64::MAX)
            })
    })
    .unwrap_or(LIVE_SLICE);
    let _ = sender.try_send(Message::Text(
        json!({"type":"started","callId":call.caller_id.as_str(),"remainingSeconds":remaining})
            .to_string()
            .into(),
    ));
    let mut transcript = Transcript::new();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let (code, failed) = loop {
        tokio::select! {
            _=service.drain.cancelled()=>break(Some(StaticCode::Restarting),false),
            _=disconnected.cancelled()=>break(Some(StaticCode::WentAway),false),
            _=tick.tick()=>{
                if start.elapsed()>=MAX_SESSION{break(Some(StaticCode::SessionLimit),false);}
                if last_audio.elapsed()>=LIVE_IDLE||transcript.bytes.saturating_sub(transcript.last_text_bytes)>=LIVE_SILENT*AUDIO_BYTES_PER_SECOND{break(Some(StaticCode::Idle),false);}
                if transcript.timed_out(){transcript.failure_kind=Some(FailureKind::Timeout);break(Some(StaticCode::ProviderFailed),true);}
                if ping.is_some_and(|at|at.elapsed()>=LIVE_PONG){break(Some(StaticCode::WentAway),false);}
                if last_sent.elapsed()>=HEARTBEAT&&ping.is_none(){if sender.try_send(Message::Ping(Vec::new().into())).is_err(){break(Some(StaticCode::WentAway),false);}ping=Some(Instant::now());last_sent=Instant::now();}
            },
            event=provider.next_event()=>{
                match event.map_err(|failure|transcript.provider_error(failure)).and_then(|event|transcript.event(event)){
                    Ok(Some(message))=>{if sender.try_send(Message::Text(message.to_string().into())).is_err(){break(Some(StaticCode::WentAway),false);}last_sent=Instant::now();},Ok(None)=>{},Err(code)=>break(Some(code),true),
                }
            },
            frame=source.next()=>{
                match frame{
                    Some(Ok(Message::Binary(bytes)))=>{
                        if bytes.is_empty()||bytes.len()%2!=0||bytes.len()>MAX_AUDIO_FRAME{break(Some(StaticCode::InvalidRequest),true);}
                        last_audio=Instant::now();
                        let duration=Duration::from_nanos((transcript.bytes+bytes.len() as u64).saturating_mul(1_000_000_000)/AUDIO_BYTES_PER_SECOND);
                        if duration>start.elapsed()+Duration::from_secs(LIVE_BURST){
                            let wait=duration.saturating_sub(start.elapsed()+Duration::from_secs(LIVE_BURST));
                            tokio::select!{_=tokio::time::sleep(wait)=>{},_=service.drain.cancelled()=>break(Some(StaticCode::Restarting),false)}
                        }
                        let mut offset=0;let mut fault=None;
                        while offset<bytes.len(){
                            let room=(60*AUDIO_BYTES_PER_SECOND-transcript.turns.last().unwrap().bytes) as usize;
                            let length=(bytes.len()-offset).min(room);
                            let candidate=transcript.candidate_seconds(length as u64);
                            if candidate>u64::from(call.slices)*LIVE_SLICE{
                                let progress=LiveProgress{slice:call.slices+1,audio_bytes:transcript.bytes,audio_seconds:transcript.seconds(),turns:transcript.completed_turns()};
                                match tokio::time::timeout(LIVE_EXTEND,service.ledger.extend_live(call.id,progress,service.now())).await{
                                    Ok(Ok(value))=>call=value,Ok(Err(code))=>{fault=Some((code,code==StaticCode::AccountingUnavailable));break;},Err(_)=>{fault=Some((StaticCode::AccountingUnavailable,true));break;}
                                }
                            }
                            if let Err(code)=write_while_active(&service,deadline,transcript.forward(&mut provider,&bytes[offset..offset+length])).await{fault=Some((code,code==StaticCode::ProviderFailed));break;}
                            offset+=length;
                            if (transcript.turns.last().unwrap().bytes==60*AUDIO_BYTES_PER_SECOND||(transcript.pending_commit&&transcript.turns.last().unwrap().bytes>=AUDIO_BYTES_PER_SECOND)) && let Err(code)=write_while_active(&service,deadline,transcript.commit(&mut provider,false)).await{fault=Some((code,code==StaticCode::ProviderFailed));break;}
                        }
                        if let Some((code,failed))=fault{break(Some(code),failed);}
                    },
                    Some(Ok(Message::Text(text)))=>{
                        let control=match serde_json::from_str::<Control>(&text){Ok(control)=>control,Err(_)=>break(Some(StaticCode::InvalidRequest),true)};
                        match control{
                            Control::Context{keywords}=>{if transcript.bytes!=0||keywords.len()>256||keywords.iter().any(|word|word.is_empty()||word.len()>256){break(Some(StaticCode::InvalidRequest),true);}
                            if let Err(code)=write_while_active(&service,deadline,async{provider.context(&keywords).await.map_err(|failure|transcript.provider_error(failure))}).await{break(Some(code),code==StaticCode::ProviderFailed);}},
                            Control::Commit=>if let Err(code)=write_while_active(&service,deadline,transcript.commit(&mut provider,false)).await{break(Some(code),code==StaticCode::ProviderFailed);},
                            Control::End=>break(None,false),
                        }
                    },Some(Ok(Message::Pong(_)))=>{ping=None;},Some(Ok(Message::Close(_)))|None=>break(Some(StaticCode::WentAway),false),
                    Some(Ok(Message::Ping(_)))=>break(Some(StaticCode::InvalidRequest),true),Some(Err(_))=>break(Some(StaticCode::InvalidRequest),true),
                }
            }
        }
    };
    if code == Some(StaticCode::AccountingUnavailable) {
        telemetry::report_failure("ledger.extend_live", "accounting_unavailable", None);
    }
    let mut final_code = code;
    let mut final_failed = failed;
    if !provider.is_closed()
        && transcript.commit(&mut provider, true).await.is_err()
        && !final_failed
    {
        final_code = Some(StaticCode::ProviderFailed);
        final_failed = true;
    }
    let close_start = Instant::now();
    while !provider.is_closed()
        && transcript.outstanding()
        && close_start.elapsed() < LIVE_CLOSE_WAIT
    {
        match tokio::time::timeout(
            LIVE_CLOSE_WAIT.saturating_sub(close_start.elapsed()),
            provider.next_event(),
        )
        .await
        {
            Ok(Ok(event)) => match transcript.event(event) {
                Ok(Some(message)) => {
                    let _ = sender.try_send(Message::Text(message.to_string().into()));
                }
                Ok(None) => {}
                Err(_) => {
                    final_code = Some(StaticCode::ProviderFailed);
                    final_failed = true;
                    break;
                }
            },
            Ok(Err(failure)) => {
                transcript.provider_error(failure);
                final_code = Some(StaticCode::ProviderFailed);
                final_failed = true;
                break;
            }
            Err(_) => break,
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), provider.close()).await;
    let stop = if final_code.is_none() {
        Stop::Completed
    } else {
        Stop::Cut
    };
    let charged = settle(
        service.clone(),
        call.clone(),
        Settlement {
            charge: Charge::Audio {
                bytes: transcript.bytes,
                seconds: transcript.seconds(),
                turns: transcript.completed_turns(),
            },
            stop: Some(stop),
            code: final_code,
            provider_request_id,
        },
        active,
        telemetry::CallSignal {
            started: call_start,
            http_status: Some(101),
            failure_kind: transcript.failure_kind.or_else(|| {
                (final_code == Some(StaticCode::ProviderFailed)).then_some(FailureKind::Protocol)
            }),
            refusal: None,
            usage: None,
        },
    )
    .await;
    let allowance = crate::database(
        "ledger.allowance",
        service.ledger.allowance(&identity, service.now()),
    )
    .await
    .ok()
    .and_then(|value| wire::allowance(&value));
    let message = if final_failed {
        json!({"type":"failed","code":final_code.map(StaticCode::as_str),"text":transcript.text(),"seconds":transcript.seconds(),"charged":charged.map(NanoUsd::usd),"allowance":allowance})
    } else {
        json!({"type":"ended","stop":stop.as_str(),"code":final_code.map(StaticCode::as_str),"text":transcript.text(),"seconds":transcript.seconds(),"charged":charged.map(NanoUsd::usd),"allowance":allowance})
    };
    service.results.push(
        &entry,
        if final_failed { "failed" } else { "ended" },
        message.clone(),
        true,
    );
    let _ = sender.try_send(Message::Text(message.to_string().into()));
    drop(sender);
    let _ = tokio::time::timeout(Duration::from_secs(3), writer).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn audio_timeout_counts_the_attempted_frame_and_drops_provider_socket() {
        use ai_providers::{LiveAuth, LiveClient, LiveConfig, Secret};
        use tokio_tungstenite::tungstenite::Message as ProviderMessage;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let release = CancellationToken::new();
        let provider_release = release.clone();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let config: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            socket
                .send(ProviderMessage::Text(
                    json!({"type":"session.updated","session":config["session"]})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            provider_release.cancelled().await;
        });
        let client = LiveClient::new(LiveConfig {
            url: format!("ws://{address}/realtime?intent=transcription"),
            key: Secret::new("fixture".to_owned()),
            auth: LiveAuth::Bearer,
            model: "gpt-live-transcribe".to_owned(),
            delay: "low".to_owned(),
        })
        .unwrap();
        let mut provider = client.open().await.unwrap();
        let mut transcript = Transcript::new();
        let frame = vec![0; MAX_AUDIO_FRAME];
        let mut successful = 0;
        tokio::time::timeout(Duration::from_secs(15), async {
            while transcript.forward(&mut provider, &frame).await.is_ok() {
                successful += 1;
            }
        })
        .await
        .expect("stalled audio send exceeded its client deadline");
        assert_eq!(transcript.bytes, (successful + 1) * MAX_AUDIO_FRAME as u64);
        assert_eq!(transcript.turns[0].bytes, transcript.bytes);
        assert_eq!(
            transcript.seconds(),
            transcript.bytes.div_ceil(AUDIO_BYTES_PER_SECOND)
        );
        assert!(provider.is_closed());
        release.cancel();
        task.await.unwrap();
    }

    #[test]
    fn slice_ceiling_counts_each_turn_rounding_before_forward() {
        let mut transcript = Transcript::new();
        transcript.turns.clear();
        for _ in 0..30 {
            transcript.turns.push(Turn {
                bytes: 48_002,
                text: String::new(),
                final_text: None,
                committed: Some(Instant::now()),
            });
        }
        transcript.turns.push(Turn {
            bytes: 0,
            text: String::new(),
            final_text: None,
            committed: None,
        });
        assert_eq!(transcript.seconds(), 60);
        assert_eq!(transcript.candidate_seconds(2), 61);
        assert_eq!(transcript.completed_turns(), 30);
    }

    #[test]
    fn final_transcript_keeps_commit_order_when_finals_arrive_out_of_order() {
        let mut transcript = Transcript::new();
        transcript.turns = vec![
            Turn {
                bytes: 48_000,
                text: String::new(),
                final_text: None,
                committed: Some(Instant::now()),
            },
            Turn {
                bytes: 48_000,
                text: String::new(),
                final_text: None,
                committed: Some(Instant::now()),
            },
            Turn {
                bytes: 0,
                text: String::new(),
                final_text: None,
                committed: None,
            },
        ];
        transcript.commits = VecDeque::from([0, 1]);
        transcript
            .event(LiveEvent::Committed {
                item_id: "first".to_owned(),
                previous_item_id: None,
            })
            .unwrap();
        transcript
            .event(LiveEvent::Committed {
                item_id: "second".to_owned(),
                previous_item_id: Some("first".to_owned()),
            })
            .unwrap();
        assert_eq!(
            transcript
                .event(LiveEvent::Completed {
                    item_id: "second".to_owned(),
                    text: "world".to_owned()
                })
                .unwrap(),
            Some(json!({"type":"turn","turn":2,"text":"world"}))
        );
        assert_eq!(
            transcript
                .event(LiveEvent::Text {
                    item_id: "first".to_owned(),
                    delta: "Hello".to_owned()
                })
                .unwrap(),
            Some(json!({"type":"text","turn":1,"delta":"Hello"}))
        );
        assert_eq!(transcript.text(), "Hello world");
        assert_eq!(transcript.seconds(), 2);
    }
}
