use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use sqlx::migrate::{MigrateError, Migrator};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgPool, PgPoolOptions};
use sqlx::{Connection, Postgres, Transaction};
use url::Url;
use uuid::Uuid;

// Every schema change, in order, embedded in the binary from services/subscriptions/migrations.
static MIGRATIONS: Migrator = sqlx::migrate!("../../migrations");

// How long a connection may take to open, at start and whenever the pool grows.
const CONNECT_BOUND: Duration = Duration::from_secs(5);
// How long a health check waits for the database: under the image's 3 s HEALTHCHECK timeout.
const CHECK_BOUND: Duration = Duration::from_secs(2);
// How long a write waits for any lock, the seq lock among them, and how long any of its statements may run. A lock is
// normally held for milliseconds, so a longer wait means a holder has stalled: the write gives its connection back
// as `busy` rather than every connection queueing behind the holder, and the sweep retries it. A statement runs for
// milliseconds too; twice the lock bound lets the lock bound answer every wait for a lock, and ends a statement
// stalled for any other reason, so no write holds a connection past it.
const WRITE_BOUNDS: &str =
    "select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)";

// The service's own database, `windmill_subscriptions` in production (spec §9). It holds every fact
// about a paid subscription; a `Ledger` exists only once its schema is this build's.
#[derive(Clone)]
pub struct Ledger {
    pub(crate) pool: PgPool,
    options: PgConnectOptions,
}

impl Ledger {
    // Connections the service holds at most; the host's Postgres also serves the backend.
    pub const CONNECTIONS: u32 = 8;

    // Connects, then brings the schema up to the newest migration, so nothing ever reads an older one.
    // A database migrated by a newer build is refused rather than run against.
    pub async fn open(url: &DatabaseUrl) -> Result<Ledger, StorageError> {
        // A pool that has opened no connection yet times out only because the database opened none.
        let pool = PgPoolOptions::new()
            .max_connections(Ledger::CONNECTIONS)
            .acquire_timeout(CONNECT_BOUND)
            .connect_with(url.options.clone())
            .await
            .map_err(|error| match StorageError::from(error) {
                StorageError::Busy => StorageError::Unreachable,
                other => other,
            })?;
        MIGRATIONS.run(&pool).await?;
        Ok(Ledger {
            pool,
            options: url.options.clone(),
        })
    }

    pub async fn epoch(&self) -> Result<Uuid, StorageError> {
        Ok(sqlx::query_scalar("select epoch from ledger")
            .fetch_one(&self.pool)
            .await?)
    }

    // Whether the database answers now, within CHECK_BOUND, on a connection of the check's own: writers waiting on a
    // lock may hold every connection of the pool, and the database still answers.
    pub async fn check(&self) -> Result<(), StorageError> {
        if self.pool.is_closed() {
            return Err(StorageError::Unreachable);
        }
        let answer = async {
            let mut connection = PgConnection::connect_with(&self.options).await?;
            sqlx::query("select 1").execute(&mut connection).await?;
            connection.close().await
        };
        match tokio::time::timeout(CHECK_BOUND, answer).await {
            Ok(answered) => answered.map_err(StorageError::from),
            Err(_) => Err(StorageError::Unreachable),
        }
    }

    // Every write runs read committed whatever the database's default, so each statement sees what committed before
    // it, which the seq lock relies on (INV-8), within WRITE_BOUNDS.
    pub(crate) async fn begin_write(&self) -> Result<Transaction<'static, Postgres>, StorageError> {
        let mut transaction = self
            .pool
            .begin_with("begin isolation level read committed")
            .await?;
        sqlx::query(WRITE_BOUNDS).execute(&mut *transaction).await?;
        Ok(transaction)
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
    // No connection within its bound, because every connection is in use or the database opened no new one, or
    // a lock not granted within its bound. The health check, on a connection of its own, tells the two apart.
    Busy,
    // A commit was sent and its answer never came: the transaction may have committed or not.
    OutcomeUnknown,
    // A row this build cannot read: a name outside its closed set, or a fact its state requires missing.
    Unreadable,
    // Anything else the database answered.
    Database { sqlstate: Option<String> },
}

// Commits a write. A commit whose answer never comes back may have committed: only a rollback the database answered
// with, an integrity violation or a serialization failure found at commit, says it did not.
pub(crate) async fn commit(
    transaction: Transaction<'static, Postgres>,
) -> Result<(), StorageError> {
    transaction
        .commit()
        .await
        .map_err(|error| match StorageError::from(error) {
            StorageError::Database {
                sqlstate: Some(sqlstate),
            } if sqlstate.starts_with("23") || sqlstate.starts_with("40") => {
                StorageError::Database {
                    sqlstate: Some(sqlstate),
                }
            }
            _ => StorageError::OutcomeUnknown,
        })
}

impl StorageError {
    // Whether trying again fails the same way: a value the database refuses (SQLSTATE classes 22, 23 and 42) or a
    // row this build cannot read. A connection, a lock or the server's state can change by the next try.
    pub(crate) fn repeats(&self) -> bool {
        match self {
            StorageError::Unreadable => true,
            StorageError::Database {
                sqlstate: Some(sqlstate),
            } => ["22", "23", "42"]
                .iter()
                .any(|class| sqlstate.starts_with(class)),
            _ => false,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            StorageError::Unreachable => "unreachable",
            StorageError::Refused { .. } => "refused",
            StorageError::Migration { .. } => "migration",
            StorageError::Busy => "busy",
            StorageError::OutcomeUnknown => "outcome_unknown",
            StorageError::Unreadable => "unreadable",
            StorageError::Database { .. } => "database",
        }
    }

    pub fn sqlstate(&self) -> Option<&str> {
        match self {
            StorageError::Unreachable
            | StorageError::Busy
            | StorageError::OutcomeUnknown
            | StorageError::Unreadable => None,
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
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::PoolClosed => {
                StorageError::Unreachable
            }
            sqlx::Error::PoolTimedOut => StorageError::Busy,
            sqlx::Error::Migrate(error) => StorageError::from(*error),
            sqlx::Error::ColumnDecode { .. } | sqlx::Error::Decode(_) => StorageError::Unreadable,
            sqlx::Error::Database(error) => match error.code() {
                // Class 28 is invalid authorization; 3D000 names a database that does not exist.
                Some(sqlstate) if sqlstate.starts_with("28") || sqlstate == "3D000" => {
                    StorageError::Refused {
                        sqlstate: sqlstate.into_owned(),
                    }
                }
                // lock_not_available: a lock was not granted within WRITE_BOUNDS.
                Some(sqlstate) if sqlstate == "55P03" => StorageError::Busy,
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
