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
             );",
        )
        .map_err(error)?;
        Ok(Self(Mutex::new(db)))
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| "Restart the application to reopen its local data.".into())
    }
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
}

pub fn invoices(db: &Connection) -> Result<Vec<Summary>> {
    let mut stmt = db
        .prepare(
            "SELECT i.id, i.number, i.day, COALESCE(json_extract(i.data, '$.buyer.name'), ''),
         i.total, i.legacy, i.pdf IS NOT NULL, u.file_id, u.status, u.message
         FROM invoices i LEFT JOIN uploads u ON u.invoice=i.id ORDER BY i.day DESC, i.rowid DESC",
        )
        .map_err(error)?;
    let rows = stmt
        .query_map([], |r| {
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
