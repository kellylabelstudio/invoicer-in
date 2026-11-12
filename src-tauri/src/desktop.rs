use crate::invoice::Result;

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
