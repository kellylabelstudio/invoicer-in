use chrono::{Datelike, NaiveDate};
use qrcode::{Color, QrCode};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::Value;
use std::str::FromStr;

pub type Result<T> = std::result::Result<T, String>;

pub fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("").trim()
}

#[derive(Default, Serialize)]
pub struct Amounts {
    pub taxable: i64,
    pub cgst: i64,
    pub sgst: i64,
    pub igst: i64,
    pub cess: i64,
    pub total: i64,
}

#[derive(Default, Serialize)]
pub struct Quote {
    pub lines: Vec<Amounts>,
    pub totals: Amounts,
}

fn decimal(row: &Value, key: &str, places: u32) -> Result<Decimal> {
    let input = field(row, key);
    if input.is_empty() {
        return Ok(Decimal::ZERO);
    }
    if !input.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        return Err(format!("{key} must be a nonnegative decimal."));
    }
    let amount = Decimal::from_str(input).map_err(|_| format!("Invalid {key}."))?;
    if amount.scale() > places || amount > Decimal::from(1_000_000_000) {
        return Err(format!(
            "{key} is too large or has too many decimal places."
        ));
    }
    Ok(amount)
}

fn paise(amount: Decimal) -> Result<i64> {
    (amount * Decimal::from(100))
        .round_dp_with_strategy(0, rust_decimal::RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
        .filter(|n| *n <= 100_000_000_000_000)
        .ok_or_else(|| "The line amount exceeds the supported limit.".into())
}

pub fn quote(invoice: &Value) -> Result<Quote> {
    let regime = field(invoice, "regime");
    if !matches!(regime, "split" | "utgst" | "igst") {
        return Err("Select an applicable GST treatment.".into());
    }
    let items = invoice["items"].as_array().ok_or("No line items.")?;
    if items.len() > 250 {
        return Err("An invoice supports up to 250 lines.".into());
    }
    let mut result = Quote::default();
    for (index, row) in items.iter().enumerate() {
        let line = (|| -> Result<Amounts> {
            let qty = decimal(row, "quantity", 3)?;
            let price = decimal(row, "unitPrice", 2)?;
            let discount = decimal(row, "discount", 2)?;
            let rate = decimal(row, "gstRate", 3)?;
            let cess_rate = decimal(row, "cessRate", 3)?;
            let taxable = paise(qty * price - discount)?;
            if qty * price < discount {
                return Err("Discount exceeds the line value.".into());
            }
            if rate > Decimal::from(100) || cess_rate > Decimal::from(100) {
                return Err("Tax rates must be between 0 and 100.".into());
            }
            let tax = |r| paise(Decimal::from(taxable) * r / Decimal::from(10_000));
            let (cgst, sgst, igst) = if regime == "igst" {
                (0, 0, tax(rate)?)
            } else {
                let half = tax(rate / Decimal::from(2))?;
                (half, half, 0)
            };
            let cess = tax(cess_rate)?;
            Ok(Amounts {
                taxable,
                cgst,
                sgst,
                igst,
                cess,
                total: taxable + cgst + sgst + igst + cess,
            })
        })()
        .map_err(|error| format!("Line {}: {error}", index + 1))?;
        result.totals.taxable += line.taxable;
        result.totals.cgst += line.cgst;
        result.totals.sgst += line.sgst;
        result.totals.igst += line.igst;
        result.totals.cess += line.cess;
        result.totals.total += line.total;
        result.lines.push(line);
    }
    if result.totals.total > 9_007_199_254_740_991 {
        return Err("Invoice total exceeds the supported precision.".into());
    }
    Ok(result)
}

pub fn fiscal_year(date: NaiveDate) -> i32 {
    if date.month() < 4 {
        date.year() - 1
    } else {
        date.year()
    }
}

pub fn date(value: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "Enter a valid invoice date.".into())
}

fn gstin(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 15
        && b[..2].iter().all(u8::is_ascii_digit)
        && b[2..7].iter().all(u8::is_ascii_uppercase)
        && b[7..11].iter().all(u8::is_ascii_digit)
        && b[11].is_ascii_uppercase()
        && b[12].is_ascii_alphanumeric()
        && b[13] == b'Z'
        && b[14].is_ascii_alphanumeric()
}

fn state_code(value: &str) -> bool {
    value.len() == 2 && value.bytes().all(|digit| digit.is_ascii_digit())
}

