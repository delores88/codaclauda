use crate::model::State;
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}
impl Store {
    /// Create coordination-owned scratch on first compute use, outside projects.
    pub(crate) fn spark_scratch(&self) -> Result<PathBuf> {
        let path = self.root.join("scratch");
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error).context("Could not create private Spark scratch directory");
            }
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("Spark scratch must be a coordination-owned directory, not a file or link")
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                bail!("Spark scratch must not be a reparse point")
            }
        }
        let canonical = fs::canonicalize(&path)?;
        if canonical.parent() != Some(self.root.as_path()) {
            bail!("Spark scratch resolved outside coordination state")
        }
        Ok(canonical)
    }

    pub fn new(root: Option<PathBuf>) -> Result<Self> {
        let root = match root {
            Some(root) => root,
            None => default_root()?,
        };
        fs::create_dir_all(&root)?;
        Ok(Self {
            root: fs::canonicalize(root)?,
        })
    }
    pub fn transaction<T>(&self, operation: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        self.transaction_inner(false, operation)
    }

    /// Upgrade only when a successful registered-session mutation is committed.
    /// Backup bytes are the exact previous file, never a reserialized substitute.
    pub fn session_transaction<T>(
        &self,
        operation: impl FnOnce(&mut State) -> Result<T>,
    ) -> Result<T> {
        self.transaction_inner(true, operation)
    }

    fn transaction_inner<T>(
        &self,
        session: bool,
        operation: impl FnOnce(&mut State) -> Result<T>,
    ) -> Result<T> {
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("state.lock"))?;
        lock.lock_exclusive()?;
        let file = self.root.join("state.json");
        let original = if file.exists() {
            Some(fs::read(&file)?)
        } else {
            None
        };
        let mut state: State = if let Some(ref original) = original {
            serde_json::from_slice(original)
                .context("State file is invalid; preserve it and restore a known backup")?
        } else {
            State::default()
        };
        check_schema(&state)?;
        let result = operation(&mut state)?;
        // Bound each changed request's retained history before persisting it (C6).
        crate::spool::spill_events(&self.root, &mut state)?;
        // Upgrade only when a successful mutation persists data the old schema
        // cannot hold: registered sessions (2) or 0.5-only data (3), which 0.4
        // clients refuse. Backup bytes are the exact previous file.
        let target = if state.has_current_data() {
            3
        } else if session {
            2
        } else {
            1
        };
        if target > state.schema_version {
            if let Some(original) = original {
                // Never overwrite a previous backup. A failed/ambiguous prior
                // upgrade may leave one; it must match before we can proceed.
                let old = state.schema_version;
                let backup = self.root.join(format!("state.schema{old}.backup.json"));
                if backup.exists() {
                    if fs::read(&backup)? != original {
                        bail!("Schema {old} backup differs; preserve both files before migrating")
                    }
                } else {
                    let mut saved = tempfile::NamedTempFile::new_in(&self.root)?;
                    saved.write_all(&original)?;
                    saved.as_file().sync_all()?;
                    let saved = saved.persist_noclobber(&backup).map_err(|e| e.error)?;
                    saved.sync_all()?;
                    #[cfg(unix)]
                    fs::File::open(&self.root)?.sync_all()?;
                }
            }
            state.schema_version = target;
        }
        let bytes = serde_json::to_vec_pretty(&state)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&file).map_err(|e| e.error)?;
        FileExt::unlock(&lock)?;
        Ok(result)
    }
    pub fn read(&self) -> Result<State> {
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("state.lock"))?;
        FileExt::lock_shared(&lock)?;
        let path = self.root.join("state.json");
        let state: State = if path.exists() {
            serde_json::from_slice(&fs::read(path)?)
                .context("State file is invalid; preserve it and restore a known backup")?
        } else {
            State::default()
        };
        check_schema(&state)?;
        Ok(state)
    }
}

fn check_schema(state: &State) -> Result<()> {
    if !matches!(state.schema_version, 1..=3) {
        bail!("unsupported state schema; upgrade CodaClauda")
    }
    if state.schema_version == 1
        && (!state.registrations.is_empty()
            || !state.conversations.is_empty()
            || !state.session_messages.is_empty())
    {
        bail!("Registered-session data requires schema 2; preserve the inconsistent board")
    }
    if state.schema_version < 3 && state.has_current_data() {
        bail!("CodaClauda 0.5 data requires schema 3; preserve the inconsistent board")
    }
    Ok(())
}

pub fn default_root() -> Result<PathBuf> {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{
                FOLDERID_LocalAppData, KF_FLAG_NO_PACKAGE_REDIRECTION, SHGetKnownFolderPath,
            },
        };
        let mut raw = std::ptr::null_mut();
        let hr = SHGetKnownFolderPath(
            &FOLDERID_LocalAppData,
            KF_FLAG_NO_PACKAGE_REDIRECTION as u32,
            std::ptr::null_mut(),
            &mut raw,
        );
        if hr < 0 || raw.is_null() {
            if !raw.is_null() {
                CoTaskMemFree(raw.cast());
            }
            bail!("Windows LocalAppData KnownFolder is unavailable")
        }
        let mut n = 0;
        while *raw.add(n) != 0 {
            n += 1;
        }
        let path = PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(
            raw, n,
        )));
        CoTaskMemFree(raw.cast());
        if !path.is_absolute() {
            bail!("Windows LocalAppData path is not absolute")
        }
        Ok(path.join("DeloresAI").join("CodaClauda"))
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
            .context("User state directory unavailable")?;
        Ok(base.join("codaclauda"))
    }
}
