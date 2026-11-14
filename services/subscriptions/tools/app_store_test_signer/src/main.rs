use std::env;
use std::io;
use std::process::ExitCode;
use std::time::SystemTime;

use app_store_test_signer::{Description, sign};

const USAGE: &str = "usage: app_store_test_signer < description.json > signed.jws
Signs the App Store notification or transaction described on stdin under the test chain, which only
non-production configurations trust. Descriptions: tests/fixtures/app_store/test-payloads/";

fn main() -> ExitCode {
    if env::args_os().len() > 1 {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let description: Description = match serde_json::from_reader(io::stdin().lock()) {
        Ok(description) => description,
        Err(error) => {
            eprintln!("app_store_test_signer: stdin holds no description: {error}");
            return ExitCode::FAILURE;
        }
    };
    match sign(description, SystemTime::now()) {
        Ok(signed) => {
            println!("{signed}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("app_store_test_signer: {error}");
            ExitCode::FAILURE
        }
    }
}
