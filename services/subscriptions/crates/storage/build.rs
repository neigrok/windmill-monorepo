fn main() {
    // `sqlx::migrate!` reads migrations/ at compile time, but the compiler watches only the files it saw:
    // without this line a new migration would not reach the binary until some Rust source changed.
    println!("cargo::rerun-if-changed=../../migrations");

    // The tests that need Postgres run where SUBSCRIPTIONS_TEST_DATABASE_URL names one, and elsewhere are
    // ignored, so the summary counts them as not run rather than as passed.
    println!("cargo::rerun-if-env-changed=SUBSCRIPTIONS_TEST_DATABASE_URL");
    println!("cargo::rustc-check-cfg=cfg(postgres_tests)");
    if std::env::var_os("SUBSCRIPTIONS_TEST_DATABASE_URL").is_some() {
        println!("cargo::rustc-cfg=postgres_tests");
    }
}
