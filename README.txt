This application enables you to connect and manage your Ugreen NAS directly from Homey.

It currently supports monitoring the following:
- CPU Usage & Temperature
- Memory Usage
- Network Receive / Transmit Rates
- Storage Pool Usage
- Disk Temperatures (M.2, SSD, HDD)
- Fan Speeds
- Remote Reboot & Shutdown

Flow cards:
- Then: Shut down the NAS
- Then: Reboot the NAS
- And: A backup task is running - let a Flow wait until a Backup Center task has finished before shutting the NAS down
- And: Disk activity is above a threshold (kB/s)
- And: Network activity is above a threshold (kB/s)
- And: CPU usage is above a threshold (%)

A NAS Status widget is included as well, showing CPU, memory, network, disk temperatures, fans and storage pools on your Homey dashboard.

To add your Ugreen NAS, you must provide its local IP address, port, and administrator credentials. The application connects locally to your NAS via HTTP/HTTPS. No cloud connection is required.

If your account uses two-factor authentication, you will be asked for a code from your authenticator app once while adding the device. Homey is then registered as a trusted device on the NAS, so no further codes are needed.

If the connection stops working later - for example after changing your password, or after enabling two-factor authentication on an account that was added earlier - use Device settings > Repair to sign in again. The device is kept, so your Flows and Insights history are not lost.

Important Note: Please create a local user within your NAS settings and use those specific credentials to add it to Homey. Using the default admin account or a Ugreen cloud account might not work as intended for local API access.

If your NAS is behind a reverse proxy (for example Nginx Proxy Manager), or uses HTTPS on the given port, enable the "Use HTTPS" option when adding the device. Self-signed certificates are accepted.
