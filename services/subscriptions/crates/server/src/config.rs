use std::fmt;
use std::net::SocketAddr;
use std::str::FromStr;

use sentry::types::Dsn;
use tracing_subscriber::filter::LevelFilter;

// The deployments the forced-panic route may run in, matched trimmed and in any case.
const PANIC_ROUTE_ENVIRONMENTS: [&str; 4] = ["local", "development", "test", "ci"];

#[derive(Debug, PartialEq)]
pub struct Config {
    pub public_address: SocketAddr,
    pub internal_address: SocketAddr,
    pub environment: String,
    pub release: Option<String>,
    pub sentry_dsn: Option<Dsn>,
    pub log_level: LevelFilter,
    pub sentry_log_level: LevelFilter,
    pub panic_route_enabled: bool,
}

impl Config {
    // An empty value counts as unset: compose renders an unset `${NAME:-}` as an empty string.
    pub fn from_environment(read: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let variables = Variables(read);
        let config = Config {
            public_address: variables.required("SUBSCRIPTIONS_PUBLIC_ADDRESS")?,
            internal_address: variables.required("SUBSCRIPTIONS_INTERNAL_ADDRESS")?,
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
        };
        let environment = config.environment.trim().to_ascii_lowercase();
        if config.panic_route_enabled && !PANIC_ROUTE_ENVIRONMENTS.contains(&environment.as_str()) {
            return Err(ConfigError {
                variable: "SUBSCRIPTIONS_PANIC_ROUTE_ENABLED",
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
}

// Names the variable, never its value: a value may be a secret, such as the key in SENTRY_DSN.
#[derive(Debug, PartialEq)]
pub struct ConfigError {
    pub variable: &'static str,
    pub problem: Problem,
}

#[derive(Debug, PartialEq)]
pub enum Problem {
    Missing,
    Malformed,
    RefusedInEnvironment,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let variable = self.variable;
        match self.problem {
            Problem::Missing => write!(formatter, "{variable} is not set"),
            Problem::Malformed => write!(formatter, "{variable} is malformed"),
            Problem::RefusedInEnvironment => write!(
                formatter,
                "{variable} is refused unless SENTRY_ENVIRONMENT is one of {}",
                PANIC_ROUTE_ENVIRONMENTS.join(", ")
            ),
        }
    }
}

impl std::error::Error for ConfigError {}
