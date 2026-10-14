#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod board;
mod desktop;
mod update_helper;
mod update_storage;
mod update_verify;
mod updates;

use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::Manager;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

const OPERATIONS: &[&str] = &[
    "mailbox-register",
    "mailbox-directory",
    "mailbox-post",
    "mailbox-inbox",
    "mailbox-ack",
    "mailbox-wait-reply",
    "mailbox-claims",
    "discover",
    "status",
    "connect",
    "rename-agent",
    "grant",
    "submit",
    "messages",
    "request",
    "pause",
    "cancel",
    "reconnect",
    "spark-config",
    "spark",
    "session-register",
    "session-conversation",
    "session-list",
    "session-revoke",
    "session-rotate",
    "session-probe",
];
const INPUT_LIMIT: usize = 256 * 1024;
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;

#[tauri::command]
async fn update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    op: String,
    args: Value,
) -> Value {
    if window.label() != "main"
        || !args.is_object()
        || args.as_object().is_some_and(|v| !v.is_empty())
    {
        return error("OPERATION_DENIED", "This update operation is unavailable.");
    }
    match updates::action(&app, &op).await {
        Ok(mut value) => {
            let phase = match value["status"].as_str().unwrap_or("unavailable") {
                "awaiting_approval" => "approval-pending",
                "approved" => "authorized",
                "denied" | "expired" => "error",
                phase => phase,
            }
            .to_owned();
            value["phase"] = json!(phase);
            value["approval_url"] = value["verification_uri"].clone();
            value["approval_code"] = value["verification_code"].clone();
            json!({"ok":true,"data":value})
        }
        Err(message) => error("UPDATE_UNAVAILABLE", message),
    }
}

fn cli_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("bin")
        .join("claudacoda-cli.exe");
    if packaged.is_file() {
        return Ok(packaged);
    }
    #[cfg(debug_assertions)]
    {
        let development =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/bin/claudacoda-cli.exe");
        if development.is_file() {
            return Ok(development);
        }
    }
    Err(format!(
        "The bundled coordination CLI is missing: {}. Reinstall CodaClauda.",
        packaged.display()
    ))
}

pub(crate) fn error(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message.into()}})
}

#[cfg(windows)]
fn set_taskbar_icon(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    use windows::{
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                ICON_BIG, IMAGE_ICON, LR_DEFAULTSIZE, LR_SHARED, LoadImageW, SendMessageW,
                WM_SETICON,
            },
        },
        core::PCWSTR,
    };

    let hwnd = HWND(window.hwnd()?.0);
    unsafe {
        let module = GetModuleHandleW(None)?;
        // tauri-build embeds our configured multi-size icon under this public ID.
        let icon = LoadImageW(
            Some(HINSTANCE(module.0)),
            PCWSTR(tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as usize as *const u16),
            IMAGE_ICON,
            0,
            0,
            LR_DEFAULTSIZE | LR_SHARED,
        )?;
        // Tauri retains ICON_SMALL. This shared resource lives until process exit.
        // WM_SETICON returns the previous icon; zero is not a failure indication.
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(icon.0 as isize)),
        );
    }
    Ok(())
}

#[tauri::command]
fn preferences(app: tauri::AppHandle, board: tauri::State<'_, board::BoardBinding>) -> Value {
    match cli_path(&app) {
        Ok(path) => {
            json!({"ok":true,"data":{"cli_path":path,"state_dir":board.state_dir(),"version":env!("CARGO_PKG_VERSION")}})
        }
        Err(message) => error("CLI_MISSING", message),
    }
}

#[cfg(windows)]
fn choose_workspace(owner: isize) -> Result<Option<PathBuf>, String> {
    use windows::{
        Win32::{
            Foundation::{ERROR_CANCELLED, HWND},
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
            },
            UI::Shell::{
                FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS,
                FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH,
            },
        },
        core::{HRESULT, w},
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            // Paired with the successful initialization on this dedicated thread.
            unsafe { CoUninitialize() };
        }
    }

    // The dialog and all its COM interfaces remain on one fresh STA thread.
    // The owner is the invoking Tauri window, never a caller-supplied handle.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|e| e.to_string())?;
        let _apartment = ComApartment;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| e.to_string())?;
        let options = dialog.GetOptions().map_err(|e| e.to_string())?;
        dialog
            .SetOptions(
                options
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR,
            )
            .map_err(|e| e.to_string())?;
        dialog
            .SetTitle(w!("Choose your project folder"))
            .map_err(|e| e.to_string())?;
        if let Err(e) = dialog.Show(Some(HWND(owner as *mut std::ffi::c_void))) {
            return if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                Ok(None)
            } else {
                Err(e.to_string())
            };
        }
        let item = dialog.GetResult().map_err(|e| e.to_string())?;
        let allocated = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|e| e.to_string())?;
        let selected = allocated.to_string();
        // GetDisplayName allocates this string even if UTF-16 conversion fails.
        CoTaskMemFree(Some(allocated.0.cast()));
        let path = PathBuf::from(selected.map_err(|e| e.to_string())?);
        if !path.is_absolute() || !path.is_dir() {
            return Err("The selected project folder is no longer available.".into());
        }
        Ok(Some(path))
    }
}

