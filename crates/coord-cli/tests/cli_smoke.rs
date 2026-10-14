use serde_json::Value;
use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn fresh_cli_reports_real_empty_state_in_json() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "claudacoda-cli-test-{}-{stamp}",
        std::process::id()
    ));
    let output = Command::new(env!("CARGO_BIN_EXE_claudacoda-cli"))
        .args(["--json", "--state-dir"])
        .arg(&root)
        .arg("status")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert!(value["data"]["requests"].as_array().unwrap().is_empty());
    assert!(value["data"]["endpoints"].as_array().unwrap().is_empty());
    // Only this test's unique directory was created and is removed.
    fs::remove_dir_all(root).unwrap();
}
