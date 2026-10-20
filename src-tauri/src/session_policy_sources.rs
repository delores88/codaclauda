//! Presence-only guard for Claude policy sources that override session settings.
//! No policy or credential contents are read, and no policy source is changed.
//! Sources: https://code.claude.com/docs/en/managed-settings and
//! https://code.claude.com/docs/en/server-managed-settings.

use std::{fs, io, path::Path};

const SYSTEM_FILES: [&str; 3] = [
    "managed-settings.json",
    "managed-settings.d",
    "managed-mcp.json",
];
const REMOTE_CACHE: &str = "remote-settings.json";

fn unsupported(source: &str, present: bool) -> String {
    let reason = if present {
        "is present"
    } else {
        "could not be checked for absence"
    };
    format!(
        "Unsupported managed Claude configuration: {source} {reason}. \
         CodaClauda sessions cannot safely isolate managed configuration. \
         No policy has been changed or bypassed."
    )
}

fn require_absent(source: &str, presence: io::Result<bool>) -> Result<(), String> {
    match presence {
        Ok(false) => Ok(()),
        Ok(true) => Err(unsupported(source, true)),
        Err(_) => Err(unsupported(source, false)),
    }
}

fn path_presence(path: &Path) -> io::Result<bool> {
    // A symlink, including a dangling one, still counts as a configured source.
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn require_file_sources_absent(system_dir: &Path) -> Result<(), String> {
    for name in SYSTEM_FILES {
        require_absent(name, path_presence(&system_dir.join(name)))?;
    }
    Ok(())
}

fn require_remote_cache_absent(config_dir: &Path) -> Result<(), String> {
    if !config_dir.is_absolute() {
        return Err(
            "Claude authentication did not report an absolute configuration directory; \
             managed configuration could not be checked. No session was started."
                .to_owned(),
        );
    }
    require_absent(REMOTE_CACHE, path_presence(&config_dir.join(REMOTE_CACHE)))
}

/// Call before the authentication probe, which itself may load local managed settings.
pub(crate) fn ensure_claude_system_unmanaged() -> Result<(), String> {
    #[cfg(windows)]
    {
        // Use the documented path, not a caller-controlled ProgramFiles variable.
        require_file_sources_absent(Path::new(r"C:\Program Files\ClaudeCode"))?;
        require_registry_sources_absent()
    }
    #[cfg(not(windows))]
    {
        Err(
            "Claude managed-policy detection is supported only on Windows in this build."
                .to_owned(),
        )
    }
}

/// The caller supplies configDirectory from the clean `claude auth status --json` response.
/// Check again after that probe and before spawning the model process.
pub(crate) fn ensure_claude_unmanaged(config_dir: &Path) -> Result<(), String> {
    ensure_claude_system_unmanaged()?;
    require_remote_cache_absent(config_dir)
}

#[cfg(windows)]
fn registry_presence(
    hive: windows::Win32::System::Registry::HKEY,
    view: windows::Win32::System::Registry::REG_SAM_FLAGS,
) -> io::Result<bool> {
    use windows::{
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
            System::Registry::{
                HKEY, KEY_QUERY_VALUE, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
            },
        },
        core::w,
    };
    let mut key = HKEY::default();
    // Query-only access: this never creates or updates a key or value.
    let opened = unsafe {
        RegOpenKeyExW(
            hive,
            w!(r"SOFTWARE\Policies\ClaudeCode"),
            None,
            KEY_QUERY_VALUE | view,
            &mut key,
        )
    };
    if opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND {
        return Ok(false);
    }
    if opened != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(opened.0 as i32));
    }
    let mut bytes = 0;
    // A null data buffer asks only whether Settings exists and its size.
    // No value bytes, JSON, expanded strings, or credentials enter this process.
    let queried =
        unsafe { RegQueryValueExW(key, w!("Settings"), None, None, None, Some(&mut bytes)) };
    unsafe {
        let _ = RegCloseKey(key);
    }
    registry_query_presence(queried.0)
}

#[cfg(any(windows, test))]
fn registry_query_presence(status: u32) -> io::Result<bool> {
    // Win32 ERROR_SUCCESS / ERROR_MORE_DATA prove presence. Only
    // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND prove absence.
    match status {
        0 | 234 => Ok(true),
        2 | 3 => Ok(false),
        other => Err(io::Error::from_raw_os_error(other as i32)),
    }
}

#[cfg(windows)]
fn require_registry_sources_absent() -> Result<(), String> {
    use windows::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    for (hive, label) in [
        (
            HKEY_LOCAL_MACHINE,
            r"HKLM\SOFTWARE\Policies\ClaudeCode\Settings",
        ),
        (
            HKEY_CURRENT_USER,
            r"HKCU\SOFTWARE\Policies\ClaudeCode\Settings",
        ),
    ] {
        // Check both views so a different-width provider cannot introduce an
        // unmanaged-by-CodaClauda policy after this guard passes.
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            require_absent(label, registry_presence(hive, view))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap()
    }

    #[test]
    fn missing_policy_sources_are_allowed() {
        let temp = fixture();
        assert!(require_file_sources_absent(temp.path()).is_ok());
        assert!(require_remote_cache_absent(temp.path()).is_ok());
    }

    #[test]
    fn every_system_source_is_rejected_without_parsing_its_contents() {
        for name in SYSTEM_FILES {
            let temp = fixture();
            let path = temp.path().join(name);
            if name == "managed-settings.d" {
                fs::create_dir(&path).unwrap();
            } else {
                fs::write(&path, b"not JSON; must not be parsed").unwrap();
            }
            let error = require_file_sources_absent(temp.path()).unwrap_err();
            assert!(error.contains(name));
            assert!(error.contains("is present"));
            assert!(!error.contains("not JSON"));
        }
    }

    #[test]
    fn remote_cache_uses_the_reported_configuration_directory() {
        let temp = fixture();
        let actual = temp.path().join("actual-config");
        fs::create_dir(&actual).unwrap();
        fs::write(actual.join(REMOTE_CACHE), b"").unwrap();
        assert!(require_remote_cache_absent(temp.path()).is_ok());
        assert!(
            require_remote_cache_absent(&actual)
                .unwrap_err()
                .contains(REMOTE_CACHE)
        );
        assert!(require_remote_cache_absent(Path::new("relative-config")).is_err());
    }

    #[test]
    fn unreadable_or_uncertain_sources_fail_closed_without_error_contents() {
        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::Other] {
            let error = require_absent(
                "managed-settings.json",
                Err(io::Error::new(kind, "private policy details")),
            )
            .unwrap_err();
            assert!(error.contains("could not be checked for absence"));
            assert!(!error.contains("private policy details"));
        }
    }

    #[test]
    fn registry_missing_is_distinct_from_present_or_inaccessible() {
        for status in [2, 3] {
            assert!(require_absent("registry Settings", registry_query_presence(status)).is_ok());
        }
        for status in [0, 234, 5, 13] {
            assert!(require_absent("registry Settings", registry_query_presence(status)).is_err());
        }
    }
}