/// Only user-selected directories are returned; this is not a filesystem bridge.
#[tauri::command]
async fn pick_workspace(window: tauri::WebviewWindow) -> Value {
    #[cfg(windows)]
    {
        let owner = match window.hwnd() {
            Ok(handle) => handle.0 as isize,
            Err(e) => return error("DIRECTORY_PICKER_FAILED", e.to_string()),
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        if let Err(e) = std::thread::Builder::new()
            .name("workspace-picker".into())
            .spawn(move || {
                let _ = sender.send(choose_workspace(owner));
            })
        {
            return error("DIRECTORY_PICKER_FAILED", e.to_string());
        }
        match receiver.await {
            Ok(Ok(Some(path))) => json!({"ok":true,"data":{"path":path}}),
            Ok(Ok(None)) => json!({"ok":true,"data":{"cancelled":true}}),
            Ok(Err(message)) => error("DIRECTORY_PICKER_FAILED", message),
            Err(_) => error(
                "DIRECTORY_PICKER_FAILED",
                "The project folder chooser closed unexpectedly.",
            ),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        error(
            "DIRECTORY_PICKER_UNAVAILABLE",
            "Enter your project folder path on this platform.",
        )
    }
}

/// The webview has no generic process or filesystem command. Every call is a
/// fixed CLI operation with a single JSON input; neither argument is shell text.
#[tauri::command]
async fn rpc(app: tauri::AppHandle, op: String, args: Value) -> Value {
    if !OPERATIONS.contains(&op.as_str()) {
        return error(
            "OPERATION_DENIED",
            "This desktop operation is not supported.",
        );
    }
    if !args.is_object() {
        return error(
            "INVALID_ARGUMENTS",
            "Operation arguments must be a JSON object.",
        );
    }
    let input = match serde_json::to_vec(&args) {
        Ok(input) if input.len() <= INPUT_LIMIT => input,
        _ => {
            return error(
                "INPUT_TOO_LARGE",
                "The request exceeds the desktop input limit.",
            );
        }
    };
    let path = match cli_path(&app) {
        Ok(path) => path,
        Err(message) => return error("CLI_MISSING", message),
    };
    let state_dir = {
        let board = app.state::<board::BoardBinding>();
        if let Err(message) = board.validate() {
            return error("BOARD_UNAVAILABLE", message);
        }
        board.state_dir().to_owned()
    };
    run_cli(path, Some(&state_dir), &op, input).await
}

async fn run_cli(path: PathBuf, state_dir: Option<&Path>, op: &str, input: Vec<u8>) -> Value {
    let mut command = Command::new(path);
    if let Some(state_dir) = state_dir {
        command.arg("--state-dir").arg(state_dir);
    }
    command
        .args(["--json", "api", op])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; never a shell.
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return error("CLI_START_FAILED", e.to_string()),
    };
    let result = timeout(Duration::from_secs(90), async move {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?;
        }
        child.wait_with_output().await
    })
    .await;
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return error("CLI_IO_FAILED", e.to_string()),
        Err(_) => {
            return error(
                "CLI_TIMEOUT",
                "The local operation timed out. Refresh the board before retrying a submission; it may already have been recorded.",
            );
        }
    };
    if output.stdout.len() > OUTPUT_LIMIT {
        return error(
            "OUTPUT_TOO_LARGE",
            "The local response exceeds the desktop output limit.",
        );
    }
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(value) if value.get("ok").and_then(Value::as_bool).is_some() => value,
        _ => {
            let detail: String = String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2000)
                .collect();
            error(
                "CLI_PROTOCOL_ERROR",
                format!(
                    "The local CLI returned an invalid response (exit {}). {}",
                    output.status,
                    detail.trim()
                ),
            )
        }
    }
}

async fn default_board(cli: PathBuf) -> Result<PathBuf, String> {
    let response = run_cli(cli, None, "status", b"{}".to_vec()).await;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("The bundled CLI could not resolve a coordination board. CodaClauda did not create a board binding.".into());
    }
    response
        .pointer("/data/state_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| {
            "The bundled CLI did not return its actual coordination board directory.".into()
        })
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if update_helper::run_if_requested() {
        return;
    }
    #[cfg(windows)]
    unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!(
            "com.deloresai.claudacoda"
        ))
    }
    .expect("Could not set CodaClauda's Windows application identity");

    let result = tauri::Builder::default()
        .manage(updates::UpdateState::default())
        .setup(|app| {
            let selected = board::parse_selection(std::env::args_os().skip(1))
                .map_err(std::io::Error::other)?;
            let executable = std::env::current_exe()?;
            let binding = board::load(&executable, selected.as_deref(), || {
                let cli = cli_path(app.handle())?;
                tauri::async_runtime::block_on(default_board(cli))
            })
            .map_err(std::io::Error::other)?;
            update_storage::initialize(&binding).map_err(std::io::Error::other)?;
            app.manage(binding);
            update_helper::confirm_launch();
            #[cfg(windows)]
            {
                let window = app.get_webview_window("main").ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "CodaClauda main window is missing",
                    )
                })?;
                set_taskbar_icon(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            preferences,
            pick_workspace,
            update,
            desktop::desktop_paths,
            desktop::desktop_state_load,
            desktop::desktop_state_save,
            desktop::desktop_manifest_load,
            desktop::project_scan,
            desktop::desktop_discover_projects,
            desktop::github_user,
            desktop::github_repos,
            desktop::github_create_repo,
            desktop::github_clone_repo,
            desktop::attachment_save,
            desktop::dictation_start,
            desktop::window_attention,
            desktop::open_external
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        let detail: String = error.to_string().chars().take(1600).collect();
        let message = format!(
            "CodaClauda could not start.\n\n{detail}\n\nYour coordination board was not reset. Preserve the existing board and repair the reported path or configuration before reopening."
        );
        #[cfg(windows)]
        unsafe {
            use windows::{
                Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW},
                core::{PCWSTR, w},
            };
            let wide: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
            MessageBoxW(
                None,
                PCWSTR(wide.as_ptr()),
                w!("CodaClauda could not start"),
                MB_ICONERROR | MB_OK,
            );
        }
        #[cfg(not(windows))]
        eprintln!("{message}");
        std::process::exit(1);
    }
}
