use std::fmt;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::str::FromStr;

use app_store::server_api::{ApiKey, PrivateKey};
use reqwest::Url;
use sentry::types::Dsn;
use storage::DatabaseUrl;
use tracing_subscriber::filter::LevelFilter;

use crate::internal::BearerSecret;

// The deployments that may turn on what only tests need, the forced-panic route, the App Store test root and an Apple of
// the test's own, matched trimmed and in any case.
const TEST_DEPLOYMENTS: [&str; 4] = ["local", "development", "test", "ci"];

#[derive(Debug, PartialEq)]
pub struct Config {
    pub public_address: SocketAddr,
    pub internal_address: SocketAddr,
    pub database_url: DatabaseUrl,
    pub environment: String,
    pub release: Option<String>,
    pub sentry_dsn: Option<Dsn>,
    pub log_level: LevelFilter,
    pub sentry_log_level: LevelFilter,
    pub panic_route_enabled: bool,
    pub app_store_test_root: Option<PathBuf>,
    pub app_store_api: AppStoreApiKey,
    pub app_store_api_test_url: Option<Url>,
    pub internal_token: Option<BearerSecret>,
}

// The in-app purchase key the App Store Server API is called with, from its three variables. One left unset turns the
// API off and the service starts without it, naming what is missing when another is set.
#[derive(Debug, PartialEq)]
pub enum AppStoreApiKey {
    Unset,
    Lacking(Vec<&'static str>),
    Set(ApiKey),
}

impl AppStoreApiKey {
    pub fn key(&self) -> Option<&ApiKey> {
        match self {
            AppStoreApiKey::Set(key) => Some(key),
            AppStoreApiKey::Unset | AppStoreApiKey::Lacking(_) => None,
        }
    }
}

// What a CLI command needs to call the App Store Server API without opening the ledger or starting either listener.
#[derive(Debug, PartialEq)]
pub struct AppStoreApiConfig {
    pub key: ApiKey,
    pub test_url: Option<Url>,
}

impl AppStoreApiConfig {
    pub fn from_environment(
        read: impl Fn(&str) -> Option<String>,
    ) -> Result<AppStoreApiConfig, ConfigError> {
        let variables = Variables(read);
        let key = ApiKey {
            issuer_id: variables.required("SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID")?,
            key_id: variables.required("SUBSCRIPTIONS_APP_STORE_API_KEY_ID")?,
            private_key: variables.required("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY")?,
        };
        let test_url = variables.base_url("SUBSCRIPTIONS_APP_STORE_API_TEST_URL")?;
        if test_url.is_some() {
            let environment: Option<String> = variables.optional("SENTRY_ENVIRONMENT")?;
            if !environment.as_deref().is_some_and(is_test_deployment) {
                return Err(ConfigError {
                    variable: "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
                    problem: Problem::RefusedInEnvironment,
                });
            }
        }
        Ok(AppStoreApiConfig { key, test_url })
    }
}

fn is_test_deployment(environment: &str) -> bool {
    let normalized = environment.trim().to_ascii_lowercase();
    TEST_DEPLOYMENTS.contains(&normalized.as_str())
}

impl Config {
    // An empty value counts as unset: compose renders an unset `${NAME:-}` as an empty string.
    pub fn from_environment(read: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let variables = Variables(read);
        let config = Config {
            public_address: variables.address("SUBSCRIPTIONS_PUBLIC_ADDRESS")?,
            internal_address: variables.address("SUBSCRIPTIONS_INTERNAL_ADDRESS")?,
            database_url: variables.required("SUBSCRIPTIONS_DATABASE_URL")?,
            environment: variables.required("SENTRY_ENVIRONMENT")?,
            release: variables.optional("SENTRY_RELEASE")?,
            sentry_dsn: variables.optional("SENTRY_DSN")?,
            log_level: variables
                .optional("WINDMILL_LOG_LEVEL")?
                .map_or(LevelFilter::INFO, |LogLevel(level)| level),
            sentry_log_level: variables
                .optional("SENTRY_LOG_LEVEL")?
                .map_or(LevelFilter::INFO, |LogLevel(level)| level),
            panic_route_enabled: variables
                .optional("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED")?
                .unwrap_or(false),
            app_store_test_root: variables.optional("SUBSCRIPTIONS_APP_STORE_TEST_ROOT")?,
            app_store_api: variables.app_store_api_key()?,
            app_store_api_test_url: variables.base_url("SUBSCRIPTIONS_APP_STORE_API_TEST_URL")?,
            internal_token: variables.optional("SUBSCRIPTIONS_INTERNAL_TOKEN")?,
        };
        let test_deployment = is_test_deployment(&config.environment);
        let test_only = [
            (
                "SUBSCRIPTIONS_PANIC_ROUTE_ENABLED",
                config.panic_route_enabled,
            ),
            (
                "SUBSCRIPTIONS_APP_STORE_TEST_ROOT",
                config.app_store_test_root.is_some(),
            ),
            (
                "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
                config.app_store_api_test_url.is_some(),
            ),
        ];
        if let Some((variable, _)) = test_only
            .into_iter()
            .find(|(_, turned_on)| *turned_on && !test_deployment)
        {
            return Err(ConfigError {
                variable,
                problem: Problem::RefusedInEnvironment,
            });
        }
        Ok(config)
    }
}

// The words the backend reads from the same two variables, in any case; `fatal` reads as `error`.
struct LogLevel(LevelFilter);

impl FromStr for LogLevel {
    type Err = ();

