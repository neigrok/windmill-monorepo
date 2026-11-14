use std::fs;
use std::path::Path;

use server::telemetry::SERVICE_CRATES;

#[test]
fn every_crate_and_binary_of_the_workspace_is_one_of_the_service_s_own() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let mut names: Vec<String> = fs::read_dir(crates)
        .unwrap()
        .map(|entry| entry.unwrap().path().join("Cargo.toml"))
        .filter(|manifest| manifest.exists())
        .flat_map(|manifest| {
            fs::read_to_string(manifest)
                .unwrap()
                .lines()
                .filter_map(|line| line.strip_prefix("name = \""))
                .map(|name| name.trim_end_matches('"').to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    names.sort();

    assert_eq!(names, SERVICE_CRATES);
}
