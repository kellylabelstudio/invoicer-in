use crate::invoice::{date, field, fiscal_year, quote, validate, Result};
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;

pub struct Store(pub Mutex<Connection>);

pub fn error(e: rusqlite::Error) -> String {
    format!("Local database error: {e}")
}

fn decode(raw: String) -> Result<Value> {
    serde_json::from_str(&raw).map_err(|_| "The stored record is invalid.".into())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(error)?;
        initialize(&db)?;
        Ok(Self(Mutex::new(db)))
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| "Restart the application to reopen its local data.".into())
    }
}

fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS draft (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS invoices (
                 id TEXT PRIMARY KEY, fy INTEGER NOT NULL, number TEXT NOT NULL COLLATE NOCASE,
                 day TEXT NOT NULL, data TEXT NOT NULL, pdf BLOB, total INTEGER NOT NULL,
                 legacy INTEGER NOT NULL DEFAULT 0, UNIQUE (fy, number)
             );
             CREATE TABLE IF NOT EXISTS uploads (
                 invoice TEXT PRIMARY KEY REFERENCES invoices(id), file_id TEXT,
                 status TEXT NOT NULL, message TEXT, attempts INTEGER NOT NULL DEFAULT 0,
                 next_at INTEGER NOT NULL DEFAULT 0, account TEXT
             );
             CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS payments (
                 id TEXT PRIMARY KEY, invoice TEXT NOT NULL REFERENCES invoices(id),
                 amount INTEGER NOT NULL CHECK(amount>0), day TEXT NOT NULL, data TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS payments_invoice ON payments(invoice);
             CREATE TABLE IF NOT EXISTS workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(error)?;
    Ok(())
}

pub fn settings(db: &Connection) -> Result<Value> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM settings WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(error)?;
    match raw {
        Some(value) => decode(value),
        None => Ok(json!({"seller":{}, "template":null, "irp":"review", "driveAuto":false})),
    }
}

pub fn set_settings(db: &Connection, value: &Value) -> Result<()> {
    db.execute(
        "INSERT INTO settings VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [value.to_string()],
    )
    .map_err(error)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub number: String,
    pub day: String,
    pub buyer: String,
    pub total: i64,
    pub legacy: bool,
    pub has_pdf: bool,
    pub drive_id: Option<String>,
    pub drive_status: Option<String>,
    pub drive_message: Option<String>,
    pub paid: i64,
    pub balance: i64,
    pub due_date: String,
    pub payment_status: String,
}

pub fn invoices(db: &Connection) -> Result<Vec<Summary>> {
    let mut stmt = db
        .prepare(
            "SELECT i.id, i.number, i.day, COALESCE(json_extract(i.data, '$.buyer.name'), ''),
         i.total, i.legacy, i.pdf IS NOT NULL, u.file_id, u.status, u.message,
         COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice=i.id),0),
         COALESCE(json_extract(i.data,'$.dueDate'),'')
         FROM invoices i LEFT JOIN uploads u ON u.invoice=i.id ORDER BY i.day DESC, i.rowid DESC",
        )
        .map_err(error)?;
    let rows = stmt
        .query_map([], |r| {
            let total: i64 = r.get(4)?;
            let paid: i64 = r.get(10)?;
            let due_date: String = r.get(11)?;
            let balance = (total - paid).max(0);
            let payment_status = if balance == 0 {
                "Paid"
            } else if date(&due_date).is_ok_and(|d| d < Local::now().date_naive()) {
                "Overdue"
            } else if paid > 0 {
                "Partially paid"
            } else {
                "Issued"
            };
            Ok(Summary {
                id: r.get(0)?,
                number: r.get(1)?,
                day: r.get(2)?,
                buyer: r.get(3)?,
                total: r.get(4)?,
                legacy: r.get(5)?,
                has_pdf: r.get(6)?,
                drive_id: r.get(7)?,
                drive_status: r.get(8)?,
                drive_message: r.get(9)?,
                paid,
                balance,
                due_date,
                payment_status: payment_status.into(),
            })
        })
        .map_err(error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)
}

pub fn customers(db: &Connection) -> Result<Vec<Value>> {
    let mut stmt = db
        .prepare("SELECT data FROM customers ORDER BY json_extract(data, '$.name') COLLATE NOCASE")
        .map_err(error)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(error)?;
    rows.map(|raw| decode(raw.map_err(error)?)).collect()
}

