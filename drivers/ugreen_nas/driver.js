const Homey = require('homey');
const UgreenClient = require('../../lib/UgreenClient');

class UgreenNasDriver extends Homey.Driver {

    async onInit() {
        this.log('Ugreen NAS driver initialized');
    }

    _createClient(data, clientId = null) {
        return new UgreenClient({
            host: data.ip,
            port: parseInt(data.port, 10),
            username: data.username,
            password: data.password,
            useHttps: data.useHttps === true || data.useHttps === 'true',
            clientId
        });
    }

    _settingsFromInput(data) {
        return {
            address: data.ip,
            host_port: parseInt(data.port, 10),
            username: data.username,
            password: data.password,
            use_https: data.useHttps === true || data.useHttps === 'true'
        };
    }

    async _buildDevice(client, data) {
        // Fetch info to use as device name
        const sysinfo = await client.getSystemInfo();
        const deviceName = sysinfo && sysinfo.common && sysinfo.common.model
            ? `Ugreen NAS ${sysinfo.common.model}`
            : 'Ugreen NAS';
        const serial = sysinfo && sysinfo.common && sysinfo.common.serial
            ? sysinfo.common.serial
            : data.ip;

        return {
            name: deviceName,
            data: { id: serial },
            store: { ug_client_id: client.clientId || null },
            settings: this._settingsFromInput(data)
        };
    }

    async onPair(session) {
        // Kept between the two steps: UGOS ties the 2FA code to the login attempt
        // that produced it, so the same client instance has to verify the code.
        let pendingClient = null;
        let pendingData = null;

        session.setHandler('login', async (data) => {
            try {
                const client = this._createClient(data);

                try {
                    await client.login();
                } catch (err) {
                    if (err.code === 'otp_required') {
                        pendingClient = client;
                        pendingData = data;
                        return { needsOtp: true };
                    }
                    throw err;
                }

                return await this._buildDevice(client, data);
            } catch (err) {
                this.error('Pairing error: ', err);
                throw new Error('Connection failed: ' + err.message);
            }
        });

        session.setHandler('verify_otp', async (data) => {
            try {
                if (!pendingClient) {
                    throw new Error('Please enter your login details first.');
                }

                await pendingClient.verifyOtp(data.code);
                return await this._buildDevice(pendingClient, pendingData);
            } catch (err) {
                this.error('Two-factor error: ', err);
                throw err;
            }
        });
    }

    /**
     * Lets an existing device re-authenticate without being deleted and added
     * again — needed when credentials change or when 2FA is switched on for the
     * account after pairing (Flows and Insights history are kept this way).
     */
    async onRepair(session, device) {
        let pendingClient = null;
        let pendingData = null;

        const save = async (client, data) => {
            await device.setStoreValue('ug_client_id', client.clientId || null);
            await device.setSettings(this._settingsFromInput(data));
            await device.refreshClient();
            return { ok: true };
        };

        // Pre-fills the form with what the device already knows, except the password.
        session.setHandler('get_current', async () => {
            const settings = device.getSettings();
            return {
                ip: settings.address || '',
                port: settings.host_port || 9999,
                username: settings.username || '',
                useHttps: settings.use_https === true
            };
        });

        session.setHandler('login', async (data) => {
            try {
                const client = this._createClient(data, device.getStoreValue('ug_client_id') || null);

                try {
                    await client.login();
                } catch (err) {
                    if (err.code === 'otp_required') {
                        pendingClient = client;
                        pendingData = data;
                        return { needsOtp: true };
                    }
                    throw err;
                }

                return await save(client, data);
            } catch (err) {
                this.error('Repair error: ', err);
                throw new Error('Connection failed: ' + err.message);
            }
        });

        session.setHandler('verify_otp', async (data) => {
            try {
                if (!pendingClient) {
                    throw new Error('Please enter your login details first.');
                }

                await pendingClient.verifyOtp(data.code);
                return await save(pendingClient, pendingData);
            } catch (err) {
                this.error('Two-factor error: ', err);
                throw err;
            }
        });
    }
}

module.exports = UgreenNasDriver;
