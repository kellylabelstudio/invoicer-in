use crate::invoice::Result;
use crate::store::{self, Store};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::{Client, Response};
use reqwest::Url;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

#[derive(Serialize, Deserialize)]
struct Credentials {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    account: String,
    email: String,
}

#[cfg(windows)]
fn vault() -> Result<keyring::Entry> {
    keyring::Entry::new("com.kellylabelstudio.gstinvoicedesk", "Google Drive")
        .map_err(|_| "Windows Credential Manager is unavailable.".into())
}

#[cfg(windows)]
fn credentials() -> Result<Credentials> {
    let raw = vault()?
        .get_password()
        .map_err(|_| "Connect Google Drive in Settings.")?;
    serde_json::from_str(&raw).map_err(|_| "Reconnect Google Drive in Settings.".into())
}

#[cfg(not(windows))]
fn credentials() -> Result<Credentials> {
    Err("Drive credentials require Windows Credential Manager.".into())
}

#[cfg(windows)]
fn save_credentials(creds: &Credentials) -> Result<()> {
    let raw = serde_json::to_string(creds).map_err(|_| "Cannot encode Drive credentials.")?;
    vault()?
        .set_password(&raw)
        .map_err(|_| "Cannot save to Windows Credential Manager.".into())
}

#[cfg(not(windows))]
fn save_credentials(_: &Credentials) -> Result<()> {
    Err("Drive credentials require Windows Credential Manager.".into())
}

pub fn status() -> Value {
    credentials().map_or_else(
        |_| json!({"connected":false}),
        |c| json!({"connected":true,"email":c.email,"account":c.account}),
    )
}

pub fn disconnect(db: &Store) -> Result<()> {
    #[cfg(windows)]
    match vault()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("Cannot remove Drive credentials.".into()),
    }
    let db = db.lock()?;
    let mut s = store::settings(&db)?;
    s["driveAuto"] = json!(false);
    store::set_settings(&db, &s)
}

fn client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialise Google Drive networking.".into())
}

fn google(response: reqwest::Result<Response>, context: &str) -> Result<Response> {
    let response =
        response.map_err(|_| format!("{context} failed. Check your network and try again."))?;
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(format!(
            "{context} failed (Google returned HTTP {}).",
            response.status().as_u16()
        ))
    }
}

fn json_body(response: Response) -> Result<Value> {
    response
        .json()
        .map_err(|_| "Google returned an unexpected response.".into())
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn callback(listener: TcpListener, state: &str) -> Result<String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "Cannot listen for Google sign-in.")?;
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(_) => return Err("Google sign-in connection failed.".into()),
        };
        stream
            .set_nonblocking(false)
            .map_err(|_| "Cannot read Google sign-in.")?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut line = Vec::new();
        use std::io::Read;
        let _ = BufReader::new(&mut stream)
            .take(16_384)
            .read_until(b'\n', &mut line);
        let target = String::from_utf8_lossy(&line);
        let target = target
            .strip_prefix("GET ")
            .and_then(|v| v.split_ascii_whitespace().next());
        let result = target
            .filter(|p| p.starts_with("/?"))
            .and_then(|p| Url::parse(&format!("http://127.0.0.1{p}")).ok())
            .and_then(|url| {
                let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
                if q.get("state").map(String::as_str) != Some(state) {
                    return None;
                }
                Some(
                    q.get("code")
                        .filter(|v| !v.is_empty())
                        .cloned()
                        .ok_or_else(|| "Google sign-in was declined.".to_string()),
                )
            });
        let (status, text) = if result.as_ref().is_some_and(|r| r.is_ok()) {
            ("200 OK", "Google sign-in received. Return to Invoicer In.")
        } else {
            ("400 Bad Request", "Google sign-in could not be completed.")
        };
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
        if let Some(result) = result {
            return result;
        }
    }
    Err("Google sign-in timed out. Try connecting again.".into())
}

