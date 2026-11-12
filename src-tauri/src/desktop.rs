use crate::invoice::Result;

#[cfg(windows)]
static GLASS_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
fn apply_glass(hwnd: windows_sys::Win32::Foundation::HWND, enabled: bool) -> bool {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW,
        DWMWA_SYSTEMBACKDROP_TYPE,
    };
    use windows_sys::Win32::UI::Controls::MARGINS;
    let effect = if enabled {
        DWMSBT_TRANSIENTWINDOW
    } else {
        DWMSBT_NONE
    } as u32;
    let margin = if enabled { -1 } else { 0 };
    let frame = MARGINS {
        cxLeftWidth: margin,
        cxRightWidth: margin,
        cyTopHeight: margin,
        cyBottomHeight: margin,
    };
    // Unsupported Windows builds return a failure; the web UI keeps an opaque fallback.
    unsafe {
        let backdrop = DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            std::ptr::from_ref(&effect).cast(),
            std::mem::size_of_val(&effect) as u32,
        );
        let extended = DwmExtendFrameIntoClientArea(hwnd, &frame);
        backdrop >= 0 && extended >= 0
    }
}

pub fn set_window_glass(window: &tauri::WebviewWindow, enabled: bool) -> Result<bool> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let applied = apply_glass(hwnd.0, enabled);
        if enabled && !applied {
            apply_glass(hwnd.0, false);
        }
        GLASS_ENABLED.store(enabled && applied, std::sync::atomic::Ordering::Relaxed);
        Ok(enabled && applied)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, enabled);
        Ok(false)
    }
}

pub fn refresh_glass_frame(window: &tauri::Window) {
    #[cfg(windows)]
    if GLASS_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
        if let Ok(hwnd) = window.hwnd() {
            apply_glass(hwnd.0, true);
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

pub fn fit_initial_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let monitor = window.current_monitor()?.or(window.primary_monitor()?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let work = monitor.work_area();
    let inner = window.inner_size()?;
    let outer = window.outer_size()?;
    if let Some(fit) = crate::display::fit_window(
        (work.position.x, work.position.y),
        (work.size.width, work.size.height),
        monitor.scale_factor(),
        (
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        ),
    ) {
        window.set_min_size(Some(tauri::PhysicalSize::new(fit.minimum.0, fit.minimum.1)))?;
        window.set_size(tauri::PhysicalSize::new(fit.size.0, fit.size.1))?;
        window.set_position(tauri::PhysicalPosition::new(fit.position.0, fit.position.1))?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn repair_shortcut() -> Result<()> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$target='{target}'
$folder=[Environment]::GetFolderPath('Programs')
[IO.Directory]::CreateDirectory($folder) | Out-Null
$link=Join-Path $folder 'Invoicer In.lnk'
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($link)
$shortcut.TargetPath=$target
$shortcut.WorkingDirectory=Split-Path -Parent $target
$shortcut.IconLocation=$target + ',0'
$shortcut.Description='Invoicer In by Kelly Label Studio'
$shortcut.Save()
if (-not (Test-Path -LiteralPath $link)) {{ throw 'The app shortcut could not be created.' }}
[Console]::Write($folder)
"#
    );
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &STANDARD.encode(bytes),
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("Windows could not refresh the app shortcut. {e}"))?;
    if !output.status.success() {
        return Err("Windows could not refresh the shortcut. Try running setup again for your Windows account.".into());
    }
    let folder = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if folder.is_empty() {
        return Err("The Start menu folder could not be located.".into());
    }
    open::that(folder).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn repair_shortcut() -> Result<()> {
    Err("Start menu shortcuts are available on Windows.".into())
}