pub fn validate(invoice: &Value, irp: &str) -> Result<Quote> {
    let no = field(invoice, "number");
    if no.is_empty()
        || no.len() > 16
        || !no
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'/')
    {
        return Err("Invoice number must be 1–16 letters, numbers, hyphens or slashes.".into());
    }
    date(field(invoice, "date"))?;
    let seller = &invoice["seller"];
    let buyer = &invoice["buyer"];
    let pos = field(invoice, "placeOfSupplyCode");
    let seller_gstin = field(seller, "gstin");
    if field(seller, "name").is_empty()
        || field(seller, "address").is_empty()
        || !gstin(seller_gstin)
    {
        return Err("Add a supplier name, address and GSTIN in Settings.".into());
    }
    if field(buyer, "name").is_empty() || field(buyer, "address").is_empty() {
        return Err("Enter the buyer name and billing address.".into());
    }
    let buyer_gstin = field(buyer, "gstin");
    if !buyer_gstin.is_empty() && !gstin(buyer_gstin) {
        return Err("The buyer GSTIN format is invalid.".into());
    }
    if !state_code(pos) || field(invoice, "placeOfSupply").is_empty() {
        return Err("Enter the place of supply and its two-digit state/UT code.".into());
    }
    let buyer_state = field(buyer, "stateCode");
    if !state_code(buyer_state) || field(buyer, "state").is_empty() {
        return Err("Enter the buyer state or UT name and its two-digit code.".into());
    }
    let is_interstate = &seller_gstin[..2] != pos;
    if is_interstate != (field(invoice, "regime") == "igst") {
        return Err("GST treatment does not match the supplier GSTIN state and place of supply. Review the transaction before issuing.".into());
    }
    if !matches!(irp, "external" | "notRequired") {
        return Err("Select your e-invoicing workflow in Settings before issuing.".into());
    }
    if irp == "external" && !buyer_gstin.is_empty() {
        let irn = field(invoice, "irn");
        let signed_qr = field(invoice, "signedQr");
        if irn.len() != 64
            || !irn.bytes().all(|b| b.is_ascii_hexdigit())
            || signed_qr.split('.').count() != 3
            || signed_qr.split('.').any(str::is_empty)
        {
            return Err(
                "Attach the IRN and signed QR text from your Invoice Registration Portal response."
                    .into(),
            );
        }
    }
    let quote = quote(invoice)?;
    if quote.lines.is_empty() {
        return Err("Add at least one invoice item.".into());
    }
    let items = invoice["items"].as_array().ok_or("No line items.")?;
    for (index, row) in items.iter().enumerate() {
        let hsn = field(row, "hsn");
        if field(row, "description").is_empty()
            || !matches!(hsn.len(), 4 | 6 | 8)
            || !hsn.bytes().all(|b| b.is_ascii_digit())
            || decimal(row, "quantity", 3)? <= Decimal::ZERO
            || field(row, "unit").is_empty()
        {
            return Err(format!("Line {} needs a description, 4-, 6- or 8-digit HSN/SAC, positive quantity and unit.", index + 1));
        }
    }
    Ok(quote)
}

pub fn qr_matrix(payload: &str) -> Result<Vec<Vec<bool>>> {
    if payload.len() > 2953 || payload.is_empty() {
        return Err("The QR payload is empty or too large.".into());
    }
    let code = QrCode::with_error_correction_level(payload.as_bytes(), qrcode::EcLevel::L)
        .map_err(|_| "This QR payload cannot be encoded.")?;
    let width = code.width();
    Ok((0..width)
        .map(|y| (0..width).map(|x| code[(x, y)] == Color::Dark).collect())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn computes_and_rounds_split_taxes_in_paise() {
        let input = json!({"regime":"split","items":[
            {"quantity":"1.5","unitPrice":"100.00","discount":"0.05","gstRate":"18","cessRate":"1"}
        ]});
        let q = quote(&input).unwrap();
        assert_eq!(
            (
                q.totals.taxable,
                q.totals.cgst,
                q.totals.sgst,
                q.totals.cess,
                q.totals.total
            ),
            (14995, 1350, 1350, 150, 17845)
        );
    }

    #[test]
    fn rejects_invalid_money_instead_of_silently_zeroing_it() {
        assert!(quote(&json!({"regime":"igst","items":[{"quantity":"1e3"}]})).is_err());
        assert!(quote(&json!({"regime":"igst","items":[{"discount":"2"}]})).is_err());
    }

    #[test]
    fn financial_year_changes_in_april() {
        assert_eq!(fiscal_year(date("2026-03-31").unwrap()), 2025);
        assert_eq!(fiscal_year(date("2026-04-01").unwrap()), 2026);
    }
}
