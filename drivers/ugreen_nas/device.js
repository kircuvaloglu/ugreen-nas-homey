const Homey = require('homey');
const UgreenClient = require('../../lib/UgreenClient');

class UgreenNasDevice extends Homey.Device {

    async onInit() {
        this.log('Ugreen NAS Device has been initialized');

        // Initial setup of state
        this._syncInterval = null;

        // Ensure capabilities exist
        if (!this.hasCapability('measure_cpu')) await this.addCapability('measure_cpu');
        if (!this.hasCapability('measure_memory')) await this.addCapability('measure_memory');
        if (!this.hasCapability('measure_temperature')) await this.addCapability('measure_temperature');
        if (!this.hasCapability('measure_network_rx')) await this.addCapability('measure_network_rx');
        if (!this.hasCapability('measure_network_tx')) await this.addCapability('measure_network_tx');

        // Remove deprecated capability to prevent UI crashes on already paired devices
        if (this.hasCapability('fan_mode_select')) {
            try {
                await this.removeCapability('fan_mode_select');
                this.log('Successfully removed deprecated fan_mode_select capability');
            } catch (err) {
                this.error('Failed to remove deprecated fan_mode_select', err);
            }
        }

        // Remove empty generic fan speed (fans are added dynamically with chassis_X or cpu_X)
        if (this.hasCapability('measure_fan_speed')) {
            try {
                await this.removeCapability('measure_fan_speed');
                this.log('Successfully removed generic measure_fan_speed capability');
            } catch (err) {
                this.error('Failed to remove generic measure_fan_speed', err);
            }
        }

        // Setup button listeners
        if (this.hasCapability('button_reboot')) {
            this.registerCapabilityListener('button_reboot', async (value, opts) => {
                this.log('Reboot triggered');
                await this.getClient().reboot();
            });
        }

        if (this.hasCapability('button_shutdown')) {
            this.registerCapabilityListener('button_shutdown', async (value, opts) => {
                this.log('Shutdown triggered');
                await this.getClient().shutdown();
            });
        }

        // Start polling
        this.startPolling();
    }

    getClient() {
        if (!this._client) {
            const settings = this.getSettings();
            this._client = new UgreenClient({
                host: settings.address || '192.168.1.100',
                port: settings.host_port || 9999,
                username: settings.username || 'admin',
                password: settings.password || '',
                useHttps: settings.use_https === true,
                // Set once the user completed a 2FA code during pairing/repair;
                // it keeps this app trusted so no further codes are needed.
                clientId: this.getStoreValue('ug_client_id') || null
            });
        }
        return this._client;
    }

    /**
     * Drops the cached API client so the next call picks up new credentials or a
     * freshly trusted client id. Called by the driver after a repair.
     */
    async refreshClient() {
        if (this._client) {
            this._client.destroy();
            this._client = null;
        }
        await this.getClient().login();
        await this.setAvailable();
    }

