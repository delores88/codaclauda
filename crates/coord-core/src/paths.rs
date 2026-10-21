use anyhow::{Context, Result, bail};
use std::path::{Component, Path, PathBuf};

/// Git for Windows parses worktree destinations before Win32 path handling and
/// rejects Rust's canonical `\\?\` spelling. Keep state paths canonical and
/// convert only subprocess arguments; callers enable Git's long-path support.
pub fn git_argument(path: &Path) -> Result<String> {
    let value = path.to_str().context("Git path is not valid Unicode")?;
    #[cfg(not(windows))]
    return Ok(value.to_owned());
    #[cfg(windows)]
    {
        if value.starts_with(r"\\?\") && value.contains('/') {
            bail!("Canonical Windows Git paths cannot contain forward slashes")
        }
        let plain = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            format!("//{}", unc.replace('\\', "/"))
        } else if let Some(disk) = value.strip_prefix(r"\\?\") {
            if disk.as_bytes().get(1) != Some(&b':')
                || disk.as_bytes().get(2) != Some(&b'\\')
                || !disk.as_bytes()[0].is_ascii_alphabetic()
            {
                bail!("Git requires an ordinary absolute disk or UNC path")
            }
            disk.replace('\\', "/")
        } else {
            value.replace('\\', "/")
        };
        let components = if let Some(unc) = plain.strip_prefix("//") {
            if unc.split('/').count() < 2 {
                bail!("Git UNC path requires a server and share")
            }
            unc
        } else if plain.as_bytes().get(1) == Some(&b':')
            && plain.as_bytes().get(2) == Some(&b'/')
            && plain.as_bytes()[0].is_ascii_alphabetic()
        {
            &plain[3..]
        } else {
            bail!("Git requires an ordinary absolute disk or UNC path")
        };
        // Removing verbatim syntax must not activate Win32 normalization or a
        // reserved device name. A drive root is the sole empty-path exception.
        if !components.is_empty()
            && components.split('/').any(|part| {
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || part.ends_with(['.', ' '])
                    || part
                        .chars()
                        .any(|c| c.is_control() || ":<>\"|?*".contains(c))
                    || windows_device(&part.to_lowercase())
            })
        {
            bail!("Git path requires normalization-sensitive or reserved Windows names")
        }
        Ok(plain)
    }
}

/// A single stable spelling prevents independent grants claiming file aliases.
pub fn relative(value: &str) -> Result<PathBuf> {
    if value.is_empty()
        || value.len() > 1024
        || value.contains(['\0', ':', '\\'])
        || (value != "."
            && value
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        bail!("Use a canonical relative forward-slash path inside the authorized project")
    }
    let p = Path::new(value);
    for part in p.components() {
        match part {
            Component::Normal(v) => {
                let s = v.to_string_lossy().to_lowercase();
                if s.starts_with('.') && s != ".gitignore"
                    || [
                        "node_modules",
                        "target",
                        "credentials",
                        "secrets",
                        "id_rsa",
                        "id_ed25519",
                    ]
                    .contains(&s.as_str())
                    || s.ends_with(['.', ' '])
                    || [".pem", ".key", ".pfx", ".p12"]
                        .iter()
                        .any(|e| s.ends_with(e))
                    || windows_device(&s)
                {
                    bail!("Sensitive, reserved or internal paths are excluded")
                }
                #[cfg(windows)]
                if short_name_alias(&s) {
                    bail!("Windows short-name aliases are not supported in authorized paths")
                }
            }
            Component::CurDir if value == "." => {}
            _ => bail!("Path traversal or absolute paths are not allowed"),
        }
    }
    Ok(p.to_path_buf())
}

fn windows_device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    if ["con", "prn", "aux", "nul", "conin$", "conout$", "clock$"].contains(&stem) {
        return true;
    }
    ["com", "lpt"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

#[cfg(windows)]
fn short_name_alias(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    stem.rsplit_once('~')
        .is_some_and(|(_, suffix)| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()))
}

fn scope_key(value: &str) -> String {
    #[cfg(windows)]
    {
        // Windows compares names through uppercase mappings (including final
        // sigma and dotless i); Unicode lowercase alone misses those aliases.
        value.to_uppercase()
    }
    #[cfg(not(windows))]
    {
        value.to_owned()
    }
}

fn contains(scope: &str, candidate: &str) -> bool {
    scope == "." || scope == candidate || candidate.starts_with(&format!("{scope}/"))
}

