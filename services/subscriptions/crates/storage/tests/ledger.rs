use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};

use futures_util::FutureExt;
use sqlx::{AssertSqlSafe, Connection, Executor, PgConnection};
use storage::{DatabaseUrl, Ledger, MalformedDatabaseUrl, StorageError};
use url::Url;
use uuid::Uuid;

// An empty database of its own beside the one SUBSCRIPTIONS_TEST_DATABASE_URL names in its path, dropped
// after the test whether or not it passed. The role there must be allowed to create databases.
async fn with_empty_database(test: impl AsyncFnOnce(String)) {
    let maintenance = env::var("SUBSCRIPTIONS_TEST_DATABASE_URL").expect(
        "SUBSCRIPTIONS_TEST_DATABASE_URL names the database to create test databases beside",
    );
    let name = format!("subscriptions_test_{}", Uuid::new_v4().simple());
    let mut admin = PgConnection::connect(&maintenance).await.unwrap();
    admin
        .execute(AssertSqlSafe(format!("create database {name}")))
        .await
        .unwrap();
    let mut url = Url::parse(&maintenance).unwrap();
    url.set_path(&name);

    let outcome = AssertUnwindSafe(test(url.into())).catch_unwind().await;

    admin
        .execute(AssertSqlSafe(format!("drop database {name} with (force)")))
        .await
        .unwrap();
    if let Err(panic) = outcome {
        resume_unwind(panic);
    }
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn an_empty_database_is_migrated_and_given_one_epoch_that_opening_again_keeps() {
    with_empty_database(async |url| {
        let first = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let epoch = first.epoch().await.unwrap();
        first.close().await;

        let again = Ledger::open(&url.parse().unwrap()).await.unwrap();

        assert_eq!(again.epoch().await.unwrap(), epoch);
        assert_eq!(epoch.get_version_num(), 4);
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let migrations: Vec<(i64, String, bool)> = sqlx::query_as(
            "select version, description, success from _sqlx_migrations order by version",
        )
        .fetch_all(&mut connection)
        .await
        .unwrap();
        assert_eq!(migrations, [(1, "ledger".to_owned(), true)]);
        let second_row = connection
            .execute("insert into ledger (epoch) values (gen_random_uuid())")
            .await
            .unwrap_err();
        let not_the_one_row = connection
            .execute("insert into ledger (one_row, epoch) values (false, gen_random_uuid())")
            .await
            .unwrap_err();
        assert_eq!(
            [
                StorageError::from(second_row),
                StorageError::from(not_the_one_row)
            ],
            [
                StorageError::Database {
                    sqlstate: Some("23505".to_owned())
                },
                StorageError::Database {
                    sqlstate: Some("23514".to_owned())
                },
            ]
        );
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_database_whose_migrations_are_not_this_build_s_is_refused() {
    with_empty_database(async |url| {
        Ledger::open(&url.parse().unwrap())
            .await
            .unwrap()
            .close()
            .await;
        let mut connection = PgConnection::connect(&url).await.unwrap();
        connection
            .execute(
                "insert into _sqlx_migrations (version, description, success, checksum, \
                 execution_time) values (2, 'from a newer build', true, '\\x00', 0)",
            )
            .await
            .unwrap();
        let newer = Ledger::open(&url.parse().unwrap()).await.err().unwrap();
        connection
            .execute(
                "delete from _sqlx_migrations where version = 2; \
                 update _sqlx_migrations set checksum = '\\x00' where version = 1",
            )
            .await
            .unwrap();

        let edited = Ledger::open(&url.parse().unwrap()).await.err().unwrap();

        assert_eq!(
            [newer, edited],
            [
                StorageError::Migration { sqlstate: None },
                StorageError::Migration { sqlstate: None }
            ]
        );
    })
    .await;
}

#[tokio::test]
#[cfg_attr(not(postgres_tests), ignore = "needs SUBSCRIPTIONS_TEST_DATABASE_URL")]
async fn a_ledger_answers_its_check_until_it_is_closed() {
    with_empty_database(async |url| {
        let ledger = Ledger::open(&url.parse().unwrap()).await.unwrap();
        let open = ledger.check().await;
        ledger.close().await;

        assert_eq!(
            [open, ledger.check().await],
            [Ok(()), Err(StorageError::Unreachable)]
        );
    })
    .await;
}

#[test]
fn a_database_url_is_postgres_and_carries_no_parameter_that_could_be_logged() {
    for accepted in [
        "postgresql://windmill_subscriptions:secret-password@db:5432/windmill_subscriptions",
        "postgres://ledger@localhost/ledger?sslmode=require&port=5433",
        "postgresql:///windmill_subscriptions?host=/tmp&user=windmill_subscriptions",
        "postgresql:///?host=/tmp&dbname=windmill_subscriptions",
    ] {
        assert!(accepted.parse::<DatabaseUrl>().is_ok(), "{accepted}");
    }
    for refused in [
        "",
        "db:5432/windmill_subscriptions",
        "mysql://ledger:secret-password@db/ledger",
        "postgresql://ledger@db/ledger?passwrod=secret-password",
        "postgresql://ledger@db/ledger?sslmode=sometimes",
    ] {
        assert_eq!(
            refused.parse::<DatabaseUrl>(),
            Err(MalformedDatabaseUrl),
            "{refused}"
        );
    }
}

#[test]
fn a_database_url_never_prints_its_password() {
    let url: DatabaseUrl = "postgresql://ledger:secret-password@db/ledger"
        .parse()
        .unwrap();

    assert_eq!(format!("{url:?}"), "DatabaseUrl(..)");
}