pub fn save_customer(db: &Connection, mut customer: Value) -> Result<Value> {
    if field(&customer, "name").is_empty()
        || field(&customer, "name").len() > 250
        || customer.to_string().len() > 50_000
    {
        return Err("Enter a customer name and keep the contact under 50 KB.".into());
    }
    let id = field(&customer, "id");
    let id = if id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        Uuid::parse_str(id)
            .map_err(|_| "Invalid customer ID.")?
            .to_string()
    };
    customer["id"] = json!(id);
    db.execute(
        "INSERT INTO customers VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![id, customer.to_string()],
    )
    .map_err(error)?;
    Ok(customer)
}

pub fn next_number(db: &Connection, day: &str) -> Result<String> {
    let fy = fiscal_year(date(day)?);
    let largest: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(CAST(substr(number,5) AS INTEGER)),0) FROM invoices
         WHERE fy=?1 AND upper(number) GLOB 'INV-[0-9]*' AND substr(number,5) NOT GLOB '*[^0-9]*'",
            [fy],
            |r| r.get(0),
        )
        .map_err(error)?;
    let s = settings(db)?;
    let floor = if s["legacyCounterYear"].as_i64() == Some(i64::from(fy)) {
        s["legacyCounter"].as_i64().unwrap_or(1)
    } else {
        1
    };
    let next = largest
        .checked_add(1)
        .ok_or("No invoice numbers remain in this series.")?
        .max(floor);
    Ok(format!("INV-{next:04}"))
}

pub fn issue(db: &mut Connection, invoice: &Value, pdf: Vec<u8>) -> Result<String> {
    if !pdf.starts_with(b"%PDF-") || pdf.len() > 32 * 1024 * 1024 {
        return Err("The invoice PDF is invalid or exceeds 32 MB.".into());
    }
    if invoice.to_string().len() > 5_000_000 {
        return Err("The invoice and its embedded assets exceed the supported size.".into());
    }
    let tx = db.transaction().map_err(error)?;
    let preferences = settings(&tx)?;
    if preferences["seller"] != invoice["seller"] {
        return Err("The supplier settings changed. Reopen the draft before issuing.".into());
    }
    let amounts = validate(invoice, field(&preferences, "irp"))?;
    let fy = fiscal_year(date(field(invoice, "date"))?);
    let number = field(invoice, "number");
    let id = Uuid::new_v4().to_string();
    let inserted = tx
        .execute(
            "INSERT INTO invoices(id,fy,number,day,data,pdf,total) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(fy, number) DO NOTHING",
            params![
                id,
                fy,
                number,
                field(invoice, "date"),
                invoice.to_string(),
                pdf,
                amounts.totals.total
            ],
        )
        .map_err(error)?;
    if inserted == 0 {
        return Err("That invoice number already exists in this financial year.".into());
    }
    if preferences["driveAuto"].as_bool() == Some(true) {
        tx.execute(
            "INSERT INTO uploads(invoice,status,account) VALUES(?1,'Queued',?2)",
            params![id, field(&preferences, "driveAccount")],
        )
        .map_err(error)?;
    }
    tx.commit().map_err(error)?;
    Ok(id)
}

pub fn invoice(db: &Connection, id: &str) -> Result<Value> {
    let raw = db
        .query_row("SELECT data FROM invoices WHERE id=?1", [id], |r| r.get(0))
        .map_err(error)?;
    decode(raw)
}

fn legacy_files(root: &Path, folder: &str) -> Result<Vec<std::path::PathBuf>> {
    let path = root.join(folder);
    if !path.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for item in fs::read_dir(path).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        if item.file_type().map_err(|e| e.to_string())?.is_file()
            && item.path().extension().and_then(|x| x.to_str()) == Some("json")
        {
            files.push(item.path());
        }
    }
    files.sort();
    Ok(files)
}

fn read_json(path: &Path) -> Result<Value> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 5_000_000 {
        return Err("JSON file exceeds 5 MB.".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Invalid JSON.".into())
}

fn legacy_party(old: &Value, prefix: &str) -> Value {
    let get = |key: &str| field(old, &format!("{prefix}_{key}"));
    let address = [get("addr1"), get("addr2")].join("\n");
    json!({
        "name":get("name"), "address":address.trim(),
        "gstin":get("gstin"), "pan":get("pan"), "state":get("state_name"), "stateCode":get("state_code")
    })
}

fn normalized_date(value: &str) -> Result<String> {
    date(value)
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(value, "%d/%m/%Y")
                .map_err(|_| "Unrecognized date.".into())
        })
        .map(|d| d.to_string())
}

