use app_store::server_api::ApiKey;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use server::config::{AppStoreApiConfig, AppStoreApiKey, Config, ConfigError, Problem};
use storage::DatabaseUrl;
use tracing_subscriber::filter::LevelFilter;

// An in-app purchase key as App Store Connect's .p8 file holds it: a P-256 key in PKCS#8 PEM.
fn p8() -> String {
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
            .unwrap();
    format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        STANDARD.encode(pkcs8.as_ref())
    )
}

#[test]
fn every_variable_is_read_into_one_config() {
    let private_key = p8();
    let environment = [
        ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
        ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
        (
            "SUBSCRIPTIONS_DATABASE_URL",
            "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
        ),
        ("SENTRY_ENVIRONMENT", "ci"),
        ("SENTRY_RELEASE", "2d63d2ac9"),
        ("SENTRY_DSN", "https://public@sentry.example/7"),
        ("WINDMILL_LOG_LEVEL", "debug"),
        ("SENTRY_LOG_LEVEL", "warn"),
        ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", "true"),
        (
            "SUBSCRIPTIONS_APP_STORE_TEST_ROOT",
            "tests/fixtures/app_store/test-chain/root.cer",
        ),
        (
            "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID",
            "57246542-96fe-1a63-e053-0824d011072a",
        ),
        ("SUBSCRIPTIONS_APP_STORE_API_KEY_ID", "2X9R4HXF34"),
        ("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY", &private_key),
        (
            "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
            "http://127.0.0.1:18662",
        ),
        (
            "SUBSCRIPTIONS_INTERNAL_TOKEN",
            "7c1f0e9a4b2d8c6e5f3a1b0c9d8e7f6a",
        ),
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
            database_url:
                "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions"
                    .parse::<DatabaseUrl>()
                    .unwrap(),
            environment: "ci".to_owned(),
            release: Some("2d63d2ac9".to_owned()),
            sentry_dsn: Some("https://public@sentry.example/7".parse().unwrap()),
            log_level: LevelFilter::DEBUG,
            sentry_log_level: LevelFilter::WARN,
            panic_route_enabled: true,
            app_store_test_root: Some("tests/fixtures/app_store/test-chain/root.cer".into()),
            app_store_api: AppStoreApiKey::Set(ApiKey {
                issuer_id: "57246542-96fe-1a63-e053-0824d011072a".to_owned(),
                key_id: "2X9R4HXF34".to_owned(),
                private_key: private_key.parse().unwrap(),
            }),
            app_store_api_test_url: Some("http://127.0.0.1:18662".parse().unwrap()),
            internal_token: Some("7c1f0e9a4b2d8c6e5f3a1b0c9d8e7f6a".parse().unwrap()),
        })
    );
}

#[test]
fn an_empty_optional_variable_counts_as_unset() {
    let environment = [
        ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "127.0.0.1:8082"),
        ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "127.0.0.1:8083"),
        (
            "SUBSCRIPTIONS_DATABASE_URL",
            "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
        ),
        ("SENTRY_ENVIRONMENT", "production"),
        ("SENTRY_RELEASE", ""),
        ("SENTRY_DSN", ""),
        ("WINDMILL_LOG_LEVEL", ""),
        ("SENTRY_LOG_LEVEL", ""),
        ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", ""),
        ("SUBSCRIPTIONS_APP_STORE_TEST_ROOT", ""),
        ("SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID", ""),
        ("SUBSCRIPTIONS_APP_STORE_API_KEY_ID", ""),
        ("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY", ""),
        ("SUBSCRIPTIONS_APP_STORE_API_TEST_URL", ""),
        ("SUBSCRIPTIONS_INTERNAL_TOKEN", ""),
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
            database_url:
                "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions"
                    .parse::<DatabaseUrl>()
                    .unwrap(),
            environment: "production".to_owned(),
            release: None,
            sentry_dsn: None,
            log_level: LevelFilter::INFO,
            sentry_log_level: LevelFilter::INFO,
            panic_route_enabled: false,
            app_store_test_root: None,
            app_store_api: AppStoreApiKey::Unset,
            app_store_api_test_url: None,
            internal_token: None,
        })
    );
}

#[test]
fn the_configuration_never_prints_the_database_password_the_internal_token_or_the_private_key() {
    let private_key = p8();
    let config = Config::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("0.0.0.0:8082".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("0.0.0.0:8083".to_owned()),
        "SUBSCRIPTIONS_DATABASE_URL" => Some(
            "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions"
                .to_owned(),
        ),
        "SENTRY_ENVIRONMENT" => Some("production".to_owned()),
        "SUBSCRIPTIONS_INTERNAL_TOKEN" => {
            Some("secret-token-0123456789abcdef0123456789".to_owned())
        }
        "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID" => Some("issuer".to_owned()),
        "SUBSCRIPTIONS_APP_STORE_API_KEY_ID" => Some("key".to_owned()),
        "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY" => Some(private_key.clone()),
        _ => None,
    })
    .unwrap();

    let printed = format!("{config:?}");
    let key_body = private_key.lines().nth(1).unwrap();
    assert!(config.app_store_api.key().is_some());
    assert!(!printed.contains("secret-password"), "{printed}");
    assert!(!printed.contains("secret-token"), "{printed}");
    assert!(!printed.contains(&key_body[..16]), "{printed}");
}

