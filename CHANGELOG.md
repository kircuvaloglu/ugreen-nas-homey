# Changelog

## v1.4.0 – 2026-09-07 (not yet published)

### 🐛 Bug Fix: Login Failed on Accounts With Two-Factor Authentication
- Reported by @byackee1 (post #56) on a UNAS 6800 Pro: *"Login failed: The client is not compatible with the firmware, please update the client!"*. Despite the wording this is not a firmware or version problem — UGOS answers with code `9406` when the login payload sets `otp: false` while the account has 2FA enabled. The same misleading error was diagnosed by the community UGOS reverse-engineering work ([home-assistant_ugreen-nas#247](https://github.com/Tom-Bom-badil/home-assistant_ugreen-nas/pull/247)).
- The login now opts into the OTP handshake (`otp: true`). Accounts without 2FA are unaffected and still receive their token straight away.
- Accounts with 2FA get a second pairing step asking for the current authenticator code. The code is confirmed with `trust: true` against a generated `UG-Client-Id`, which registers this app as a trusted device on the NAS, so the code is only ever needed once. The client id is stored on the device and sent on every later login.
- If the login fails with `9406` anyway, the error message now points at two-factor authentication instead of repeating the misleading firmware text.

### ✨ New Feature: Repair Flow
- Devices can now be reconnected from *Device settings → Repair* instead of being deleted and added again (Flows, Insights history and device names are kept). Useful after a password change, or when 2FA is switched on for an account that was paired earlier. The form is pre-filled with the known address and username; the polling client is refreshed immediately afterwards.
- A device that stops working because 2FA was enabled now says so, and points to Repair, instead of only reporting a failed login.

### ✨ New Feature: "A backup task is running" Flow Condition
- Adds the check @wepa originally asked for (post #52): a condition card that reads the Backup Center tasks from the NAS (`/ugreen/v2/web/syncbackup/task/list`) and reports whether any task is currently running, so a Flow can postpone a shutdown until the backup has finished. Results are cached for a few seconds so several cards in one Flow only cause a single request.
- The activity-threshold cards from v1.3.0 stay available as a fallback for setups where the Backup Center is not used. Correction to the note in v1.3.0: UGOS *does* expose backup task state; the endpoints had simply been missed in the earlier research.

### 🧹 Housekeeping
- Requests to the NAS no longer identify this app as `HomeAssistant/2026.1.0 aiohttp/...` (a leftover from the original API research) but as `Homey-UgreenNAS`.
- Added the missing `<meta charset="utf-8">` to the pairing views so non-ASCII characters render correctly.

## v1.3.0 – 2026-07-16 (not yet published)

### ✨ New Feature: Activity-Based "And" Flow Condition Cards
- Added three condition cards, requested by @wepa (post #52) to avoid shutting the NAS down while a backup is still running:
  - **Disk activity is (not) above X kB/s** — combined read + write rate
  - **Network activity is (not) above X kB/s** — combined download + upload rate
  - **CPU usage is (not) above X %**
- Note: UGOS's local API does not expose a documented "backup task running" state (checked the HA integration, UgreenNASAdmin and NAS Monitor reverse-engineering projects), so these cards use live activity metrics as a reliable proxy: a running backup shows up as sustained disk and/or network throughput. All three cards support Homey's native invert toggle ("is / isn't").

## v1.2.9 – 2026-07-16

### ✨ New Feature: "Shut down the NAS" and "Reboot the NAS" Flow Action Cards
- Added two "Then" flow cards so the NAS can be powered off or rebooted from Flows (e.g. shut the NAS down when you go to sleep). Requested by @wepa in the community topic (post #50). The cards use the same API calls as the existing device buttons.

## v1.2.8 – 2026-07-16

### 🐛 Bug Fix: Pairing Failed on Homey Self-Hosted Server (`Could not load script: /js/homey.pair.js`)
- Follow-up to v1.2.7: even with the correct `data-origin="pair"`, the `/homey.js` include made the web client try to fetch `/js/homey.pair.js`, which is not served on Homey Self-Hosted Server setups — so the pairing view still never initialized there (reported by @Alex_Bloemendal, diagnostics `c42d973e-8cd1-4c13-bfd2-39764aa0240c`).
- Per the current Apps SDK documentation, custom **pair** views must not include `/homey.js` at all: the `Homey` object is injected globally by every client (the include is only for app *settings* pages). Removed the include; the view now uses the injected global directly, with the existing `onHomeyReady`/poll fallback kept for older clients, plus a last-chance re-check when the user presses "Login & Add Device".

## v1.2.7 – 2026-07-12

### 🐛 Bug Fix: Pairing Screen Failed to Load on my.homey.app (`Could not load script: /js/homey.views.js`)
- The pairing view included the Homey SDK bootstrap with `data-origin="views"` instead of the correct `data-origin="pair"`. The my.homey.app web client uses this attribute to decide which SDK bundle to load (`/js/homey.<origin>.js`), so it tried to fetch the non-existent `/js/homey.views.js` and the pairing screen never initialized. Reported by @Alex_Bloemendal in the community topic (post #47).
- Added a fallback for pairing environments that inject the `Homey` object as a global instead of calling `onHomeyReady`, so the view initializes in both the web and mobile app clients.

## v1.2.5 – 2026-07-09

### 🐛 Bug Fix: Stuck / Duplicate Pairing Sessions on Self-Hosted & Reverse-Proxied Homey Setups
- The pairing screen (`login.html`) called `Homey.*` methods before the Homey SDK had actually finished initializing. On slower or reverse-proxied connections (e.g. self-hosted Homey behind a custom domain/Nginx Proxy Manager), this could throw silently and leave the pairing session stuck open on the backend, surfacing later as `Error 409: Another pair session is already active` or `Invalid Pair Session ID`. Rewired the view to use the standard `onHomeyReady(Homey)` entry point, and added a 20s client-side timeout so the "Connecting..." button can no longer stay disabled forever if a request hangs.

### ⚡ Robustness: Reuse HTTP Connections to the NAS
- `UgreenClient` was creating a brand new `undici` Agent (and TCP/TLS handshake) on every single API call, including every 10-second poll. The Agent is now created once and reused for the lifetime of the client, reducing connection overhead — especially relevant for NAS instances behind a reverse proxy — and is properly closed when a device is deleted or its settings change.

## v1.2.4 – 2026-06-05

### 🐛 Bug Fix: Pairing Screen Loading Failure
- Fixed the `unknown_error_getting_file` error on the pairing screen by updating the `homey.js` SDK script path from a relative path (`../../../homey.js`) to the absolute path (`/homey.js`). This ensures the pairing wizard loads successfully across all Homey environments, custom domains, and proxies.

### ⚡ Robustness: Improved Login Authentication
- Enhanced the RSA public key parsing logic in `UgreenClient.js` to automatically detect and handle different key formats (raw PEM, base64-encoded PEM, and raw DER keys). This prevents potential authentication failures and makes the login process highly reliable.

## v1.2.3 – 2026-06-01

### 🐛 Bug Fix: Self-Signed Certificate Error on Login
- Fixed a `Connection failed: fetch failed – self-signed certificate` error that occurred when the Homey instance runs inside Docker alongside Nginx Proxy Manager (or any reverse proxy that wraps connections with TLS).
- The `undici` HTTP Agent now always uses `rejectUnauthorized: false`, making connections resilient to self-signed certificates regardless of whether HTTP or HTTPS is selected. Previously, this option was only applied in explicit HTTPS mode.

### ✨ New: HTTPS Support Toggle
- Added a **"Use HTTPS (self-signed cert OK)"** checkbox to the device pairing screen (`Add Ugreen NAS`).
- Added a matching **"Use HTTPS"** toggle to device settings, allowing users to switch protocols after pairing without removing and re-adding the device.
- When a certificate-related error is detected during login, the UI now shows a helpful tip guiding the user to enable the HTTPS toggle.

---

## v1.2.2 – 2026-05-20

- Minor improvements and stability fixes.

## v1.2.1

- Fan speed dynamic capabilities (chassis and CPU fans).
- Storage pool usage sensors.

## v1.2.0

- Initial release with CPU, memory, temperature, network monitoring.
- Reboot and shutdown buttons.