    startPolling() {
        this.log('Starting polling loop');

        // Dynamic stats (default every 10 seconds)
        this._syncInterval = this.homey.setInterval(async () => {
            try {
                const client = this.getClient();
                let stats = {};
                try {
                    stats = await client.getSystemStats();
                } catch (statsErr) {
                    if (statsErr.message.includes('1008') || statsErr.message.includes('no access') || statsErr.message.includes('General users')) {
                        this.log('User has no permission to fetch system stats. Skipping stats update.');
                    } else {
                        throw statsErr;
                    }
                }

                // Start WebSocket keepalive (only initiates if token exists and ws is null)
                client.startWsKeepAlive();

                // CPU
                if (stats.overview && stats.overview.cpu && stats.overview.cpu.length > 0) {
                    const cpuUsage = stats.overview.cpu[0].used_percent;
                    const cpuTemp = stats.overview.cpu[0].temp;
                    await this.setCapabilityValue('measure_cpu', cpuUsage);
                    await this.setCapabilityValue('measure_temperature', cpuTemp);
                }

                // RAM
                if (stats.overview && stats.overview.mem && stats.overview.mem.length > 0) {
                    const memUsage = stats.overview.mem[0].used_percent;
                    await this.setCapabilityValue('measure_memory', memUsage);
                }

                // Network
                if (stats.net && stats.net.series && stats.net.series.length > 0) {
                    // Convert B/s to kB/s for easier reading, or keep raw depends on capability
                    const rxBytes = stats.net.series[0].recv_rate;
                    const txBytes = stats.net.series[0].send_rate;
                    // measure_network_rx expects number
                    await this.setCapabilityValue('measure_network_rx', Math.round(rxBytes / 1024));
                    await this.setCapabilityValue('measure_network_tx', Math.round(txBytes / 1024));
                }

                // Overall Disk Read/Write rates
                if (stats.disk && stats.disk.series && stats.disk.series.length > 0) {
                    await this.setCapabilityValue('disk_read_rate', Math.round(stats.disk.series[0].read_rate / 1024));
                    await this.setCapabilityValue('disk_write_rate', Math.round(stats.disk.series[0].write_rate / 1024));
                }

                // Disk Temperatures dynamically added
                if (stats.disk && stats.disk.series && stats.disk.series.length > 0) {
                    let hddCount = 1;
                    let nvmeCount = 1;
                    // Usually the first item [0] is overall, or it contains each disk. Checking API structure, length > 1 might mean individual disks.
                    // The Ugreen python HA component starts disks from index 0 or 1. Let's iterate all of them.
                    for (let i = 0; i < stats.disk.series.length; i++) {
                        const disk = stats.disk.series[i];
                        // Skip the aggregate "overview" item
                        if (disk.name === 'overview') continue;

                        const temp = disk.temperature !== undefined ? disk.temperature : disk.temp;

                        // Map only disks that have a valid temperature greater than 0
                        if (temp !== undefined && temp !== null && temp > 0) {
                            const diskName = disk.name || `sda${i}`;
                            const capId = `measure_temperature.${diskName.replace(/[^a-zA-Z0-9]/g, '_')}`;

                            let labelEn = `Disk ${diskName} Temp`;
                            let labelTr = `Disk ${diskName} Sıcaklık`;

                            if (diskName.startsWith('nvme')) {
                                labelEn = `M.2 Hard Drive ${nvmeCount}`;
                                labelTr = `M.2 Sabit Sürücü ${nvmeCount} Sıcaklığı`;
                                nvmeCount++;
                            } else if (diskName.startsWith('sd')) {
                                labelEn = `Hard Drive ${hddCount}`;
                                labelTr = `Sabit Sürücü ${hddCount} Sıcaklığı`;
                                hddCount++;
                            }

                            if (!this.hasCapability(capId)) {
                                await this.addCapability(capId);
                                try {
                                    await this.setCapabilityOptions(capId, {
                                        title: { en: labelEn, tr: labelTr }
                                    });
                                } catch (e) { }
                            }

                            await this.setCapabilityValue(capId, temp);
                        }
                    }
                }

                // Fan Speeds dynamically added
                try {
                    // System (device) fans
                    if (stats.overview && stats.overview.device_fan && Array.isArray(stats.overview.device_fan)) {
                        for (let i = 0; i < stats.overview.device_fan.length; i++) {
                            const fan = stats.overview.device_fan[i];
                            if (fan.speed !== undefined && fan.speed >= 0) {
                                const capId = `measure_fan_speed.chassis_${i}`;
                                if (!this.hasCapability(capId)) {
                                    await this.addCapability(capId);
                                    try {
                                        await this.setCapabilityOptions(capId, {
                                            title: { en: `System Fan ${i + 1}`, tr: `Sistem Fanı ${i + 1}` }
                                        });
                                    } catch (e) { }
                                }

                                await this.setCapabilityValue(capId, fan.speed);
                            }
                        }
                    }

                    // CPU fans
                    if (stats.overview && stats.overview.cpu_fan && Array.isArray(stats.overview.cpu_fan)) {
                        for (let i = 0; i < stats.overview.cpu_fan.length; i++) {
                            const fan = stats.overview.cpu_fan[i];
                            if (fan.speed !== undefined && fan.speed >= 0) {
                                const capId = `measure_fan_speed.cpu_${i}`;
                                if (!this.hasCapability(capId)) {
                                    await this.addCapability(capId);
                                    try {
                                        await this.setCapabilityOptions(capId, {
                                            title: { en: `CPU Fan ${i + 1}`, tr: `İşlemci Fanı ${i + 1}` }
                                        });
                                    } catch (e) { }
                                }

                                await this.setCapabilityValue(capId, fan.speed);
                            }
                        }
                    }
                } catch (fanErr) {
                    this.log('Fan fetching error:', fanErr.message);
                }

                // Storage Pools dynamically added
                try {
                    const pools = await client.getStoragePools();
                    if (pools && pools.length > 0) {
                        for (let i = 0; i < pools.length; i++) {
                            const pool = pools[i];
                            let poolTotal = 0;
                            let poolUsed = 0;

                            // 1) First try to calculate usage by summing up actual Volume sizes
                            if (pool.volumes && pool.volumes.length > 0) {
                                for (let v = 0; v < pool.volumes.length; v++) {
                                    const vol = pool.volumes[v];
                                    poolTotal += (vol.total || vol.size || vol.capacity || 0);
                                    poolUsed += (vol.used || vol.space_used || 0);
                                }
                            }

                            // 2) If total is still 0 (no volumes, or missing properties), fallback to Pool properties
                            if (poolTotal === 0) {
                                poolTotal = pool.total || pool.size || pool.capacity || 0;

                                // Ugreen often sets pool 'used' == 'total' just to indicate allocation.
                                // If they are identical, we should report 0% instead of 100% for an empty drive.
                                if (pool.space_used !== undefined) {
                                    poolUsed = pool.space_used;
                                } else if (pool.used && pool.used < poolTotal) {
                                    poolUsed = pool.used;
                                } else {
                                    // Dummy allocation indicator (pool.used == pool.total), so actual file contents = 0
                                    poolUsed = 0;
                                }
                            }

                            // 3) Calculate percentage safely, fallback to 0% if total is 0
                            const usagePercent = poolTotal > 0 ? (Math.round((poolUsed / poolTotal) * 1000) / 10) : 0;

                            const capId = `measure_pool_usage.pool_${i}`;
                            if (!this.hasCapability(capId)) {
                                await this.addCapability(capId);
                                await this.setCapabilityOptions(capId, {
                                    title: { en: `Pool ${i + 1} Usage`, tr: `Havuz ${i + 1} Doluluk` },
                                    icon: '/assets/icons/pool.svg'
                                });
                            }
                            await this.setCapabilityValue(capId, usagePercent);
                        }
                    }
                } catch (poolErr) {
                    this.log('Pool fetching error or unsupported on this model:', poolErr.message);
                }

                // Availability
                if (!this.getAvailable()) await this.setAvailable();

            } catch (err) {
                this.error('Polling error:', err);
                if (err.code === 'otp_required') {
                    await this.setUnavailable('Two-factor authentication is enabled for this account. Repair this device (Device settings → Repair) and enter a code once.');
                } else {
                    await this.setUnavailable('Cannot reach NAS: ' + err.message);
                }

                // If it's auth failure, clear token to force re-login next tick
                if (this._client && err.message.includes('Login failed')) {
                    this._client.token = null;
                }
            }
        }, 10 * 1000); // 10 seconds
    }

