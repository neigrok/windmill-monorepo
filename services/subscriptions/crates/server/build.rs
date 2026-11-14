fn main() {
    // The tests that need Postgres run where SUBSCRIPTIONS_TEST_DATABASE_URL names one, and elsewhere are ignored, so
    // the summary counts them as not run rather than as passed.
    println!("cargo::rerun-if-env-changed=SUBSCRIPTIONS_TEST_DATABASE_URL");
    println!("cargo::rustc-check-cfg=cfg(postgres_tests)");
    if std::env::var_os("SUBSCRIPTIONS_TEST_DATABASE_URL").is_some() {
        println!("cargo::rustc-cfg=postgres_tests");
    }
}