pub fn connect(store: &Store, client_id: String, client_secret: String) -> Result<Value> {
    let client_id = client_id.trim().to_owned();
    let client_secret = client_secret.trim().to_owned();
    if !client_id.ends_with(".apps.googleusercontent.com") || client_secret.is_empty() {
        return Err(
            "Enter the client ID and client secret from a Google Desktop OAuth client.".into(),
        );
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Cannot open a local Google sign-in callback.")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Cannot open a local Google sign-in callback.")?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/");
    let verifier = random();
    let state = random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|_| "Invalid Google URL.")?;
    url.query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent select_account")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    open::that(url.as_str()).map_err(|_| "Cannot open the default browser.")?;
    let code = callback(listener, &state)?;
    let client = client()?;
    let token = json_body(google(
        client
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("client_id", &client_id),
                ("client_secret", &client_secret),
                ("redirect_uri", &redirect),
                ("code_verifier", &verifier),
            ])
            .send(),
        "Google sign-in",
    )?)?;
    let access = token["access_token"]
        .as_str()
        .ok_or("No Google access token was returned.")?;
    let refresh = token["refresh_token"]
        .as_str()
        .ok_or("No Google refresh token was returned.")?;
    let user = json_body(google(
        client
            .get(format!("{API}/about"))
            .query(&[("fields", "user(permissionId,emailAddress)")])
            .bearer_auth(access)
            .send(),
        "Drive account check",
    )?)?;
    let account = user["user"]["permissionId"]
        .as_str()
        .filter(|x| !x.is_empty())
        .ok_or("No Google Drive account ID was returned.")?;
    let creds = Credentials {
        client_id,
        client_secret,
        refresh_token: refresh.into(),
        account: account.into(),
        email: user["user"]["emailAddress"].as_str().unwrap_or("").into(),
    };
    save_credentials(&creds)?;
    let db = store.lock()?;
    let mut s = store::settings(&db)?;
    if s["driveAccount"].as_str() != Some(account) {
        s["driveAuto"] = json!(false);
    }
    s["driveAccount"] = json!(account);
    store::set_settings(&db, &s)?;
    Ok(status())
}

fn access(client: &Client, creds: &Credentials) -> Result<String> {
    let value = json_body(google(
        client
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &creds.refresh_token),
                ("client_id", &creds.client_id),
                ("client_secret", &creds.client_secret),
            ])
            .send(),
        "Drive sign-in refresh",
    )?)?;
    value["access_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "No Google access token was returned.".into())
}

struct Job {
    invoice: String,
    id: Option<String>,
    number: String,
    pdf: Vec<u8>,
    attempts: i64,
    account: String,
}

fn take_job(store: &Store, account: &str) -> Result<Option<Job>> {
    let mut db = store.lock()?;
    let tx = db.transaction().map_err(store::error)?;
    let now = Utc::now().timestamp();
    let job = tx
        .query_row(
            "SELECT u.invoice,u.file_id,i.number,i.pdf,u.attempts,COALESCE(u.account,'')
         FROM uploads u JOIN invoices i ON i.id=u.invoice
         WHERE u.status IN ('Queued','Retrying','Uploading') AND u.next_at<=?1 AND u.account=?2
         ORDER BY u.next_at,i.rowid LIMIT 1",
            params![now, account],
            |r| {
                Ok(Job {
                    invoice: r.get(0)?,
                    id: r.get(1)?,
                    number: r.get(2)?,
                    pdf: r.get(3)?,
                    attempts: r.get(4)?,
                    account: r.get(5)?,
                })
            },
        )
        .optional()
        .map_err(store::error)?;
    if let Some(job) = &job {
        tx.execute(
            "UPDATE uploads SET status='Uploading',next_at=?2 WHERE invoice=?1",
            params![job.invoice, now + 240],
        )
        .map_err(store::error)?;
    }
    tx.commit().map_err(store::error)?;
    Ok(job)
}

