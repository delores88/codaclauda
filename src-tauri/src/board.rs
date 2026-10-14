//! Per-install board selection. This private settings file is outside the payload
//! replaced by NSIS; it contains paths only, never board contents or credentials.

use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const FILE_NAME: &str = ".claudacoda-board.json";
const READ_LIMIT: u64 = 16 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u32,
    install_root: PathBuf,
    state_dir: PathBuf,
}

/// Created once at startup and shared with RPC and the installer helper. No
/// command, webview argument, or changed environment can select another board.
#[derive(Debug)]
pub(crate) struct BoardBinding {
    state_dir: PathBuf,
    settings_dir: PathBuf,
}

impl BoardBinding {
    pub(crate) fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub(crate) fn settings_dir(&self) -> &Path {
        &self.settings_dir
    }

    /// The CLI creates missing state directories, so check availability again
    /// before invoking it. A removed/moved board must not become an empty board.
    pub(crate) fn validate(&self) -> Result<(), String> {
        let current = physical_path(&self.state_dir, true)?;
        if current != self.state_dir {
            return Err(
                "The selected coordination board has moved; startup must be reviewed.".into(),
            );
        }
        Ok(())
    }
}

/// Desktop bootstrap accepts an explicit existing board, not an arbitrary CLI
/// command. In particular, duplicate selectors cannot silently change routing.
pub(crate) fn parse_selection(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<Option<PathBuf>, String> {
    let mut args = arguments.into_iter();
    let Some(flag) = args.next() else {
        return Ok(None);
    };
    if flag != "--state-dir" {
        return Err("Unsupported ClaudaCoda startup argument; use --state-dir PATH to select an existing board.".into());
    }
    let path = args
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "ClaudaCoda --state-dir requires an existing absolute directory.".to_owned()
        })?;
    if args.next().is_some() {
        return Err("Only one --state-dir selection is permitted at startup.".into());
    }
    Ok(Some(PathBuf::from(path)))
}

/// `default_board` is called only if no binding or explicit selection exists.
/// Production resolves that default with the bundled CLI's public status API.
pub(crate) fn load(
    executable: &Path,
    explicit: Option<&Path>,
    default_board: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<BoardBinding, String> {
    let executable = physical_path(executable, false)?;
    let install_root = executable
        .parent()
        .ok_or("The installation root is missing.")?;
    let settings = settings_directory(install_root)?;
    let binding = settings.join(FILE_NAME);
    let requested = explicit.map(|path| physical_path(path, true)).transpose()?;

    if let Some(record) = read_record(&binding, install_root)? {
        return select_record(record, requested.as_deref(), settings);
    }

    let state_dir = match requested {
        Some(path) => path,
        None => physical_path(&default_board()?, true)?,
    };
    let record = Record {
        schema: 1,
        install_root: install_root.to_owned(),
        state_dir,
    };
    create_settings_directory(&settings)?;
    persist_exclusive(&binding, &record)?;
    // A concurrent startup may have committed first. Always read the committed
    // complete record and reject a different selection, never overwrite it.
    let winner = read_record(&binding, install_root)?
        .ok_or("The coordination board binding disappeared during startup.")?;
    select_record(winner, Some(&record.state_dir), settings)
}

/// Helper processes execute from staging. Bind them to the physical installed
/// application named in their plan, never to the helper executable's location.
/// This path performs no writes and cannot resolve/create a default board.
pub(crate) fn load_existing(physical_install_root: &Path) -> Result<BoardBinding, String> {
    let install_root = physical_path(physical_install_root, true)?;
    let settings = settings_directory(&install_root)?;
    let record = read_record(&settings.join(FILE_NAME), &install_root)?
        .ok_or("This installation has no existing coordination board binding.")?;
    select_record(record, None, settings)
}

fn select_record(
    record: Record,
    requested: Option<&Path>,
    settings_dir: PathBuf,
) -> Result<BoardBinding, String> {
    let state_dir = physical_path(&record.state_dir, true)?;
    if requested.is_some_and(|path| path != state_dir) {
        return Err("This installation is already bound to another coordination board. The explicit --state-dir selection conflicts; the board was not changed.".into());
    }
    Ok(BoardBinding {
        state_dir,
        settings_dir,
    })
}

fn settings_directory(install_root: &Path) -> Result<PathBuf, String> {
    let parent = install_root
        .parent()
        .ok_or("The installation needs a parent directory.")?;
    let basename = install_root
        .file_name()
        .ok_or("The installation directory name is missing.")?;
    let mut name = OsString::from(".");
    name.push(basename);
    name.push(".claudacoda-settings");
    Ok(parent.join(name))
}

fn create_settings_directory(settings: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(settings) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => {
            return Err(format!(
                "Could not create the private board settings directory: {e}"
            ));
        }
    }
    physical_path(settings, true)?;
    Ok(())
}