fn legacy_invoice(old: &Value) -> Result<Value> {
    let items = old["items"].as_array().ok_or("Missing items.")?;
    let lines: Vec<Value> = items.iter().map(|row| {
        let rate = ["cgst", "sgst"].iter().filter_map(|key| field(row,key).parse::<rust_decimal::Decimal>().ok())
            .sum::<rust_decimal::Decimal>().normalize().to_string();
        json!({"description":field(row,"desc"),"hsn":field(row,"sac"),"quantity":field(row,"qty"),
               "unit":field(row,"unit"),"unitPrice":field(row,"unit_price"),"gstRate":rate,"cessRate":field(row,"cess")})
    }).collect();
    let pos = field(old, "place_of_supply");
    let (code, label) = pos.split_once(['-', ' ']).unwrap_or(("", pos));
    let mut invoice = json!({
        "number":field(old,"invoice_no"),"date":normalized_date(field(old,"invoice_date"))?,
        "buyer":legacy_party(old,"buyer"),"ship":legacy_party(old,"shipper"),"items":lines,
        "regime":"split","placeOfSupply":label.trim(),"placeOfSupplyCode":code.trim(),
        "reverseCharge":field(old,"reverse_charge").eq_ignore_ascii_case("yes"),
        "notes":field(old,"note"),"paymentTerms":field(old,"payment_term"),
        "order":field(old,"order_no"),"orderDate":normalized_date(field(old,"order_date")).unwrap_or_default(),"journey":field(old,"journey_no"),
        "origin":field(old,"from_place"),"destination":field(old,"to_place"),
        "container":field(old,"container_no"),"containerSize":field(old,"container_size_ft"),
        "containerType":field(old,"container_type"),"containerStatus":field(old,"container_status_le"),
        "insurance":field(old,"insurance_by"),"transactionType":field(old,"transaction_type")
    });
    invoice["legacySource"] = json!("SSKT Python v13");
    Ok(invoice)
}

