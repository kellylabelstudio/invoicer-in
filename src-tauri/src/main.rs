#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod drive;
mod invoice;
mod store;

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Local;
use drive::DriveGate;
use invoice::{field, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::fs;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

type Data<'a> = State<'a, Arc<store::Store>>;

#[tauri::command]
fn get_settings(data: Data<'_>) -> Result<Value> {
    let db = data.lock()?;
    store::settings(&db)
}

#[tauri::command]
fn save_settings(data: Data<'_>, value: Value) -> Result<Value> {
    if !value.is_object() || !value["seller"].is_object() || value.to_string().len() > 3_000_000 {
        return Err("Settings are invalid or exceed the supported size.".into());
    }
    let db = data.lock()?;
    let current = store::settings(&db)?;
    let auto = value["driveAuto"].as_bool().unwrap_or(false);
    if auto
        && (current["driveAccount"].is_null()
            || drive::status()["account"] != current["driveAccount"])
    {
        return Err("Connect the Google Drive account before enabling automatic uploads.".into());
    }
    let mut updated = current;
    for key in [
        "seller",
        "irp",
        "template",
        "driveAuto",
        "payment",
        "savedTemplates",
    ] {
        updated[key] = value[key].clone();
    }
    store::set_settings(&db, &updated)?;
    Ok(updated)
}

#[tauri::command]
fn get_draft(data: Data<'_>) -> Result<Option<Value>> {
    let raw: Option<String> = data
        .lock()?
        .query_row("SELECT data FROM draft WHERE id=1", [], |row| row.get(0))
        .optional()
        .map_err(store::error)?;
    raw.map(|text| serde_json::from_str(&text).map_err(|_| "The stored draft is invalid.".into()))
        .transpose()
}

#[tauri::command]
fn save_draft(data: Data<'_>, value: Option<Value>) -> Result<()> {
    let db = data.lock()?;
    match value {
        Some(draft) if draft.to_string().len() <= 2_000_000 => {
            db.execute(
                "INSERT INTO draft VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                [draft.to_string()],
            )
            .map_err(store::error)?;
        }
        None => {
            db.execute("DELETE FROM draft WHERE id=1", [])
                .map_err(store::error)?;
        }
        _ => return Err("Draft is too large to save.".into()),
    }
    Ok(())
}

#[tauri::command]
fn new_number(data: Data<'_>, date: String) -> Result<String> {
    let db = data.lock()?;
    let date = if date.is_empty() {
        Local::now().date_naive().to_string()
    } else {
        date
    };
    store::next_number(&db, &date)
}

#[tauri::command]
fn quote_invoice(value: Value) -> Result<invoice::Quote> {
    invoice::quote(&value)
}

#[tauri::command]
fn validate_invoice(data: Data<'_>, value: Value) -> Result<invoice::Quote> {
    let db = data.lock()?;
    let settings = store::settings(&db)?;
    invoice::validate(&value, field(&settings, "irp"))
}

#[tauri::command]
fn encode_qr(payload: String) -> Result<Vec<Vec<bool>>> {
    invoice::qr_matrix(&payload)
}

#[tauri::command]
fn list_invoices(data: Data<'_>) -> Result<Vec<store::Summary>> {
    let db = data.lock()?;
    store::invoices(&db)
}

#[tauri::command]
fn get_invoice(data: Data<'_>, id: String) -> Result<Value> {
    let db = data.lock()?;
    store::invoice(&db, &id)
}

#[tauri::command]
fn issue_invoice(data: Data<'_>, value: Value, pdf: String) -> Result<String> {
    if pdf.len() > 45_000_000 {
        return Err("The encoded PDF exceeds the supported size.".into());
    }
    let pdf = STANDARD.decode(pdf).map_err(|_| "Invalid encoded PDF.")?;
    let mut db = data.lock()?;
    store::issue(&mut db, &value, pdf)
}

#[tauri::command]
fn list_customers(data: Data<'_>) -> Result<Vec<Value>> {
    let db = data.lock()?;
    store::customers(&db)
}

#[tauri::command]
fn save_customer(data: Data<'_>, value: Value) -> Result<Value> {
    let db = data.lock()?;
    store::save_customer(&db, value)
}

#[tauri::command]
fn delete_customer(data: Data<'_>, id: String) -> Result<()> {
    data.lock()?
        .execute("DELETE FROM customers WHERE id=?1", [id])
        .map_err(store::error)?;
    Ok(())
}

#[tauri::command]
async fn export_invoice(app: AppHandle, data: Data<'_>, id: String) -> Result<bool> {
    let data = Arc::clone(data.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (number, pdf): (String, Option<Vec<u8>>) = data
            .lock()?
            .query_row(
                "SELECT number,pdf FROM invoices WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(store::error)?;
        let pdf = pdf.ok_or("This imported invoice did not include a PDF.")?;
        let name = number
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .set_file_name(format!("{name}.pdf"))
            .blocking_save_file()
        else {
            return Ok(false);
        };
        fs::write(path.into_path().map_err(|e| e.to_string())?, pdf).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_register(app: AppHandle, csv: String) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        if csv.len() > 10_000_000 {
            return Err("The register exceeds the supported export size.".into());
        }
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("CSV", &["csv"])
            .set_file_name("invoice-register.csv")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        fs::write(path.into_path().map_err(|e| e.to_string())?, csv).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_legacy(app: AppHandle, data: Data<'_>) -> Result<Option<store::ImportReport>> {
    let data = Arc::clone(data.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Select your old Python invoice app folder")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let mut db = data.lock()?;
        store::import(&mut db, &path.into_path().map_err(|e| e.to_string())?).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup(app: AppHandle, data: Data<'_>) -> Result<bool> {
    let data = Arc::clone(data.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let filename = format!(
            "gst-invoice-backup-{}.sqlite",
            Local::now().format("%Y%m%d-%H%M%S")
        );
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("SQLite database", &["sqlite"])
            .set_file_name(filename)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        if path.exists() {
            return Err("Choose a new filename for this backup.".into());
        }
        data.lock()?
            .execute("VACUUM INTO ?1", params![path.to_string_lossy().as_ref()])
            .map_err(store::error)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn drive_status() -> Value {
    drive::status()
}

#[tauri::command]
async fn drive_connect(
    data: Data<'_>,
    gate: State<'_, DriveGate>,
    client_id: String,
    client_secret: String,
) -> Result<Value> {
    let data = Arc::clone(data.inner());
    let gate = Arc::clone(&gate.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate
            .try_lock()
            .map_err(|_| "Drive is busy. Try again in a moment.")?;
        drive::connect(&data, client_id, client_secret)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn drive_disconnect(data: Data<'_>, gate: State<'_, DriveGate>) -> Result<()> {
    let _guard = gate
        .0
        .try_lock()
        .map_err(|_| "Drive is busy. Try again in a moment.")?;
    drive::disconnect(&data)
}

#[tauri::command]
fn drive_retry(data: Data<'_>, id: String) -> Result<()> {
    drive::retry(&data, &id)
}

#[tauri::command]
async fn drive_link(
    data: Data<'_>,
    gate: State<'_, DriveGate>,
    id: String,
    public: bool,
) -> Result<String> {
    let data = Arc::clone(data.inner());
    let gate = Arc::clone(&gate.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate
            .try_lock()
            .map_err(|_| "Drive is busy. Try again in a moment.")?;
        drive::link(&data, &id, public)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            fs::create_dir_all(&dir)?;
            let store = Arc::new(
                store::Store::open(&dir.join("invoice-desk.sqlite"))
                    .map_err(std::io::Error::other)?,
            );
            let gate = Arc::new(Mutex::new(()));
            drive::worker(Arc::clone(&store), Arc::clone(&gate));
            app.manage(store);
            app.manage(DriveGate(gate));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_draft,
            save_draft,
            new_number,
            quote_invoice,
            validate_invoice,
            encode_qr,
            list_invoices,
            get_invoice,
            issue_invoice,
            list_customers,
            save_customer,
            delete_customer,
            export_invoice,
            export_register,
            import_legacy,
            backup,
            drive_status,
            drive_connect,
            drive_disconnect,
            drive_retry,
            drive_link
        ])
        .run(tauri::generate_context!())
        .expect("Invoicer-in could not start.");
}
