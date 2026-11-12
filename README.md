# Invoicer In

An offline-first Windows desktop invoicing app for Indian GST-registered small businesses. Built by **Kelly Label Studio**. It grew out of an invoicing workflow developed with **SSKT Logistics**. The app uses a Tauri desktop shell, a Rust core, SQLite, and an original glass interface designed for Windows.

## Windows beta
Extract the beta ZIP and run the setup executable in `Windows/`. Open **Invoicer In** from the Windows Start menu.


- New installations start in **Light** with a teal accent. Choose the computer, sun or moon in the toolbar to follow Windows, use Light, or use Dark. Existing saved choices are respected. Dark uses neutral black surfaces, white text and a purple default accent. **Settings → Appearance** offers separate Light and Dark accent presets, color pickers, hex entry and individual resets. Colors update immediately and are remembered on this PC; app colors do not change printed invoices.
- The toolbar **Glass** switch and the visual choices in Appearance make Glass and Performance explicit. Glass adds translucent panels, visible depth and a background shaped by the active accent. On supported Windows 11 systems it also enables native Desktop Acrylic across the window; other systems retain frosted app panels. **Performance** clears the native effect and uses opaque surfaces. Reduced-motion, reduced-transparency and Windows high-contrast preferences are respected.
- Reuse saved services and their default descriptions, HSN/SAC, units, rates and prices. Adjust them per invoice.
- Set a payment due date and record received payments, including partial payments. The register shows outstanding amounts and overdue invoices. Recording payments uses transaction references and prevents overpayment or duplicate submissions.
- Create domestic GST tax invoices in INR with CGST and SGST, CGST and UTGST, or IGST. Add HSN/SAC, units, discounts, percentage cess, reverse-charge status, and place of supply. The app uses decimal arithmetic and saves the PDF and invoice data together.
- Search the customer address book, apply billing and dispatch details, or save a new customer from an invoice. Issued invoices retain a snapshot of the addresses and amounts.
- **Smart ✨ sizing** is the default for new installations. It uses the available window space and Windows DPI scaling, and adjusts when resizing or moving between monitors. The starting window fits the current monitor's work area, excluding the taskbar. The toolbar shows the current percentage and opens **Settings → Appearance**, where 100%, 90%, 80%, and 75% manual overrides and Comfortable or Compact spacing remain available. Existing manual choices are preserved. Display scaling does not change invoice paper size or PDF output.
- Switch between side-by-side live preview and a full-width form. Choose the freight layout based on the corrected SSKT invoice with Container fields, ruled address boxes, and right-aligned tax totals, or use the standard A4 template. Move and resize fields, adjust table columns and page dimensions, snap to a grid, undo changes, and save named template copies.
- Export a CSV invoice register, duplicate existing invoices into drafts, and create a local workspace backup.
- Opt in to automatic Google Drive uploads of newly issued PDFs. Private uploads use a persistent retry queue. Share an individual invoice when you want anyone with its link to view it.

The freight template follows the supplied SSKT layout and uses fictional data in its editor preview. Supplier names, logos, GSTINs and contacts are configured locally. In Settings, enter bank transfer details and enable the smaller bank QR on each invoice that should carry it. It encodes text for manual bank transfer. The default freight PDF has one upper-right invoice QR. To adopt the corrected preset after saving an older custom layout, load **Freight · SSKT layout** in the layout editor and select **Save layout**.

## UPI and payment records

In **Settings → UPI payments**, enter the business UPI ID and payee name from its payment app, then save. In the invoice editor, choose **Notes → Print a payment QR → UPI**. The printed QR contains a UPI payment request with the invoice amount, number and INR currency. Scan a test invoice and confirm the recipient and amount before sharing it. For an older custom Standard template, load the current Standard A4 preset in Layout editor to add its payment QR section.

Record a payment in the invoice register after confirming receipt in the bank or UPI app. These are local bookkeeping records. Payment confirmation comes from the business’s bank or payment provider.

## Help and backups

**Help & about** shows the version, source and release pages, backup status and **Refresh Start menu shortcut**. Refresh writes the shortcut for the current Windows account and opens its folder, where it can be pinned to Start.

**Restore backup** validates a selected workspace backup, saves a safety copy of the current database, then restores it. Pending Drive uploads are paused after restore. Reconnect the matching Drive account and retry an upload explicitly when ready.

Keyboard shortcuts include **Ctrl+N** for an invoice, **Ctrl+S** to save the active form, **Ctrl+K** for search, and **Ctrl+Enter** to review and issue. The invoice editor displays save progress and highlights incomplete fields.