    fn from_str(value: &str) -> Result<LogLevel, ()> {
        match value.to_ascii_lowercase().as_str() {
            "trace" => Ok(LogLevel(LevelFilter::TRACE)),
            "debug" => Ok(LogLevel(LevelFilter::DEBUG)),
            "info" => Ok(LogLevel(LevelFilter::INFO)),
            "warn" => Ok(LogLevel(LevelFilter::WARN)),
            "error" | "fatal" => Ok(LogLevel(LevelFilter::ERROR)),
            _ => Err(()),
        }
    }
}

struct Variables<F>(F);

impl<F: Fn(&str) -> Option<String>> Variables<F> {
    fn optional<T: FromStr>(&self, variable: &'static str) -> Result<Option<T>, ConfigError> {
        match (self.0)(variable).filter(|value| !value.is_empty()) {
            None => Ok(None),
            Some(value) => value.parse().map(Some).map_err(|_| ConfigError {
                variable,
                problem: Problem::Malformed,
            }),
        }
    }

    fn required<T: FromStr>(&self, variable: &'static str) -> Result<T, ConfigError> {
        self.optional(variable)?.ok_or(ConfigError {
            variable,
            problem: Problem::Missing,
        })
    }

    fn app_store_api_key(&self) -> Result<AppStoreApiKey, ConfigError> {
        let issuer_id: Option<String> = self.optional("SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID")?;
        let key_id: Option<String> = self.optional("SUBSCRIPTIONS_APP_STORE_API_KEY_ID")?;
        let private_key: Option<PrivateKey> =
            self.optional("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY")?;
        Ok(match (issuer_id, key_id, private_key) {
            (Some(issuer_id), Some(key_id), Some(private_key)) => AppStoreApiKey::Set(ApiKey {
                issuer_id,
                key_id,
                private_key,
            }),
            (None, None, None) => AppStoreApiKey::Unset,
            (issuer_id, key_id, private_key) => AppStoreApiKey::Lacking(
                [
                    ("SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID", issuer_id.is_none()),
                    ("SUBSCRIPTIONS_APP_STORE_API_KEY_ID", key_id.is_none()),
                    (
                        "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY",
                        private_key.is_none(),
                    ),
                ]
                .into_iter()
                .filter(|(_, unset)| *unset)
                .map(|(variable, _)| variable)
                .collect(),
            ),
        })
    }

    // An http or https URL a request path can follow.
    fn base_url(&self, variable: &'static str) -> Result<Option<Url>, ConfigError> {
        let url: Option<Url> = self.optional(variable)?;
        match url {
            Some(url) if !matches!(url.scheme(), "http" | "https") || url.cannot_be_a_base() => {
                Err(ConfigError {
                    variable,
                    problem: Problem::Malformed,
                })
            }
            url => Ok(url),
        }
    }

    // A socket address, or a host and port whose name resolves at start, as a compose network alias does: the internal
    // listener then binds the one network the backend shares with it, and no other. Of a name's several addresses, as
    // localhost's, it takes the first IPv4, the one clients here dial.
    fn address(&self, variable: &'static str) -> Result<SocketAddr, ConfigError> {
        let value: String = self.required(variable)?;
        let refused = |problem| ConfigError { variable, problem };
        let shaped = value
            .rsplit_once(':')
            .is_some_and(|(host, port)| !host.is_empty() && port.parse::<u16>().is_ok());
        if !shaped {
            return Err(refused(Problem::Malformed));
        }
        value
            .to_socket_addrs()
            .ok()
            .and_then(|resolved| resolved.min_by_key(SocketAddr::is_ipv6))
            .ok_or(refused(Problem::Unresolved))
    }
}

// Names the variable, never its value: a value may be a secret, such as the key in SENTRY_DSN, the password in
// SUBSCRIPTIONS_DATABASE_URL, SUBSCRIPTIONS_INTERNAL_TOKEN or SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY.
#[derive(Debug, PartialEq)]
pub struct ConfigError {
    pub variable: &'static str,
    pub problem: Problem,
}

#[derive(Debug, PartialEq)]
pub enum Problem {
    Missing,
    Malformed,
    Unresolved,
    RefusedInEnvironment,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let variable = self.variable;
        match self.problem {
            Problem::Missing => write!(formatter, "{variable} is not set"),
            Problem::Malformed => write!(formatter, "{variable} is malformed"),
            Problem::Unresolved => {
                write!(formatter, "{variable} names a host that does not resolve")
            }
            Problem::RefusedInEnvironment => write!(
                formatter,
                "{variable} is refused unless SENTRY_ENVIRONMENT is one of {}",
                TEST_DEPLOYMENTS.join(", ")
            ),
        }
    }
}

impl std::error::Error for ConfigError {}
