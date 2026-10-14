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
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("state.lock"))?;
        lock.lock_exclusive()?;
        let file = self.root.join("state.json");
        let mut state: State = if file.exists() {
            serde_json::from_slice(&fs::read(&file)?)
                .context("State file is invalid; preserve it and restore a known backup")?
        } else {
            State::default()
        };
        if state.schema_version != 1 {
            bail!("unsupported state schema; upgrade ClaudaCoda")
        }
        let result = operation(&mut state)?;
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
        if state.schema_version != 1 {
            bail!("unsupported state schema; upgrade ClaudaCoda")
        }
        Ok(state)
    }
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