fn reject_links(metadata: &fs::Metadata) -> Result<(), String> {
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse {
        return Err("Board binding paths cannot contain symbolic links or reparse points.".into());
    }
    Ok(())
}

fn check_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(
            "Board binding paths must be absolute and cannot traverse parent directories.".into(),
        );
    }
    for component in path.ancestors() {
        let metadata = fs::symlink_metadata(component)
            .map_err(|e| format!("A bound installation or board path is unavailable: {e}"))?;
        reject_links(&metadata)?;
    }
    Ok(())
}

fn physical_path(path: &Path, directory: bool) -> Result<PathBuf, String> {
    check_components(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if if directory {
        !metadata.is_dir()
    } else {
        !metadata.is_file()
    } {
        return Err("The bound installation or board path has the wrong file type.".into());
    }
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    check_components(&canonical)?;
    Ok(canonical)
}

fn read_record(binding: &Path, install_root: &Path) -> Result<Option<Record>, String> {
    // Distinguish a genuinely absent binding from a broken link, malformed file,
    // unavailable parent or access failure. None of those may select a new board.
    let settings = binding
        .parent()
        .ok_or("The board settings path is invalid.")?;
    match fs::symlink_metadata(settings) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("The board settings directory is unavailable: {e}")),
        Ok(_) => {
            physical_path(settings, true)?;
        }
    }
    let mut remaining = 100;
    let metadata = loop {
        match fs::symlink_metadata(binding) {
            // Another first startup may have just created the settings directory
            // and be publishing its complete record. Wait at most one second.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && remaining > 0 => {
                remaining -= 1;
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err("The existing board settings directory has no complete binding. Startup is stopped to avoid selecting an empty board.".into());
            }
            Err(e) => return Err(format!("The board binding is unavailable: {e}")),
            Ok(metadata) => break metadata,
        }
    };
    reject_links(&metadata)?;
    if !metadata.is_file() || metadata.len() > READ_LIMIT {
        return Err("The board binding is not a bounded settings file.".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the link itself, never follow a substituted reparse target; deny
        // replacement while reading. Write sharing permits the committing
        // process to finish sync_all after its atomic link becomes visible.
        options.custom_flags(0x00200000).share_mode(3);
    }
    let file = options
        .open(binding)
        .map_err(|e| format!("Could not read the board binding: {e}"))?;
    reject_links(&file.metadata().map_err(|e| e.to_string())?)?;
    let mut bytes = Vec::new();
    file.take(READ_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > READ_LIMIT {
        return Err("The board binding exceeds its size limit.".into());
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| {
        "The board binding is malformed; it must be repaired before startup.".to_owned()
    })?;
    if record.schema != 1 || physical_path(&record.install_root, true)? != install_root {
        return Err(
            "The board binding belongs to a different installation or unsupported schema.".into(),
        );
    }
    Ok(Some(record))
}

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn persist_exclusive(binding: &Path, record: &Record) -> Result<(), String> {
    let parent = binding
        .parent()
        .ok_or("The board settings path is invalid.")?;
    physical_path(parent, true)?;
    let bytes = serde_json::to_vec(record).map_err(|_| "The board path cannot be serialized.")?;
    if bytes.len() as u64 > READ_LIMIT {
        return Err("The board binding exceeds its size limit.".into());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let mut created = None;
    for _ in 0..32 {
        let index = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".board-{}-{stamp}-{index}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1); // no replacement or writer while committing
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                created = Some((file, TemporaryFile(path)));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create the board binding: {e}")),
        }
    }
    let (mut file, temporary) =
        created.ok_or("Could not allocate a private board binding file.")?;
    let result = (|| {
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Could not persist the board binding: {e}"))?;
        physical_path(parent, true)?;
        // A hard-link commit is atomic, same-volume and never replaces an
        // existing name. Both names refer to the fully written inode.
        // Unsupported filesystems fail closed, without a partial write.
        match fs::hard_link(&temporary.0, binding) {
            Ok(()) => file
                .sync_all()
                .map_err(|e| format!("Could not sync the board binding: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(format!(
                "Could not atomically commit the board binding: {e}"
            )),
        }
    })();
    drop(file); // Windows must release delete sharing before removing our temp.
    drop(temporary);
    #[cfg(unix)]
    if result.is_ok() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("Could not sync the board settings directory: {e}"))?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    struct Fixture {
        root: PathBuf,
        exe: PathBuf,
        board: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let n = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "claudacoda-board-test-{}-{stamp}-{n}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            let install = root.join("ClaudaCoda");
            fs::create_dir(&install).unwrap();
            let exe = install.join("claudacoda.exe");
            fs::write(&exe, b"fixture, never executed").unwrap();
            let board = root.join("existing board");
            fs::create_dir(&board).unwrap();
            Self { root, exe, board }
        }
        fn binding(&self) -> PathBuf {
            settings_directory(&fs::canonicalize(self.exe.parent().unwrap()).unwrap())
                .unwrap()
                .join(FILE_NAME)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn no_default() -> Result<PathBuf, String> {
        panic!("default resolution must not run")
    }

    #[test]
    fn startup_selection_is_exact_and_single() {
        let expected = PathBuf::from("C:\\owner board\\é");
        assert_eq!(
            parse_selection([
                OsString::from("--state-dir"),
                expected.as_os_str().to_owned()
            ])
            .unwrap(),
            Some(expected)
        );
        assert_eq!(parse_selection([]).unwrap(), None);
        for args in [
            vec!["--state-dir"],
            vec!["--state-dir", ""],
            vec!["--wrong"],
            vec!["--state-dir", "a", "--state-dir", "b"],
        ] {
            assert!(parse_selection(args.into_iter().map(OsString::from)).is_err());
        }
    }

    #[test]
    fn explicit_existing_board_is_persisted_and_reused_without_default() {
        let f = Fixture::new();
        let expected = fs::canonicalize(&f.board).unwrap();
        assert_eq!(
            load(&f.exe, Some(&f.board), no_default)
                .unwrap()
                .state_dir(),
            expected
        );
        let before = fs::read(f.binding()).unwrap();
        assert_eq!(
            load(&f.exe, None, no_default).unwrap().state_dir(),
            expected
        );
        assert_eq!(
            load(&f.exe, Some(&f.board), no_default)
                .unwrap()
                .state_dir(),
            expected
        );
        assert_eq!(before, fs::read(f.binding()).unwrap());
        assert!(!f.binding().starts_with(f.exe.parent().unwrap()));
    }

    #[test]
    fn fresh_default_is_resolved_once_and_committed() {
        let f = Fixture::new();
        let chosen = load(&f.exe, None, || Ok(f.board.clone())).unwrap();
        assert_eq!(chosen.state_dir(), fs::canonicalize(&f.board).unwrap());
        assert_eq!(
            load(&f.exe, None, no_default).unwrap().state_dir(),
            chosen.state_dir()
        );
    }

    #[test]
    fn helper_load_is_read_only_and_uses_installed_root() {
        let f = Fixture::new();
        assert!(load_existing(f.exe.parent().unwrap()).is_err());
        assert!(!f.binding().parent().unwrap().exists());
        load(&f.exe, Some(&f.board), no_default).unwrap();
        let before = fs::read(f.binding()).unwrap();
        let helper_binding = load_existing(f.exe.parent().unwrap()).unwrap();
        assert_eq!(
            helper_binding.state_dir(),
            fs::canonicalize(&f.board).unwrap()
        );
        assert_eq!(helper_binding.settings_dir(), f.binding().parent().unwrap());
        assert_eq!(before, fs::read(f.binding()).unwrap());
        let staging = f.root.join("staging");
        fs::create_dir(&staging).unwrap();
        assert!(load_existing(&staging).is_err());
        assert!(!settings_directory(&staging).unwrap().exists());
    }

    #[test]
    fn incomplete_settings_and_failed_default_resolution_do_not_reset_board() {
        let f = Fixture::new();
        assert!(load(&f.exe, None, || Err("status unavailable".into())).is_err());
        assert!(!f.binding().parent().unwrap().exists());
        fs::create_dir(f.binding().parent().unwrap()).unwrap();
        assert!(
            load(&f.exe, None, no_default)
                .unwrap_err()
                .contains("no complete binding")
        );
        assert!(!f.binding().exists());
    }

    #[test]
    fn conflicting_selection_never_changes_existing_binding() {
        let f = Fixture::new();
        load(&f.exe, Some(&f.board), no_default).unwrap();
        let before = fs::read(f.binding()).unwrap();
        let other = f.root.join("another board");
        fs::create_dir(&other).unwrap();
        assert!(
            load(&f.exe, Some(&other), no_default)
                .unwrap_err()
                .contains("conflicts")
        );
        assert_eq!(before, fs::read(f.binding()).unwrap());
    }

    #[test]
    fn malformed_unavailable_and_missing_explicit_paths_never_fall_back() {
        let f = Fixture::new();
        assert!(load(&f.exe, Some(&f.root.join("missing")), no_default).is_err());
        assert!(!f.binding().exists());
        load(&f.exe, Some(&f.board), no_default).unwrap();
        let valid = fs::read(f.binding()).unwrap();
        for bytes in [b"{".as_slice(), br#"{"schema":999}"#, &[b'x'; 16385]] {
            fs::write(f.binding(), bytes).unwrap();
            assert!(load(&f.exe, None, no_default).is_err());
        }
        fs::write(f.binding(), valid).unwrap();
        fs::remove_dir(&f.board).unwrap();
        assert!(load(&f.exe, None, no_default).is_err());
        assert!(!f.board.exists());
    }

    #[test]
    fn copied_binding_cannot_select_another_installations_board() {
        let f = Fixture::new();
        let other = Fixture::new();
        load(&f.exe, Some(&f.board), no_default).unwrap();
        fs::create_dir(other.binding().parent().unwrap()).unwrap();
        fs::copy(f.binding(), other.binding()).unwrap();
        assert!(
            load(&other.exe, None, no_default)
                .unwrap_err()
                .contains("different installation")
        );
    }

    #[test]
    fn removed_board_cannot_be_recreated_by_a_running_desktop() {
        let f = Fixture::new();
        let binding = load(&f.exe, Some(&f.board), no_default).unwrap();
        fs::remove_dir(&f.board).unwrap();
        assert!(binding.validate().is_err());
    }

    #[test]
    fn simultaneous_startup_commits_one_complete_identical_binding() {
        let f = Fixture::new();
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let exe = f.exe.clone();
                let board = f.board.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    load(&exe, None, || {
                        barrier.wait();
                        Ok(board)
                    })
                })
            })
            .collect();
        for worker in workers {
            assert_eq!(
                worker.join().unwrap().unwrap().state_dir(),
                fs::canonicalize(&f.board).unwrap()
            );
        }
        assert_eq!(
            fs::read_dir(f.binding().parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn conflicting_concurrent_startup_does_not_silently_switch_boards() {
        let f = Fixture::new();
        let second = f.root.join("second");
        fs::create_dir(&second).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = [f.board.clone(), second]
            .into_iter()
            .map(|board| {
                let exe = f.exe.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    load(&exe, None, || {
                        barrier.wait();
                        Ok(board)
                    })
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result
                    .as_ref()
                    .is_err_and(|error| error.contains("conflicts")))
                .count(),
            1
        );
        assert!(load(&f.exe, None, no_default).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_binding_and_board_are_rejected_without_default_resolution() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let alias = f.root.join("alias");
        symlink(&f.board, &alias).unwrap();
        assert!(load(&f.exe, Some(&alias), no_default).is_err());
        fs::create_dir(f.binding().parent().unwrap()).unwrap();
        symlink(f.root.join("missing"), f.binding()).unwrap();
        assert!(load(&f.exe, None, no_default).is_err());
    }
}
