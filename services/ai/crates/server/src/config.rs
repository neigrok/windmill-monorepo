use crate::pass::{Environment, PassVerifier};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sentry::types::Dsn;
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc, time::Duration};
use tracing_subscriber::filter::LevelFilter;

pub const HEADER_DEADLINE: Duration = Duration::from_secs(10);
pub const BODY_DEADLINE: Duration = Duration::from_secs(60);
pub const CALL_TIMEOUT: Duration = Duration::from_secs(600);
pub const DRAIN: Duration = Duration::from_secs(660);
pub const HEARTBEAT: Duration = Duration::from_secs(15);
pub const RESULT_LINGER: Duration = Duration::from_secs(600);
pub const SETTLE_RETRY: Duration = Duration::from_secs(30);
pub const SWEEP_EVERY: Duration = Duration::from_secs(60);
pub const MAX_TEXT_BODY: usize = 8 * 1024 * 1024;
pub const MAX_AUDIO_FRAME: usize = 64 * 1024;
pub const LINGER_PER_PRINCIPAL: usize = 16 * 1024 * 1024;
pub const LINGER_TOTAL: usize = 256 * 1024 * 1024;
pub const READS_PER_MINUTE: usize = 120;
pub const CALLS_IN_FLIGHT_MAX: usize = 256;
pub const LIVE_SESSIONS_MAX: usize = 64;
pub const LIVE_SLICE: u64 = 60;
pub const MAX_SESSION: Duration = Duration::from_secs(55 * 60);
pub const LIVE_IDLE: Duration = Duration::from_secs(60);
pub const LIVE_EXTEND: Duration = Duration::from_secs(5);
pub const LIVE_CLOSE_WAIT: Duration = Duration::from_secs(10);
pub const TURN_WAIT: Duration = Duration::from_secs(30);
pub const LIVE_PONG: Duration = Duration::from_secs(20);
pub const LIVE_BURST: u64 = 10;
pub const LIVE_SILENT: u64 = 180;
pub const AUDIO_BYTES_PER_SECOND: u64 = 48_000;

pub struct Config {
    pub public_address: SocketAddr,
    pub internal_address: SocketAddr,
    pub database_url: String,
    pub environment: Environment,
    pub verifier: Arc<PassVerifier>,
    pub carry_key: [u8; 32],
    pub funding_secret: String,
    pub operator_secret: String,
    pub anthropic_key: Option<String>,
    pub openai_key: Option<String>,
    pub azure_key: Option<String>,
    pub anthropic_url: String,
    pub openai_url: String,
    pub azure_url: Option<String>,
    pub azure_deployment: Option<String>,
    pub release: Option<String>,
    pub sentry_dsn: Option<Dsn>,
    pub log_level: LevelFilter,
    pub sentry_log_level: LevelFilter,
}

impl Config {
    pub fn from_environment(read: impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        let optional = |key| read(key).filter(|s| !s.is_empty());
        let required = |key| optional(key).ok_or(key);
        let environment = match required("AI_ENVIRONMENT")?.as_str() {
            "development" => Environment::Development,
            "production" => Environment::Production,
            _ => return Err("AI_ENVIRONMENT"),
        };
        let keys: BTreeMap<String, String> =
            serde_json::from_str(&optional("AI_PASS_KEYS").unwrap_or_else(|| "{}".to_owned()))
                .map_err(|_| "AI_PASS_KEYS")?;
        let verifier = Arc::new(PassVerifier::new(environment, keys).map_err(|_| "AI_PASS_KEYS")?);
        let carry_key = URL_SAFE_NO_PAD
            .decode(required("AI_CARRY_KEY")?)
            .map_err(|_| "AI_CARRY_KEY")?
            .try_into()
            .map_err(|_| "AI_CARRY_KEY")?;
        let anthropic_url =
            optional("AI_ANTHROPIC_URL").unwrap_or_else(|| "https://api.anthropic.com".to_owned());
        let openai_url = optional("AI_OPENAI_URL")
            .unwrap_or_else(|| "wss://api.openai.com/v1/realtime?intent=transcription".to_owned());
        let azure_url = optional("AI_AZURE_URL");
        for (name, value, secure) in [
            ("AI_ANTHROPIC_URL", Some(&anthropic_url), "https"),
            ("AI_OPENAI_URL", Some(&openai_url), "wss"),
            ("AI_AZURE_URL", azure_url.as_ref(), "wss"),
        ] {
            if let Some(value) = value {
                let url = url::Url::parse(value).map_err(|_| name)?;
                let loopback = url.host_str().is_some_and(|host| {
                    host == "localhost"
                        || host
                            .trim_matches(['[', ']'])
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|ip| ip.is_loopback())
                });
                let dev = environment == Environment::Development
                    && loopback
                    && (url.scheme() == "http" || url.scheme() == "ws");
                if (url.scheme() != secure && !dev)
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                {
                    return Err(name);
                }
            }
        }
        let funding_secret = required("AI_FUNDING_SECRET")?;
        let operator_secret = required("AI_OPERATOR_SECRET")?;
        if funding_secret.len() < 32
            || operator_secret.len() < 32
            || funding_secret == operator_secret
        {
            return Err("AI_INTERNAL_SECRETS");
        }
        let database_url = required("AI_DATABASE_URL")?;
        let database = url::Url::parse(&database_url).map_err(|_| "AI_DATABASE_URL")?;
        if !matches!(database.scheme(), "postgres" | "postgresql")
            || environment == Environment::Production
                && (database.username() != "windmill_ai" || database.path() != "/windmill_ai")
        {
            return Err("AI_DATABASE_URL");
        }
        let config = Self {
            public_address: optional("AI_PUBLIC_ADDRESS")
                .unwrap_or_else(|| "0.0.0.0:8084".to_owned())
                .parse()
                .map_err(|_| "AI_PUBLIC_ADDRESS")?,
            internal_address: optional("AI_INTERNAL_ADDRESS")
                .unwrap_or_else(|| "0.0.0.0:8085".to_owned())
                .parse()
                .map_err(|_| "AI_INTERNAL_ADDRESS")?,
            database_url,
            environment,
            verifier,
            carry_key,
            funding_secret,
            operator_secret,
            anthropic_key: optional("AI_ANTHROPIC_KEY"),
            openai_key: optional("AI_OPENAI_KEY"),
            azure_key: optional("AI_AZURE_KEY"),
            anthropic_url,
            openai_url,
            azure_url,
            azure_deployment: optional("AI_AZURE_DEPLOYMENT"),
            release: optional("SENTRY_RELEASE"),
            sentry_dsn: optional("SENTRY_DSN")
                .map(|value| value.parse().map_err(|_| "SENTRY_DSN"))
                .transpose()?,
            log_level: LevelFilter::INFO,
            sentry_log_level: LevelFilter::INFO,
        };
        if config.public_address.port() == config.internal_address.port() {
            return Err("AI_INTERNAL_ADDRESS");
        }
        Ok(config)
    }
}