fn upload(store: &Store, job: &Job) -> Result<()> {
    let creds = credentials()?;
    if creds.account != job.account {
        return Err("Reconnect the Drive account that queued this invoice.".into());
    }
    let client = client()?;
    let token = access(&client, &creds)?;
    let id = match &job.id {
        Some(value) => value.clone(),
        None => {
            let value = json_body(google(
                client
                    .get(format!("{API}/files/generateIds"))
                    .bearer_auth(&token)
                    .query(&[("count", "1"), ("space", "drive")])
                    .send(),
                "Drive file ID allocation",
            )?)?;
            let id = value["ids"][0]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or("Google returned no file ID.")?
                .to_string();
            store
                .lock()?
                .execute(
                    "UPDATE uploads SET file_id=?2 WHERE invoice=?1",
                    params![job.invoice, id],
                )
                .map_err(store::error)?;
            id
        }
    };
    let boundary = format!("invoice-{}", Uuid::new_v4());
    let filename = job.number.replace('/', "-");
    let meta = json!({"id":id,"name":format!("{filename}.pdf"),"mimeType":"application/pdf",
        "appProperties":{"invoiceDeskId":job.invoice}});
    let head = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/pdf\r\n\r\n");
    let mut body = head.into_bytes();
    body.extend_from_slice(&job.pdf);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = client
        .post(UPLOAD)
        .query(&[("uploadType", "multipart"), ("fields", "id")])
        .bearer_auth(&token)
        .header(
            "Content-Type",
            format!("multipart/related; boundary={boundary}"),
        )
        .body(body)
        .send();
    match response {
        Ok(response) if response.status() == reqwest::StatusCode::CONFLICT => {
            let old = json_body(google(
                client
                    .get(format!("{API}/files/{id}"))
                    .query(&[("fields", "appProperties,trashed")])
                    .bearer_auth(&token)
                    .send(),
                "Drive upload verification",
            )?)?;
            if old["appProperties"]["invoiceDeskId"].as_str() != Some(job.invoice.as_str())
                || old["trashed"].as_bool() != Some(false)
            {
                return Err("The reserved Drive file is unavailable.".into());
            }
        }
        other => {
            google(other, "Drive upload")?;
        }
    }
    store
        .lock()?
        .execute(
            "UPDATE uploads SET status='Uploaded',message=NULL WHERE invoice=?1",
            [&job.invoice],
        )
        .map_err(store::error)?;
    Ok(())
}

pub struct DriveGate(pub Arc<Mutex<()>>);

pub fn worker(store: Arc<Store>, gate: Arc<Mutex<()>>) {
    std::thread::spawn(move || loop {
        if let Ok(_guard) = gate.try_lock() {
            if let Ok(Some(job)) = credentials().and_then(|creds| take_job(&store, &creds.account))
            {
                if let Err(message) = upload(&store, &job) {
                    let attempts = job.attempts + 1;
                    let status = if attempts >= 5 { "Failed" } else { "Retrying" };
                    let next = Utc::now().timestamp() + (15_i64 << attempts.min(5));
                    if let Ok(db) = store.lock() {
                        let _ = db.execute("UPDATE uploads SET status=?2,message=?3,attempts=?4,next_at=?5 WHERE invoice=?1",
                                           params![job.invoice,status,message,attempts,next]);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    });
}

pub fn retry(store: &Store, invoice: &str) -> Result<()> {
    let account = credentials()?.account;
    let db = store.lock()?;
    let changed = db
        .execute(
            "UPDATE uploads SET status='Queued',message=NULL,attempts=0,next_at=0
         WHERE invoice=?1 AND account=?2 AND status IN ('Retrying','Failed')",
            params![invoice, account],
        )
        .map_err(store::error)?;
    if changed == 0 {
        return Err("This invoice has no failed upload for the connected account.".into());
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 250
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn link(store: &Store, invoice: &str, public: bool) -> Result<String> {
    let (id, account): (String, String) = store
        .lock()?
        .query_row(
            "SELECT file_id,account FROM uploads WHERE invoice=?1 AND status='Uploaded'",
            [invoice],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "This invoice has no completed Drive upload.")?;
    if !valid_id(&id) {
        return Err("Invalid Drive file ID.".into());
    }
    if public {
        let creds = credentials()?;
        if creds.account != account {
            return Err("Reconnect the Drive account that uploaded this invoice.".into());
        }
        let client = client()?;
        let access = access(&client, &creds)?;
        let url = format!("{API}/files/{id}/permissions");
        let permissions = json_body(google(
            client
                .get(&url)
                .query(&[("fields", "permissions(type,role,allowFileDiscovery)")])
                .bearer_auth(&access)
                .send(),
            "Drive permissions check",
        )?)?;
        let already = permissions["permissions"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|p| p["type"] == "anyone" && p["role"] == "reader")
        });
        if !already {
            google(
                client
                    .post(url)
                    .bearer_auth(access)
                    .json(&json!({
                        "type":"anyone","role":"reader","allowFileDiscovery":false
                    }))
                    .send(),
                "Drive link sharing",
            )?;
        }
    }
    Ok(format!("https://drive.google.com/file/d/{id}/view"))
}