#[derive(Default, Serialize)]
pub struct ImportReport {
    pub invoices: usize,
    pub customers: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

pub fn import(db: &mut Connection, root: &Path) -> Result<ImportReport> {
    let docs = legacy_files(root, "invoices")?;
    let contacts = legacy_files(root, "clients")?;
    if docs.is_empty() && contacts.is_empty() {
        return Err("Choose the folder containing the old invoices or clients directories.".into());
    }
    let mut report = ImportReport::default();
    let tx = db.transaction().map_err(error)?;
    for path in docs {
        let entry = (|| -> Result<_> {
            let old = read_json(&path)?;
            let data = legacy_invoice(&old)?;
            let number = field(&data, "number");
            if number.is_empty() {
                return Err("Missing invoice number.".into());
            }
            let day = field(&data, "date");
            let fy = fiscal_year(date(day)?);
            let total = old["total_invoice"]
                .as_f64()
                .filter(|v| v.is_finite())
                .map(|v| (v * 100.0).round() as i64)
                .or_else(|| quote(&data).ok().map(|q| q.totals.total))
                .unwrap_or(0);
            let pdf_file = root
                .join("pdfs")
                .join(path.file_stem().ok_or("Missing filename.")?)
                .with_extension("pdf");
            let pdf = fs::metadata(&pdf_file)
                .ok()
                .filter(|m| m.len() <= 32 * 1024 * 1024)
                .and_then(|_| fs::read(pdf_file).ok())
                .filter(|p| p.starts_with(b"%PDF-"));
            Ok((data, fy, total, pdf))
        })();
        match entry {
            Ok((data, fy, total, pdf)) => {
                let count = tx.execute(
                    "INSERT INTO invoices(id,fy,number,day,data,pdf,total,legacy) VALUES(?1,?2,?3,?4,?5,?6,?7,1)
                     ON CONFLICT(fy, number) DO NOTHING",
                    params![Uuid::new_v4().to_string(), fy, field(&data,"number"), field(&data,"date"), data.to_string(), pdf, total],
                ).map_err(error)?;
                report.invoices += count;
                report.skipped += 1 - count;
            }
            Err(message) => {
                report.skipped += 1;
                report.warnings.push(format!(
                    "{} — {message}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
        }
    }
    for path in contacts {
        match read_json(&path) {
            Ok(old) => {
                let buyer = legacy_party(&old, "buyer");
                let name = field(&buyer, "name");
                let label = if name.is_empty() {
                    path.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                } else {
                    name.to_string()
                };
                let existing: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM customers WHERE json_extract(data,'$.name')=?1 COLLATE NOCASE
                     AND COALESCE(json_extract(data,'$.billing.address'),'')=?2
                     AND COALESCE(json_extract(data,'$.billing.gstin'),'')=?3
                     AND COALESCE(json_extract(data,'$.shipping.address'),'')=?4)",
                    params![label, field(&buyer,"address"), field(&buyer,"gstin"), field(&legacy_party(&old,"shipper"),"address")],
                    |r| r.get(0)).map_err(error)?;
                if existing {
                    report.skipped += 1;
                } else {
                    save_customer(
                        &tx,
                        json!({"name":label,"billing":buyer,"shipping":legacy_party(&old,"shipper")}),
                    )?;
                    report.customers += 1;
                }
            }
            Err(message) => {
                report.skipped += 1;
                report.warnings.push(format!(
                    "{} — {message}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
        }
    }
    if let Ok(old) = read_json(&root.join("settings.json")) {
        let mut s = settings(&tx)?;
        if let Some(n) = old["next_counter"]
            .as_i64()
            .filter(|n| *n > 0 && *n <= 999_999_999_999)
        {
            let year = i64::from(fiscal_year(Local::now().date_naive()));
            let current = if s["legacyCounterYear"].as_i64() == Some(year) {
                s["legacyCounter"].as_i64().unwrap_or(1)
            } else {
                1
            };
            s["legacyCounter"] = json!(current.max(n));
            s["legacyCounterYear"] = json!(year);
        }
        if field(&s["seller"], "name").is_empty() {
            s["seller"] = json!({"name":field(&old,"company_name"),"address":field(&old,"registered_office"),
                                 "gstin":field(&old,"gstin"),"pan":field(&old,"pan"),"website":field(&old,"website"),"tagline":field(&old,"tagline"),
                                 "state":field(&old,"state"),"stateCode":field(&old,"state_code")});
        }
        set_settings(&tx, &s)?;
    }
    tx.commit().map_err(error)?;
    Ok(report)
}

pub fn services(db: &Connection) -> Result<Vec<Value>> {
    let mut stmt = db
        .prepare(
            "SELECT data FROM services ORDER BY json_extract(data,'$.description') COLLATE NOCASE",
        )
        .map_err(error)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(error)?;
    rows.map(|r| decode(r.map_err(error)?)).collect()
}

pub fn save_service(db: &Connection, mut service: Value) -> Result<Value> {
    if field(&service, "description").is_empty() || service.to_string().len() > 10_000 {
        return Err("Add a service description and keep the entry under 10 KB.".into());
    }
    service["quantity"] = json!("1");
    quote(&json!({"regime":"igst","items":[service.clone()]}))?;
    let id = if field(&service, "id").is_empty() {
        Uuid::new_v4()
    } else {
        Uuid::parse_str(field(&service, "id")).map_err(|_| "Invalid service ID.")?
    };
    service["id"] = json!(id.to_string());
    db.execute(
        "INSERT INTO services VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        params![id.to_string(), service.to_string()],
    )
    .map_err(error)?;
    Ok(service)
}

pub fn payments(db: &Connection, invoice: &str) -> Result<Vec<Value>> {
    let mut stmt = db
        .prepare("SELECT data FROM payments WHERE invoice=?1 ORDER BY day DESC,rowid DESC")
        .map_err(error)?;
    let rows = stmt
        .query_map([invoice], |r| r.get::<_, String>(0))
        .map_err(error)?;
    rows.map(|r| decode(r.map_err(error)?)).collect()
}

pub fn save_payment(db: &mut Connection, invoice: &str, mut value: Value) -> Result<()> {
    use rust_decimal::{prelude::ToPrimitive, Decimal};
    use std::str::FromStr;
    let id = Uuid::parse_str(field(&value, "id"))
        .map_err(|_| "A payment needs a valid reference ID.")?;
    let input = field(&value, "amount");
    if input.is_empty() || !input.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err("Enter the payment amount in rupees.".into());
    }
    let amount = Decimal::from_str(input).map_err(|_| "Enter a valid payment amount.")?;
    if amount <= Decimal::ZERO
        || amount.scale() > 2
        || amount > Decimal::from(1_000_000_000_000_i64)
    {
        return Err("Use a positive payment amount with up to two decimal places.".into());
    }
    let paise = (amount * Decimal::from(100))
        .to_i64()
        .ok_or("Payment amount is too large.")?;
    let day = date(field(&value, "date"))?;
    if day > Local::now().date_naive() {
        return Err("Record a payment after it has been received.".into());
    }
    if !matches!(
        field(&value, "method"),
        "UPI" | "Bank transfer" | "Cash" | "Other"
    ) || value.to_string().len() > 2_000
    {
        return Err("Choose a payment method and keep the note under 2 KB.".into());
    }
    value["id"] = json!(id.to_string());
    value["invoice"] = json!(invoice);
    value["amount"] = json!(amount.normalize().to_string());
    value["paise"] = json!(paise);
    let tx = db.transaction().map_err(error)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT data FROM payments WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    if let Some(existing) = existing {
        if decode(existing)? == value {
            return Ok(());
        }
        return Err(
            "That payment reference has already been used. Reopen the payment form.".into(),
        );
    }
    let total: i64 = tx
        .query_row("SELECT total FROM invoices WHERE id=?1", [invoice], |r| {
            r.get(0)
        })
        .map_err(error)?;
    let paid: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice=?1",
            [invoice],
            |r| r.get(0),
        )
        .map_err(error)?;
    if paise > total - paid {
        return Err("The payment exceeds the outstanding invoice amount.".into());
    }
    tx.execute(
        "INSERT INTO payments(id,invoice,amount,day,data) VALUES(?1,?2,?3,?4,?5)",
        params![
            id.to_string(),
            invoice,
            paise,
            day.to_string(),
            value.to_string()
        ],
    )
    .map_err(error)?;
    tx.commit().map_err(error)?;
    Ok(())
}

pub fn last_backup(db: &Connection) -> Result<Option<String>> {
    db.query_row(
        "SELECT value FROM workspace_meta WHERE key='lastBackup'",
        [],
        |r| r.get(0),
    )
    .optional()
    .map_err(error)
}

pub fn backup_to(db: &Connection, path: &Path) -> Result<()> {
    if path.exists() {
        return Err("Choose a new filename for this backup.".into());
    }
    db.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
        .map_err(error)?;
    db.execute("INSERT INTO workspace_meta VALUES('lastBackup',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [Local::now().to_rfc3339()]).map_err(error)?;
    Ok(())
}

fn copy_database(source: &Connection, destination: &mut Connection) -> Result<()> {
    use rusqlite::backup::{Backup, StepResult};
    let backup = Backup::new(source, destination).map_err(error)?;
    match backup.step(-1).map_err(error)? {
        StepResult::Done => Ok(()),
        _ => Err("The backup is busy. Close the other program using it and try again.".into()),
    }
}

pub fn restore_from(db: &mut Connection, path: &Path, safety: &Path) -> Result<()> {
    use rusqlite::OpenFlags;
    let source =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
    let health: String = source
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(error)?;
    if health != "ok" {
        return Err("This backup did not pass its integrity check.".into());
    }
    for table in ["settings", "draft", "customers", "invoices", "uploads"] {
        let exists: bool = source
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(error)?;
        if !exists {
            return Err("Select a workspace backup created by Invoicer In.".into());
        }
    }
    let extras: i64 = source
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('trigger','view')",
            [],
            |r| r.get(0),
        )
        .map_err(error)?;
    if extras != 0 {
        return Err("This database contains unsupported custom schema objects.".into());
    }
    let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut candidate = Connection::open(staging.path().join("workspace.sqlite")).map_err(error)?;
    copy_database(&source, &mut candidate)?;
    initialize(&candidate)?;
    // Exercise the schema and JSON before creating a safety copy or changing live data.
    let mut preferences = settings(&candidate)?;
    customers(&candidate)?;
    services(&candidate)?;
    invoices(&candidate)?;
    let foreign_errors: i64 = candidate
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .map_err(error)?;
    if foreign_errors != 0 {
        return Err("The backup contains inconsistent invoice records.".into());
    }
    preferences["driveAuto"] = json!(false);
    set_settings(&candidate, &preferences)?;
    candidate.execute("UPDATE uploads SET status='Paused',message='Restored backup. Reconnect Drive before uploading.' WHERE status IN ('Queued','Retrying','Uploading','Failed')",[]).map_err(error)?;
    backup_to(db, safety)?;
    copy_database(&candidate, db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issued_invoice_is_unique_by_financial_year_and_keeps_contact_snapshot() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut db = store.lock().unwrap();
        let supplier =
            json!({"name":"Example Supplier","address":"Sample Road","gstin":"27ABCDE1234F1Z5"});
        set_settings(
            &db,
            &json!({"seller":supplier,"irp":"notRequired","driveAuto":false}),
        )
        .unwrap();
        let buyer = json!({"name":"Example Buyer","address":"Original billing address","state":"Maharashtra","stateCode":"27"});
        let mut saved =
            save_customer(&db, json!({"name":"Example Buyer","billing":buyer})).unwrap();
        let mut record = json!({
            "seller":supplier,"buyer":buyer,"number":"INV-0001","date":"2026-11-04","placeOfSupply":"Maharashtra",
            "placeOfSupplyCode":"27","regime":"split","items":[{"description":"Freight","hsn":"996511","unit":"NOS",
            "quantity":"1","unitPrice":"100","gstRate":"18"}]
        });
        let id = issue(&mut db, &record, b"%PDF-test".to_vec()).unwrap();
        assert_eq!(next_number(&db, "2026-11-04").unwrap(), "INV-0002");
        assert!(issue(&mut db, &record, b"%PDF-test".to_vec()).is_err());
        saved["billing"]["address"] = json!("Updated address");
        save_customer(&db, saved).unwrap();
        assert_eq!(
            invoice(&db, &id).unwrap()["buyer"]["address"],
            "Original billing address"
        );
        record["date"] = json!("2027-04-01");
        assert!(issue(&mut db, &record, b"%PDF-test".to_vec()).is_ok());
    }

    #[test]
    fn imports_legacy_invoice_pdf_and_contact_once() {
        let root = std::env::temp_dir().join(format!("invoice-import-{}", Uuid::new_v4()));
        for folder in ["invoices", "clients", "pdfs"] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        let record = json!({
            "invoice_no":"INV-0012","invoice_date":"04/11/2026","buyer_name":"Example Buyer","buyer_addr1":"Sample street",
            "shipper_name":"Warehouse","shipper_addr1":"Dispatch street","total_invoice":118.0,
            "items":[{"desc":"Freight","sac":"996511","qty":"1","unit":"NOS","unit_price":"100","cgst":"9","sgst":"9"}]
        });
        fs::write(root.join("invoices/INV-0012.json"), record.to_string()).unwrap();
        fs::write(root.join("clients/Buyer.json"), record.to_string()).unwrap();
        fs::write(root.join("pdfs/INV-0012.pdf"), b"%PDF-test").unwrap();
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut db = store.lock().unwrap();
        let first = import(&mut db, &root).unwrap();
        let second = import(&mut db, &root).unwrap();
        assert_eq!((first.invoices, first.customers, first.skipped), (1, 1, 0));
        assert_eq!(
            (second.invoices, second.customers, second.skipped),
            (0, 0, 2)
        );
        let records = invoices(&db).unwrap();
        assert_eq!(
            (records[0].total, records[0].has_pdf, records[0].legacy),
            (11_800, true, true)
        );
        assert_eq!(next_number(&db, "2026-11-04").unwrap(), "INV-0013");
        assert_eq!(
            customers(&db).unwrap()[0]["shipping"]["address"],
            "Dispatch street"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod workflow_tests {
    use super::*;
    fn sample_invoice(db: &mut Connection) -> String {
        let seller = json!({"name":"Demo","address":"Demo road","gstin":"27ABCDE1234F1Z5"});
        set_settings(
            db,
            &json!({"seller":seller,"irp":"notRequired","driveAuto":false}),
        )
        .unwrap();
        issue(db,&json!({"seller":seller,"buyer":{"name":"Buyer","address":"Demo","state":"Maharashtra","stateCode":"27"},
          "date":"2020-01-01","dueDate":"2020-02-01","number":"INV-0001","placeOfSupply":"Maharashtra","placeOfSupplyCode":"27","regime":"split",
          "items":[{"description":"Service","hsn":"996511","unit":"NOS","quantity":"1","unitPrice":"100","gstRate":"18"}]}),b"%PDF-demo".to_vec()).unwrap()
    }
    #[test]
    fn payments_are_idempotent_exact_and_cannot_overpay() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut db = store.lock().unwrap();
        let invoice = sample_invoice(&mut db);
        let mut payment = json!({"id":Uuid::new_v4().to_string(),"amount":"50.25","date":"2020-01-01","method":"UPI","reference":"demo"});
        save_payment(&mut db, &invoice, payment.clone()).unwrap();
        save_payment(&mut db, &invoice, payment.clone()).unwrap();
        let row = &invoices(&db).unwrap()[0];
        assert_eq!(
            (row.paid, row.balance, row.payment_status.as_str()),
            (5025, 6775, "Overdue")
        );
        payment["amount"] = json!("60");
        assert!(save_payment(&mut db, &invoice, payment.clone()).is_err());
        payment["id"] = json!(Uuid::new_v4().to_string());
        payment["amount"] = json!("67.76");
        assert!(save_payment(&mut db, &invoice, payment.clone()).is_err());
        payment["amount"] = json!("67.75");
        save_payment(&mut db, &invoice, payment).unwrap();
        assert_eq!(invoices(&db).unwrap()[0].payment_status, "Paid");
        assert_eq!(payments(&db, &invoice).unwrap().len(), 2);
    }
    #[test]
    fn backup_restore_keeps_records_and_saves_the_replaced_workspace() {
        let root = std::env::temp_dir().join(format!("invoicer-restore-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut db = store.lock().unwrap();
        let invoice = sample_invoice(&mut db);
        save_service(
            &db,
            json!({"description":"Saved service","unitPrice":"12.50","gstRate":"18"}),
        )
        .unwrap();
        let payment = json!({"id":Uuid::new_v4().to_string(),"amount":"10","date":"2020-01-01","method":"Cash"});
        save_payment(&mut db, &invoice, payment).unwrap();
        db.execute(
            "INSERT INTO uploads(invoice,status,account) VALUES(?1,'Queued','demo')",
            [&invoice],
        )
        .unwrap();
        backup_to(&db, &root.join("backup.sqlite")).unwrap();
        let mut changed = settings(&db).unwrap();
        changed["seller"]["name"] = json!("Changed supplier");
        set_settings(&db, &changed).unwrap();
        restore_from(
            &mut db,
            &root.join("backup.sqlite"),
            &root.join("safety.sqlite"),
        )
        .unwrap();
        assert_eq!(settings(&db).unwrap()["seller"]["name"], "Demo");
        assert_eq!(services(&db).unwrap().len(), 1);
        assert_eq!(payments(&db, &invoice).unwrap().len(), 1);
        let status: String = db
            .query_row("SELECT status FROM uploads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "Paused");
        assert_eq!(
            settings(&Connection::open(root.join("safety.sqlite")).unwrap()).unwrap()["seller"]
                ["name"],
            "Changed supplier"
        );
        let invalid = Connection::open(root.join("unrelated.sqlite")).unwrap();
        invalid.execute_batch("CREATE TABLE unrelated(a);").unwrap();
        drop(invalid);
        assert!(restore_from(
            &mut db,
            &root.join("unrelated.sqlite"),
            &root.join("unused.sqlite")
        )
        .is_err());
        assert!(!root.join("unused.sqlite").exists());
        assert_eq!(invoices(&db).unwrap().len(), 1);
        drop(db);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restores_a_backup_from_before_services_and_payments_existed() {
        let root = std::env::temp_dir().join(format!("invoicer-old-backup-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut db = store.lock().unwrap();
        sample_invoice(&mut db);
        backup_to(&db, &root.join("old.sqlite")).unwrap();
        let old = Connection::open(root.join("old.sqlite")).unwrap();
        old.execute_batch("DROP TABLE payments; DROP TABLE services; DROP TABLE workspace_meta;")
            .unwrap();
        drop(old);
        restore_from(
            &mut db,
            &root.join("old.sqlite"),
            &root.join("safety.sqlite"),
        )
        .unwrap();
        assert_eq!(invoices(&db).unwrap().len(), 1);
        assert!(services(&db).unwrap().is_empty());
        assert!(last_backup(&db).unwrap().is_none());
        drop(db);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}
