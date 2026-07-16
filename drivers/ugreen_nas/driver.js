const Homey = require('homey');
const UgreenClient = require('../../lib/UgreenClient');

class UgreenNasDriver extends Homey.Driver {

    async onInit() {
        this.log('Ugreen NAS driver initialized');
    }

    async onPair(session) {
        session.setHandler('login', async (data) => {
            try {
                const client = new UgreenClient({
                    host: data.ip,
                    port: parseInt(data.port, 10),
                    username: data.username,
                    password: data.password,
                    useHttps: data.useHttps === true || data.useHttps === 'true'
                });

                await client.login();

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
                    settings: {
                        address: data.ip,
                        host_port: parseInt(data.port, 10),
                        username: data.username,
                        password: data.password,
                        use_https: data.useHttps === true || data.useHttps === 'true'
                    }
                };

            } catch (err) {
                this.error('Pairing error: ', err);
                throw new Error('Connection failed: ' + err.message);
            }
        });
    }
}

module.exports = UgreenNasDriver;
