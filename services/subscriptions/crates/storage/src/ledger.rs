use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use sqlx::migrate::{MigrateError, Migrator};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use url::Url;
use uuid::Uuid;

// Every schema change, in order, embedded in the binary from services/subscriptions/migrations.
static MIGRATIONS: Migrator = sqlx::migrate!("../../migrations");

// Connections the service holds at most; the host's Postgres also serves the backend.
const MAX_CONNECTIONS: u32 = 8;
// How long a connection may take to open, at start and whenever the pool grows.
const CONNECT_BOUND: Duration = Duration::from_secs(5);
// How long a health check waits for the database: under the image's 3 s HEALTHCHECK timeout.
const CHECK_BOUND: Duration = Duration::from_secs(2);

// The service's own database, `windmill_subscriptions` in production (spec §9). It holds every fact
// about a paid subscription; a `Ledger` exists only once its schema is this build's.
#[derive(Clone)]
pub struct Ledger {
    pool: PgPool,
}

impl Ledger {
    // Connects, then brings the schema up to the newest migration, so nothing ever reads an older one.
    // A database migrated by a newer build is refused rather than run against.
    pub async fn open(url: &DatabaseUrl) -> Result<Ledger, StorageError> {
        let pool = PgPoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .acquire_timeout(CONNECT_BOUND)
            .connect_with(url.options.clone())
            .await?;
        MIGRATIONS.run(&pool).await?;
        Ok(Ledger { pool })
    }

    pub async fn epoch(&self) -> Result<Uuid, StorageError> {
        Ok(sqlx::query_scalar("select epoch from ledger")
            .fetch_one(&self.pool)
            .await?)
    }

    // Whether the database answers now, within CHECK_BOUND.
    pub async fn check(&self) -> Result<(), StorageError> {
        match tokio::time::timeout(CHECK_BOUND, sqlx::query("select 1").execute(&self.pool)).await {
            Ok(answered) => answered.map(drop).map_err(StorageError::from),
            Err(_) => Err(StorageError::Unreachable),
        }
    }

    // Waits for every borrowed connection to come back, then closes them all.
    pub async fn close(&self) {
        self.pool.close().await;
    }
}

// The query parameters a URL may carry. sqlx writes any other parameter to its log with its value,
// and the URL holds the role's password.
const URL_PARAMETERS: [&str; 5] = ["host", "port", "user", "dbname", "sslmode"];

// Where the ledger lives: a postgres:// or postgresql:// URL, such as
// `postgresql://windmill_subscriptions:<password>@db:5432/windmill_subscriptions`, or one naming a unix
// socket directory in `host`. It carries a password, so neither Debug nor any error repeats it.
#[derive(Clone)]
pub struct DatabaseUrl {
    text: String,
    options: PgConnectOptions,
}

impl FromStr for DatabaseUrl {
    type Err = MalformedDatabaseUrl;

    fn from_str(text: &str) -> Result<DatabaseUrl, MalformedDatabaseUrl> {
        let url = Url::parse(text).map_err(|_| MalformedDatabaseUrl)?;
        if !matches!(url.scheme(), "postgres" | "postgresql")
            || url
                .query_pairs()
                .any(|(parameter, _)| !URL_PARAMETERS.contains(&&*parameter))
        {
            return Err(MalformedDatabaseUrl);
        }
        Ok(DatabaseUrl {
            text: text.to_owned(),
            options: text.parse().map_err(|_| MalformedDatabaseUrl)?,
        })
    }
}

impl PartialEq for DatabaseUrl {
    fn eq(&self, other: &DatabaseUrl) -> bool {
        self.text == other.text
    }
}

impl fmt::Debug for DatabaseUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DatabaseUrl(..)")
    }
}

#[derive(Debug, PartialEq)]
pub struct MalformedDatabaseUrl;

// How a database operation failed, as a bounded code and the server's SQLSTATE: what a log line or a
// Sentry tag may carry. The server's message is never kept, because it can quote a statement or a value.
#[derive(Debug, PartialEq)]
pub enum StorageError {
    // No connection within the bound: nothing listens, the network refused or TLS failed.
    Unreachable,
    // The server answered and would not let the role in: a pg_hba.conf rule, a wrong password, a
    // database that does not exist.
    Refused { sqlstate: String },
    // The schema could not be brought up to this build's newest migration, or the database holds a
    // migration this build does not have.
    Migration { sqlstate: Option<String> },
    // Anything else the database answered.
    Database { sqlstate: Option<String> },
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            StorageError::Unreachable => "unreachable",
            StorageError::Refused { .. } => "refused",
            StorageError::Migration { .. } => "migration",
            StorageError::Database { .. } => "database",
        }
    }

    pub fn sqlstate(&self) -> Option<&str> {
        match self {
            StorageError::Unreachable => None,
            StorageError::Refused { sqlstate } => Some(sqlstate),
            StorageError::Migration { sqlstate } | StorageError::Database { sqlstate } => {
                sqlstate.as_deref()
            }
        }
    }
}

impl From<sqlx::Error> for StorageError {
    fn from(error: sqlx::Error) -> StorageError {
        match error {
            sqlx::Error::Io(_)
            | sqlx::Error::Tls(_)
            | sqlx::Error::PoolTimedOut
            | sqlx::Error::PoolClosed => StorageError::Unreachable,
            sqlx::Error::Migrate(error) => StorageError::from(*error),
            sqlx::Error::Database(error) => match error.code() {
                // Class 28 is invalid authorization; 3D000 names a database that does not exist.
                Some(sqlstate) if sqlstate.starts_with("28") || sqlstate == "3D000" => {
                    StorageError::Refused {
                        sqlstate: sqlstate.into_owned(),
                    }
                }
                sqlstate => StorageError::Database {
                    sqlstate: sqlstate.map(|sqlstate| sqlstate.into_owned()),
                },
            },
            _ => StorageError::Database { sqlstate: None },
        }
    }
}

impl From<MigrateError> for StorageError {
    fn from(error: MigrateError) -> StorageError {
        let sqlstate = match error {
            MigrateError::Execute(error) | MigrateError::ExecuteMigration(error, _) => {
                StorageError::from(error).sqlstate().map(str::to_owned)
            }
            _ => None,
        };
        StorageError::Migration { sqlstate }
    }
}