    onDeleted() {
        this.log('Ugreen NAS Device has been deleted');
        if (this._syncInterval) {
            this.homey.clearInterval(this._syncInterval);
        }
        if (this._client) {
            this._client.destroy();
        }
    }

    getDashboardData() {
        const data = {
            system: {
                status: 'Good',
                message: 'The system is running normally.',
                lastBootTime: 'Unknown',
                runTime: 'Unknown'
            },
            cpu: {
                usage: this.getCapabilityValue('measure_cpu') || 0,
                temperature: this.getCapabilityValue('measure_temperature') || 0
            },
            ram: {
                usage: this.getCapabilityValue('measure_memory') || 0
            },
            network: {
                download: this.getCapabilityValue('measure_network_rx') || 0,
                upload: this.getCapabilityValue('measure_network_tx') || 0
            },
            fans: [],
            disks: [],
            pools: []
        };

        // Extract capabilities
        const capabilities = this.getCapabilities();

        // Fans
        const fanCaps = capabilities.filter(c => c.startsWith('measure_fan_speed.'));
        fanCaps.forEach(cap => {
            let name = cap.split('.')[1];
            try { name = this.getCapabilityOptions(cap).title.en || name; } catch (e) { }
            data.fans.push({
                name: name,
                speed: this.getCapabilityValue(cap) || 0
            });
        });

        // Disks
        const diskCaps = capabilities.filter(c => c.startsWith('measure_temperature.'));
        diskCaps.forEach(cap => {
            let name = cap.split('.')[1];
            try { name = this.getCapabilityOptions(cap).title.en || name; } catch (e) { }
            data.disks.push({
                name: name,
                temperature: this.getCapabilityValue(cap) || 0
            });
        });

        // Pools
        const poolCaps = capabilities.filter(c => c.startsWith('measure_pool_usage.'));
        poolCaps.forEach(cap => {
            let name = cap.split('.')[1];
            try { name = this.getCapabilityOptions(cap).title.en || name; } catch (e) { }
            data.pools.push({
                name: name,
                usage: this.getCapabilityValue(cap) || 0
            });
        });

        return data;
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        this.log('Settings changed, recreating API client');
        // If credentials or IP changed, we recreate the client to reflect new connection
        if (changedKeys.includes('address') || changedKeys.includes('host_port') || changedKeys.includes('username') || changedKeys.includes('password') || changedKeys.includes('use_https')) {
            if (this._client) {
                this._client.destroy();
            }
            this._client = new UgreenClient({
                host: newSettings.address,
                port: newSettings.host_port,
                username: newSettings.username,
                password: newSettings.password,
                useHttps: newSettings.use_https === true,
                clientId: this.getStoreValue('ug_client_id') || null
            });
            // Test connection right away
            try {
                await this._client.login();
                this.log('Re-login successful with new settings');
                await this.setAvailable();
            } catch (err) {
                this.error('Login failed with new settings', err);
                if (err.code === 'otp_required') {
                    throw new Error('This account uses two-factor authentication. Please use Repair instead, so a code can be entered.');
                }
                throw new Error('Could not login. Please check credentials and IP.');
            }
        }
    }
}

module.exports = UgreenNasDevice;
