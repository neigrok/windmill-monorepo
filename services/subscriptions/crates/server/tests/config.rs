use server::config::{Config, ConfigError, Problem};
use tracing_subscriber::filter::LevelFilter;

#[test]
fn every_variable_is_read_into_one_config() {
    let environment = [
        ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
        ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
        ("SENTRY_ENVIRONMENT", "ci"),
        ("SENTRY_RELEASE", "2d63d2ac9"),
        ("SENTRY_DSN", "https://public@sentry.example/7"),
        ("WINDMILL_LOG_LEVEL", "debug"),
        ("SENTRY_LOG_LEVEL", "warn"),
        ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", "true"),
    ];

    let config = Config::from_environment(|variable| {
        environment
            .iter()
            .find(|(name, _)| *name == variable)
            .map(|(_, value)| value.to_string())
    });

    assert_eq!(
        config,
        Ok(Config {
            public_address: "0.0.0.0:8082".parse().unwrap(),
            internal_address: "0.0.0.0:8083".parse().unwrap(),
            environment: "ci".to_owned(),
            release: Some("2d63d2ac9".to_owned()),
            sentry_dsn: Some("https://public@sentry.example/7".parse().unwrap()),
            log_level: LevelFilter::DEBUG,
            sentry_log_level: LevelFilter::WARN,
            panic_route_enabled: true,
        })
    );
}

#[test]
fn an_empty_optional_variable_counts_as_unset() {
    let environment = [
        ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "127.0.0.1:8082"),
        ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "127.0.0.1:8083"),
        ("SENTRY_ENVIRONMENT", "production"),
        ("SENTRY_RELEASE", ""),
        ("SENTRY_DSN", ""),
        ("WINDMILL_LOG_LEVEL", ""),
        ("SENTRY_LOG_LEVEL", ""),
        ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", ""),
    ];

    let config = Config::from_environment(|variable| {
        environment
            .iter()
            .find(|(name, _)| *name == variable)
            .map(|(_, value)| value.to_string())
    });

    assert_eq!(
        config,
        Ok(Config {
            public_address: "127.0.0.1:8082".parse().unwrap(),
            internal_address: "127.0.0.1:8083".parse().unwrap(),
            environment: "production".to_owned(),
            release: None,
            sentry_dsn: None,
            log_level: LevelFilter::INFO,
            sentry_log_level: LevelFilter::INFO,
            panic_route_enabled: false,
        })
    );
}

#[test]
fn a_missing_required_variable_is_refused_by_its_name() {
    for missing in [
        "SUBSCRIPTIONS_PUBLIC_ADDRESS",
        "SUBSCRIPTIONS_INTERNAL_ADDRESS",
        "SENTRY_ENVIRONMENT",
    ] {
        let environment = [
            ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
            ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
            ("SENTRY_ENVIRONMENT", "staging"),
        ];

        let refusal = Config::from_environment(|variable| {
            environment
                .iter()
                .find(|(name, _)| *name == variable && *name != missing)
                .map(|(_, value)| value.to_string())
        })
        .unwrap_err();

        assert_eq!(
            refusal,
            ConfigError {
                variable: missing,
                problem: Problem::Missing
            }
        );
        assert_eq!(refusal.to_string(), format!("{missing} is not set"));
    }
}

#[test]
fn a_malformed_value_is_refused_by_its_name_and_never_repeated() {
    for (malformed, value) in [
        ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "public:secret-port"),
        ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "8083"),
        ("SENTRY_DSN", "secret-key-without-a-host"),
        ("WINDMILL_LOG_LEVEL", "off"),
        ("WINDMILL_LOG_LEVEL", "0"),
        ("SENTRY_LOG_LEVEL", "warning"),
        ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", "yes"),
    ] {
        let environment = [
            ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
            ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
            ("SENTRY_ENVIRONMENT", "staging"),
        ];

        let refusal = Config::from_environment(|variable| {
            if variable == malformed {
                return Some(value.to_owned());
            }
            environment
                .iter()
                .find(|(name, _)| *name == variable)
                .map(|(_, value)| value.to_string())
        })
        .unwrap_err();

        assert_eq!(
            refusal,
            ConfigError {
                variable: malformed,
                problem: Problem::Malformed
            }
        );
        assert_eq!(refusal.to_string(), format!("{malformed} is malformed"));
    }
}

#[test]
fn the_backend_s_level_words_are_read_in_any_case() {
    for (word, level) in [
        ("trace", LevelFilter::TRACE),
        ("DEBUG", LevelFilter::DEBUG),
        ("Info", LevelFilter::INFO),
        ("warn", LevelFilter::WARN),
        ("ERROR", LevelFilter::ERROR),
        ("fatal", LevelFilter::ERROR),
    ] {
        let environment = [
            ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
            ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
            ("SENTRY_ENVIRONMENT", "staging"),
            ("WINDMILL_LOG_LEVEL", word),
            ("SENTRY_LOG_LEVEL", word),
        ];

        let config = Config::from_environment(|variable| {
            environment
                .iter()
                .find(|(name, _)| *name == variable)
                .map(|(_, value)| value.to_string())
        })
        .unwrap();

        assert_eq!(
            (config.log_level, config.sentry_log_level),
            (level, level),
            "{word}"
        );
    }
}

#[test]
fn the_panic_route_is_allowed_only_in_test_deployments() {
    for (environment_name, allowed) in [
        ("local", true),
        (" CI ", true),
        ("Test", true),
        ("development", true),
        ("production", false),
        ("Production", false),
        ("production ", false),
        ("staging", false),
    ] {
        let environment = [
            ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
            ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
            ("SENTRY_ENVIRONMENT", environment_name),
            ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", "true"),
        ];

        let config = Config::from_environment(|variable| {
            environment
                .iter()
                .find(|(name, _)| *name == variable)
                .map(|(_, value)| value.to_string())
        });

        match config {
            Ok(config) => assert!(
                allowed && config.panic_route_enabled,
                "{environment_name:?}"
            ),
            Err(refusal) => {
                assert!(!allowed, "{environment_name:?}");
                assert_eq!(
                    refusal.to_string(),
                    "SUBSCRIPTIONS_PANIC_ROUTE_ENABLED is refused unless SENTRY_ENVIRONMENT is \
                     one of \
                     local, development, test, ci"
                );
            }
        }
    }
}