## GST and e-invoicing scope

The beta focuses on regular domestic tax invoices. It checks a subset of required fields, serial number format, the chosen tax treatment and the supplied state codes. It does not determine whether a business must register for GST or e-invoicing, choose tax rates, validate GSTINs against the government registry, or file returns. Composition and exempt-supply bills of supply, export invoices, GST credit/debit notes, tax classifications, and e-way bills are outside this beta.

The ordinary QR contains a short offline invoice summary. Where IRP e-invoicing applies, obtain the IRN and signed QR from your existing Invoice Registration Portal workflow. In Settings choose **Bring IRN and signed QR from my IRP workflow**, then add both values when issuing an applicable B2B invoice. The app embeds the supplied QR and displays the IRN. It checks input format and does not verify the digital signature or register documents with an IRP. Review the IRP response against the final invoice before issue. See [CBIC Rule 46](https://taxinformation.cbic.gov.in/content-page/explore-rules/1000136/1000001) and the [GST e-invoicing mandate](https://einvoice6.gst.gov.in/content/einvoice-mandate/).

## Run from source on Windows

1. Install stable Rust, Node.js 24, Microsoft C++ Build Tools with the **Desktop development with C++** workload, and Microsoft Edge WebView2. See [Tauri’s Windows prerequisites](https://v2.tauri.app/start/prerequisites/).
2. In PowerShell, open the project folder and run the commands below.

```powershell
npm ci
npm test
npm run tauri -- dev
```

Build a Windows x64 installer with `npm run tauri -- build`. The setup executable is in `src-tauri/target/release/bundle/nsis/`. The GitHub workflow runs the JavaScript and Rust checks, then attaches the installer to the build. A version tag creates a **draft prerelease** after a successful build.

## Configure Google Drive

1. In your Google Cloud project, enable the Google Drive API and configure the OAuth consent screen. If the app is in testing, add the Google account you want to use as a test user.
2. Create an OAuth client of type **Desktop app**. In Invoicer In, open **Settings → Google Drive** and enter the desktop client ID and secret there.
3. Select **Connect Google Drive**, then grant access in the system browser. Once connected, enable **Automatically upload newly issued invoices** and save the settings.
4. Issue a fictional test invoice, check that it reaches **Uploaded** in the register, and check the file's permissions in Drive. **Drive link** copies the existing URL. **Share** explicitly changes the selected file to anyone-with-the-link read access. Remove that permission in Drive to revoke it.

The app uses Google's `drive.file` scope, PKCE, and a loopback callback. It keeps the refresh token and desktop OAuth client details in Windows Credential Manager. The local database and backups contain invoice records and may contain Drive file IDs, so store them as business records. Google OAuth projects in external Testing mode can require periodic reconnects. See [Google's Desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app).

## Migrate from the Python app

In **Settings → Import from Python**, select the folder containing `invoices/`, `clients/`, and, if present, `pdfs/` and `settings.json`. Import reads from the original folder, deduplicates invoice numbers by financial year, preserves existing PDFs when present, and reads the old next-number setting for the current financial year. Imported invoices appear in the register and can be duplicated into a new draft. The old settings can populate an empty supplier profile. Google credentials and Python layout settings are excluded. Reapply the logo and adjust the layout in the new editor.

## Beta verification

Use fictional records for these checks before distributing a release.

- Issue one intrastate invoice and one interstate invoice. Confirm taxes and financial-year numbering against a worked example.
- Create a customer with separate billing and dispatch details, issue a test invoice, then edit the customer. Export the old PDF and verify it still shows the original details.
- Test a small Windows screen, the Form and Preview tabs, long addresses, a multipage invoice, and dragging and resizing the template. Compare the printed result against the business's approved template.
- Import a redacted v13 folder twice. Check counts, next number, historical PDF export, and duplicate handling.
- Connect a test Drive account, disconnect the network during an upload, restart the app, and check retry, duplicate prevention, and sharing permissions.

## License

MIT for the app source. The bundled DejaVu Sans font has its own license in `web/assets/`.

The interface uses system fonts and original vector icons and CSS materials. Apple design kit templates, SF Pro, and SF Symbols are not bundled: their licenses do not grant redistribution for this Windows app. See [Apple Design Resources license](https://developer.apple.com/support/downloads/terms/apple-design-resources/Apple-Design-Resources-License-20230621-English.pdf) and [Apple font terms](https://developer.apple.com/fonts/).
