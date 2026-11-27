# Ugreen NAS for Homey

Monitor and control your UGREEN NAS locally from [Homey](https://homey.app). No cloud connection is needed.

- **Homey App Store:** https://homey.app/en-us/app/com.ugreen.nas/
- **Community topic (support & feedback):** https://community.homey.app/t/151426

## Features

- CPU usage and temperature, memory usage
- Network download / upload and disk read / write rates
- Disk temperatures (M.2, SSD, HDD), fan speeds, storage pool usage
- Reboot and shutdown buttons
- NAS Status dashboard widget
- Two-factor authentication support (Homey is registered once as a trusted device)
- Repair: reconnect a NAS from *Device settings → Repair* without removing it

### Flow cards

| Type | Card |
| --- | --- |
| Then | Shut down the NAS |
| Then | Reboot the NAS |
| And | A backup task is (not) running |
| And | Disk activity is (not) above a threshold (kB/s) |
| And | Network activity is (not) above a threshold (kB/s) |
| And | CPU usage is (not) above a threshold (%) |

## Setup

Add the device with the local IP address and port of your NAS (default `9999`) and the credentials of a local user with administrator rights. Enable **Use HTTPS** if your NAS uses HTTPS on that port or sits behind a reverse proxy; self-signed certificates are accepted.

## Development

```bash
npm install
homey app run
```

See [CHANGELOG.md](CHANGELOG.md) for the release history.
