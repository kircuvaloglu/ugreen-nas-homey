This application enables you to connect and manage your Ugreen NAS directly from Homey. 

It currently supports monitoring the following:
- CPU Usage & Temperature
- Memory Usage
- Network Receive / Transmit Rates
- Storage Pool Usage
- Disk Temperatures (M.2, SSD, HDD)
- Fan Speeds
- Remote Reboot & Shutdown

Important Note: Please create a local user within your NAS settings and use those specific credentials to add it to Homey. Using the default admin or Ugreen rounded accounts might not work as intended for local API access.

To add your Ugreen NAS, you must provide its local IP address, port, and administrator credentials. The application connects locally to your NAS via HTTP/HTTPS. No cloud connection is required.
