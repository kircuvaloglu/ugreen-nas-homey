# Changelog

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