#[test]
fn a_key_set_in_part_turns_the_api_off_naming_what_it_lacks() {
    let private_key = p8();
    let cases = [
        (
            vec![("SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID", "issuer")],
            vec![
                "SUBSCRIPTIONS_APP_STORE_API_KEY_ID",
                "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY",
            ],
        ),
        (
            vec![
                ("SUBSCRIPTIONS_APP_STORE_API_KEY_ID", "key"),
                ("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY", &private_key),
            ],
            vec!["SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID"],
        ),
    ];
    for (set, lacking) in cases {
        let config = Config::from_environment(|variable| match variable {
            "SUBSCRIPTIONS_PUBLIC_ADDRESS" => Some("0.0.0.0:8082".to_owned()),
            "SUBSCRIPTIONS_INTERNAL_ADDRESS" => Some("0.0.0.0:8083".to_owned()),
            "SUBSCRIPTIONS_DATABASE_URL" => Some("postgresql://ledger@db/ledger".to_owned()),
            "SENTRY_ENVIRONMENT" => Some("production".to_owned()),
            _ => set
                .iter()
                .find(|(name, _)| *name == variable)
                .map(|(_, value)| value.to_string()),
        })
        .unwrap();

        assert_eq!(config.app_store_api, AppStoreApiKey::Lacking(lacking));
    }
}