pub fn overlaps(a: &str, b: &str) -> bool {
    // Older state with an alias spelling fails closed against new edit claims.
    if relative(a).is_err() || relative(b).is_err() {
        return true;
    }
    let a = scope_key(a);
    let b = scope_key(b);
    contains(&a, &b) || contains(&b, &a)
}
pub fn authorized(root: &Path, value: &str, allowed: &[String], write: bool) -> Result<PathBuf> {
    let rel = relative(value)?;
    let key = scope_key(value);
    if !allowed
        .iter()
        .any(|a| relative(a).is_ok() && contains(&scope_key(a), &key))
    {
        bail!("Path is outside the owner's authorized scope")
    }
    let root = root.canonicalize()?;
    let candidate = root.join(&rel);
    let mut part = root.clone();
    for item in rel.components() {
        part.push(item.as_os_str());
        if let Ok(meta) = std::fs::symlink_metadata(&part) {
            if meta.file_type().is_symlink() {
                bail!("Symbolic links are not allowed")
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    bail!("Reparse points are not allowed")
                }
            }
        }
    }
    let check = if candidate.exists() {
        candidate.canonicalize()?
    } else if write {
        candidate
            .parent()
            .context("Missing parent")?
            .canonicalize()?
    } else {
        bail!("File does not exist")
    };
    if !check.starts_with(&root) {
        bail!("Artifact is outside the authorized project")
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn git_windows_arguments_preserve_disk_unc_and_long_paths_without_aliases() {
        assert_eq!(
            git_argument(Path::new(r"\\?\C:\owner folder\project")).unwrap(),
            "C:/owner folder/project"
        );
        assert_eq!(
            git_argument(Path::new(r"\\?\UNC\server\share\project")).unwrap(),
            "//server/share/project"
        );
        assert_eq!(
            git_argument(Path::new(r"\\server\share\project")).unwrap(),
            "//server/share/project"
        );
        let long = format!(
            r"\\?\C:\{}\project",
            "nested\\".repeat(60).trim_end_matches('\\')
        );
        assert!(git_argument(Path::new(&long)).unwrap().len() > 260);
        for invalid in [
            r"\\?\C:\name.\project",
            r"\\?\C:\name \project",
            r"\\?\C:\..\project",
            r"\\?\C:\NUL\project",
            r"\\?\C:\file:stream",
            r"\\?\Volume{123}\project",
            r"\\.\C:\project",
            r"C:relative",
            r"\\server",
        ] {
            assert!(git_argument(Path::new(invalid)).is_err(), "{invalid}");
        }
    }
    #[test]
    fn rejects_traversal_and_secrets() {
        for p in [
            "../secret",
            "C:/file",
            "a\\b",
            ".env",
            ".git/config",
            "keys/a.pem",
            "a/../../b",
        ] {
            assert!(relative(p).is_err(), "{p}")
        }
        assert!(relative("src/lib.rs").is_ok());
        assert!(relative(".").is_ok());
    }
    #[test]
    fn rejects_alternate_spelling_and_windows_devices() {
        for p in [
            "./src/a.rs",
            "src/./a.rs",
            "src//a.rs",
            "src/",
            "/src/a.rs",
            "src/a.rs.",
            "src/a.rs ",
            "NUL",
            "nul.txt",
            "src/COM1.rs",
            "src/lpt9",
            "src/COM¹.txt",
            "CONOUT$",
        ] {
            assert!(relative(p).is_err(), "{p}");
        }
        assert!(relative("src/computation.rs").is_ok());
    }
    #[test]
    fn claims_overlap() {
        assert!(overlaps("src", "src/main.rs"));
        assert!(!overlaps("src/a.rs", "src/b.rs"));
        assert!(overlaps(".", "src"));
        assert!(!overlaps("src/a", "src/abc"));
        assert!(overlaps("src/./a.rs", "other-file"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_claims_and_authorization_ignore_case() {
        assert!(overlaps("SRC/A.rs", "src/a.RS"));
        assert!(overlaps("Src", "src/A.rs"));
        assert!(overlaps("src/Σ.rs", "src/ς.rs"));
        assert!(overlaps("src/I.rs", "src/ı.rs"));
        assert!(relative("LONGFI~1.TXT").is_err());
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("src")).unwrap();
        std::fs::write(temp.path().join("src/a.rs"), b"example").unwrap();
        assert!(authorized(temp.path(), "SRC/A.RS", &["src/a.rs".into()], false).is_ok());
        assert!(authorized(temp.path(), "src/a.rs", &["SRC".into()], false).is_ok());
        assert!(authorized(temp.path(), "src/a.rs", &["SRC/other.rs".into()], false).is_err());
    }
}