#[test]
fn a_missing_required_variable_is_refused_by_its_name() {
    for missing in [
        "SUBSCRIPTIONS_PUBLIC_ADDRESS",
        "SUBSCRIPTIONS_INTERNAL_ADDRESS",
        "SUBSCRIPTIONS_DATABASE_URL",
        "SENTRY_ENVIRONMENT",
    ] {
        let environment = [
            ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
            ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
            (
                "SUBSCRIPTIONS_DATABASE_URL",
                "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
            ),
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
        (
            "SUBSCRIPTIONS_DATABASE_URL",
            "mysql://ledger:secret-password@db/ledger",
        ),
        (
            "SUBSCRIPTIONS_DATABASE_URL",
            "postgresql://ledger@db/ledger?passwrod=secret-password",
        ),
        ("SENTRY_DSN", "secret-key-without-a-host"),
        ("WINDMILL_LOG_LEVEL", "off"),
        ("WINDMILL_LOG_LEVEL", "0"),
        ("SENTRY_LOG_LEVEL", "warning"),
        ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", "yes"),
        (
            "SUBSCRIPTIONS_INTERNAL_TOKEN",
            "secret-of-31-characters-0123456",
        ),
        (
            "SUBSCRIPTIONS_INTERNAL_TOKEN",
            "secret with a space, which no header carries as it is",
        ),
        (
            "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY",
            "-----BEGIN PRIVATE KEY-----\nc2VjcmV0LWtleQ==\n-----END PRIVATE KEY-----",
        ),
        ("SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY", "secret-key"),
        ("SUBSCRIPTIONS_APP_STORE_API_TEST_URL", "ftp://secret-host/"),
        (
            "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
            "mailto:secret@example.com",
        ),
        ("SUBSCRIPTIONS_APP_STORE_API_TEST_URL", "secret host"),
    ] {
        let environment = [
            ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
            ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "0.0.0.0:8083"),
            (
                "SUBSCRIPTIONS_DATABASE_URL",
                "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
            ),
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
            (
                "SUBSCRIPTIONS_DATABASE_URL",
                "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
            ),
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
fn what_only_tests_need_is_allowed_only_in_test_deployments() {
    for (variable, value) in [
        ("SUBSCRIPTIONS_PANIC_ROUTE_ENABLED", "true"),
        (
            "SUBSCRIPTIONS_APP_STORE_TEST_ROOT",
            "tests/fixtures/app_store/test-chain/root.cer",
        ),
        (
            "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
            "http://127.0.0.1:18662",
        ),
    ] {
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
                (
                    "SUBSCRIPTIONS_DATABASE_URL",
                    "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
                ),
                ("SENTRY_ENVIRONMENT", environment_name),
                (variable, value),
            ];

            let config = Config::from_environment(|name| {
                environment
                    .iter()
                    .find(|(known, _)| *known == name)
                    .map(|(_, value)| value.to_string())
            });

            match config {
                Ok(config) => assert!(
                    allowed
                        && (config.panic_route_enabled
                            || config.app_store_test_root.is_some()
                            || config.app_store_api_test_url.is_some()),
                    "{variable} in {environment_name:?}"
                ),
                Err(refusal) => {
                    assert!(!allowed, "{variable} in {environment_name:?}");
                    assert_eq!(
                        refusal,
                        ConfigError {
                            variable,
                            problem: Problem::RefusedInEnvironment
                        }
                    );
                    assert_eq!(
                        refusal.to_string(),
                        format!(
                            "{variable} is refused unless SENTRY_ENVIRONMENT is one of local, development, test, ci"
                        )
                    );
                }
            }
        }
    }
}

#[test]
fn an_address_may_name_a_host_and_binds_its_first_ipv4_address() {
    let environment = [
        ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
        ("SUBSCRIPTIONS_INTERNAL_ADDRESS", "localhost:8083"),
        (
            "SUBSCRIPTIONS_DATABASE_URL",
            "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
        ),
        ("SENTRY_ENVIRONMENT", "staging"),
    ];

    let config = Config::from_environment(|variable| {
        environment
            .iter()
            .find(|(name, _)| *name == variable)
            .map(|(_, value)| value.to_string())
    })
    .unwrap();

    assert_eq!(config.internal_address, "127.0.0.1:8083".parse().unwrap());
}

#[test]
fn an_address_naming_a_host_that_does_not_resolve_is_refused_by_its_name() {
    let environment = [
        ("SUBSCRIPTIONS_PUBLIC_ADDRESS", "0.0.0.0:8082"),
        (
            "SUBSCRIPTIONS_INTERNAL_ADDRESS",
            "subscriptions-internal.invalid:8083",
        ),
        (
            "SUBSCRIPTIONS_DATABASE_URL",
            "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
        ),
        ("SENTRY_ENVIRONMENT", "staging"),
    ];

    let refusal = Config::from_environment(|variable| {
        environment
            .iter()
            .find(|(name, _)| *name == variable)
            .map(|(_, value)| value.to_string())
    })
    .unwrap_err();

    assert_eq!(
        refusal,
        ConfigError {
            variable: "SUBSCRIPTIONS_INTERNAL_ADDRESS",
            problem: Problem::Unresolved
        }
    );
    assert_eq!(
        refusal.to_string(),
        "SUBSCRIPTIONS_INTERNAL_ADDRESS names a host that does not resolve"
    );
}

#[test]
fn app_store_api_config_loads_without_database_or_listener_variables() {
    let private_key = p8();
    let config = AppStoreApiConfig::from_environment(|variable| match variable {
        "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID" => {
            Some("57246542-96fe-1a63-e053-0824d011072a".to_owned())
        }
        "SUBSCRIPTIONS_APP_STORE_API_KEY_ID" => Some("2X9R4HXF34".to_owned()),
        "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY" => Some(private_key.clone()),
        _ => None,
    })
    .unwrap();

    assert_eq!(
        config,
        AppStoreApiConfig {
            key: ApiKey {
                issuer_id: "57246542-96fe-1a63-e053-0824d011072a".to_owned(),
                key_id: "2X9R4HXF34".to_owned(),
                private_key: private_key.parse().unwrap(),
            },
            test_url: None,
        }
    );
}

#[test]
fn app_store_api_config_requires_every_key_variable_and_guards_test_url() {
    let private_key = p8();
    for missing in [
        "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID",
        "SUBSCRIPTIONS_APP_STORE_API_KEY_ID",
        "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY",
    ] {
        let refusal = AppStoreApiConfig::from_environment(|variable| {
            if variable == missing {
                return None;
            }
            match variable {
                "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID" => Some("issuer".to_owned()),
                "SUBSCRIPTIONS_APP_STORE_API_KEY_ID" => Some("key".to_owned()),
                "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY" => Some(private_key.clone()),
                _ => None,
            }
        })
        .unwrap_err();
        assert_eq!(
            refusal,
            ConfigError {
                variable: missing,
                problem: Problem::Missing,
            }
        );
    }

    for (env_name, allowed) in [
        (Some("test"), true),
        (Some("production"), false),
        (None, false),
    ] {
        let result = AppStoreApiConfig::from_environment(|variable| match variable {
            "SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID" => Some("issuer".to_owned()),
            "SUBSCRIPTIONS_APP_STORE_API_KEY_ID" => Some("key".to_owned()),
            "SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY" => Some(private_key.clone()),
            "SUBSCRIPTIONS_APP_STORE_API_TEST_URL" => Some("http://127.0.0.1:18662".to_owned()),
            "SENTRY_ENVIRONMENT" => env_name.map(str::to_owned),
            _ => None,
        });
        if allowed {
            assert_eq!(
                result.unwrap().test_url,
                Some("http://127.0.0.1:18662".parse().unwrap())
            );
        } else {
            assert_eq!(
                result.unwrap_err(),
                ConfigError {
                    variable: "SUBSCRIPTIONS_APP_STORE_API_TEST_URL",
                    problem: Problem::RefusedInEnvironment,
                }
            );
        }
    }
}
