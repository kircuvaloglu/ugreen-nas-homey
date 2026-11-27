const crypto = require('crypto');
const WebSocket = require('ws');
// Use undici's own fetch together with its Agent: handing an Agent from the
// bundled undici package to Node's global fetch (which ships a different
// undici version) is not guaranteed to be compatible.
const { Agent, fetch } = require('undici');
class UgreenClient {
    constructor({ host, port, username, password, useHttps = false, clientId = null }) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.useHttps = useHttps;
        this.scheme = useHttps ? 'https' : 'http';
        this.baseUrl = `${this.scheme}://${this.host}:${this.port}`;
        this.token = null;
        // Identifies this installation to UGOS. Once the user has confirmed a
        // 2FA code for it, the NAS remembers it as a trusted device and lets us
        // log in without asking for a new code. It is created up front so the
        // whole 2FA handshake (login -> code -> trust) runs under the same id;
        // creating it only at the code step left the first login without it.
        this.clientId = clientId || crypto.randomUUID().replace(/-/g, '');
        this._otpTokenId = null;
        this._backupCache = null;
        this._ws = null;
        this._wsPingInterval = null;

        // A single, reused Agent with rejectUnauthorized: false.
        // This handles self-signed certificates on both HTTP and HTTPS connections
        // (necessary when Nginx Proxy Manager or similar proxies wrap connections with TLS)
        // and lets keep-alive connections be reused across requests instead of forcing
        // a fresh TCP/TLS handshake on every single poll, which caused connection
        // exhaustion/timeouts for users behind a reverse proxy.
        this._agent = new Agent({ connect: { rejectUnauthorized: false } });
    }

    async _request(method, endpoint, payload = null) {
        const urlObj = new URL(`${this.baseUrl}${endpoint}`);
        if (this.token) {
            urlObj.searchParams.set('token', this.token);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Homey-UgreenNAS',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate'
        };

        // UGOS binds the trusted-device state to this header, so it has to be
        // sent on the login requests as well, not just on authenticated calls.
        headers['UG-Client-Id'] = this.clientId;

        const options = {
            method,
            headers,
            dispatcher: this._agent,
            signal: controller.signal
        };

        if (payload) {
            options.body = JSON.stringify(payload);
        }

        let response;
        try {
            response = await fetch(urlObj.toString(), options);
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error(`Connection timeout on ${endpoint}`);
            }
            const cause = e.cause && e.cause.message ? ` - ${e.cause.message}` : '';
            throw new Error(`Connection failed: ${e.message}${cause}`);
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status} on ${endpoint}`);
        }

        return {
            headers: response.headers,
            data: await response.json(),
        };
    }

    async login() {
        try {
            // 1) Fetch public key
            const checkRes = await this._request('POST', '/ugreen/v1/verify/check?token=', {
                username: this.username
            });
            const rsaTokenHeader = checkRes.headers.get('x-rsa-token');
            if (!rsaTokenHeader) {
                throw new Error('Missing x-rsa-token header');
            }

            let pemString;
            const cleanHeader = rsaTokenHeader.replace(/\r?\n|\r/g, '').trim();

            if (cleanHeader.startsWith('-----BEGIN')) {
                pemString = cleanHeader;
            } else {
                const decoded = Buffer.from(cleanHeader, 'base64').toString('utf8');
                if (decoded.includes('-----BEGIN')) {
                    pemString = decoded;
                } else {
                    // Fallback: Construct a PEM string manually if the base64 payload was raw body/DER
                    pemString = `-----BEGIN PUBLIC KEY-----\n${cleanHeader.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
                }
            }

            // Ugreen sends -----BEGIN RSA PUBLIC KEY----- which throws ERR_OSSL_UNSUPPORTED in newer Node.js versions
            // Replace it with standard -----BEGIN PUBLIC KEY-----
            if (pemString.includes('BEGIN RSA PUBLIC KEY')) {
                pemString = pemString.replace('BEGIN RSA PUBLIC KEY', 'BEGIN PUBLIC KEY').replace('END RSA PUBLIC KEY', 'END PUBLIC KEY');
            }

            let encryptedPassword;
            try {
                encryptedPassword = crypto.publicEncrypt({
                    key: pemString,
                    padding: crypto.constants.RSA_PKCS1_PADDING
                }, Buffer.from(this.password, 'utf8'));
            } catch (err) {
                throw new Error(`RSA Encryption failed: ${err.message}`);
            }

            const encBase64 = encryptedPassword.toString('base64');

            // 2) Login
            // otp: true opts into the two-factor handshake. Accounts without 2FA
            // still get their token straight away, but accounts that do have it
            // enabled are rejected outright when this is false — with a misleading
            // "client is not compatible with the firmware" message (code 9406).
            const loginRes = await this._request('POST', '/ugreen/v1/verify/login', {
                is_simple: true,
                keepalive: true,
                otp: true,
                username: this.username,
                password: encBase64
            });

            const { data } = loginRes;
            if (data.code !== 200) {
                if (data.code === 9406) {
                    throw new Error('The NAS rejected this login. If two-factor authentication is enabled for this account, make sure you are running the latest version of this app.');
                }
                throw new Error(`Login failed: ${data.msg || data.debug || data.code}`);
            }

            const result = data.data || {};

            if (result.token) {
                this.token = result.token;
                this._otpTokenId = null;
                return true;
            }

            // No token means UGOS wants a 2FA code before it hands one out. The
            // token_id ties the code we send next to this login attempt.
            if (result.token_id || result.enable_otp) {
                this._otpTokenId = result.token_id || null;
                const otpError = new Error('A two-factor authentication code is required for this account.');
                otpError.code = 'otp_required';
                throw otpError;
            }

            throw new Error('Login succeeded but token is missing');
        } catch (error) {
            console.error('[UgreenClient] Login error:', error);
            throw error;
        }
    }

    /**
     * Completes the two-factor handshake that login() started.
     *
     * Sending trust: true together with our UG-Client-Id registers this app as a
     * trusted device on the NAS, so subsequent logins with the same client id
     * return a token directly and the user is not asked for a code again.
     */
    async verifyOtp(code) {
        if (!this._otpTokenId) {
            throw new Error('No two-factor request is pending. Please enter your login details again.');
        }

        const res = await this._request('POST', '/ugreen/v1/verify/code/login', {
            code: String(code).trim(),
            type: 1,
            token_id: this._otpTokenId,
            trust_info: {
                client_type: 'pc',
                system: 'linux',
                dev_name: 'Homey'
            },
            trust: true
        });

        const { data } = res;
        if (!data || data.code !== 200) {
            const reason = (data && (data.msg || data.debug || data.code)) || 'unknown error';
            throw new Error(`Two-factor verification failed: ${reason}`);
        }

        this._otpTokenId = null;

        if (data.data && data.data.token) {
            this.token = data.data.token;
        } else {
            // Some firmware versions only register the trust here and expect a
            // regular login afterwards, which now passes thanks to the client id.
            await this.login();
        }

        return this.clientId;
    }

    async get(endpoint) {
        if (!this.token) {
            await this.login();
        }
        let res = await this._request('GET', endpoint);
        // Code 1024 typically means token expired
        if (res.data && res.data.code === 1024) {
            await this.login();
            res = await this._request('GET', endpoint);
        }
        return res.data;
    }

    async post(endpoint, payload) {
        if (!this.token) {
            await this.login();
        }
        let res = await this._request('POST', endpoint, payload);
        if (res.data && res.data.code === 1024) {
            await this.login();
            res = await this._request('POST', endpoint, payload);
        }
        return res.data;
    }

    async getSystemInfo() {
        const res = await this.get('/ugreen/v1/sysinfo/machine/common');
        if (res && res.code === 200) {
            return res.data; // { common: {...}, hardware: {...} }
        }
        throw new Error(`Failed to fetch system info. Response: ${JSON.stringify(res)}`);
    }

    async getSystemStats() {
        const res = await this.get('/ugreen/v1/taskmgr/stat/get_all');
        if (res && res.code === 200) {
            return res.data; // { overview: {...}, cpu: [...], mem: [...], net: {...} }
        }
        throw new Error(`Failed to fetch system stats. Response: ${JSON.stringify(res)}`);
    }

    async getStoragePools() {
        const res = await this.get('/ugreen/v1/storage/pool/list');
        if (res && res.code === 200) {
            return res.data.result || [];
        }
        return [];
    }

    async getDisks() {
        const res = await this.get('/ugreen/v2/storage/disk/list');
        if (res && res.code === 200) {
            return res.data.result || [];
        }
        return [];
    }

    /**
     * Returns the sync/backup tasks configured in UGOS' Backup Center.
     *
     * The list can come back empty until the sync module has been touched once
     * after a NAS reboot, so an empty result is retried after a warm-up call.
     */
    async getBackupTasks() {
        const endpoint = '/ugreen/v2/web/syncbackup/task/list?page=1&size=1000';

        let tasks = this._extractBackupTasks(await this.get(endpoint));
        if (tasks.length === 0) {
            await this.get('/ugreen/v1/web/sync/general/get').catch(() => { });
            tasks = this._extractBackupTasks(await this.get(endpoint));
        }
        return tasks;
    }

    _extractBackupTasks(res) {
        if (!res || res.code !== 200 || !res.data) return [];
        if (Array.isArray(res.data)) return res.data;

        for (const key of ['list', 'result', 'tasks', 'items', 'rows']) {
            if (Array.isArray(res.data[key])) return res.data[key];
        }
        return [];
    }

    /**
     * True while at least one backup task is running. UGOS signals this through
     * different fields depending on the task type, hence the three checks.
     * Results are cached briefly so a Flow with several cards only asks once.
     */
    async isBackupRunning() {
        if (this._backupCache && Date.now() - this._backupCache.at < 5000) {
            return this._backupCache.running;
        }

        const tasks = await this.getBackupTasks();
        const running = tasks.some((task) => {
            if (!task) return false;
            if (task.execute_now) return true;
            if (Number(task.progress) > 0) return true;
            return [2, 3, 6, 7].includes(Number(task.status));
        });

        this._backupCache = { at: Date.now(), running };
        return running;
    }

    async reboot() {
        return await this.post('/ugreen/v1/desktop/reboot');
    }

    async shutdown() {
        return await this.post('/ugreen/v1/desktop/poweroff');
    }

    startWsKeepAlive() {
        if (!this.token || this._ws) return;

        const wsScheme = this.scheme === 'https' ? 'wss' : 'ws';
        const clientId = crypto.randomUUID() + '-WEB';
        const wsUrl = `${wsScheme}://${this.host}:${this.port}/ugreen/v1/desktop/ws?client_id=${clientId}&lang=en-US&token=${this.token}`;

        try {
            this._ws = new WebSocket(wsUrl, {
                rejectUnauthorized: false
            });

            this._ws.on('open', () => {
                // Subscribe to basic topics to trigger the NAS reporting dynamic stats like cpu and fans to taskmgr API
                this._ws.send(JSON.stringify({
                    op: 'subscribe',
                    topics: ['cpu_usage', 'cpu_temp'],
                    ts: Date.now()
                }));

                this._wsPingInterval = setInterval(() => {
                    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                        this._ws.ping();
                    }
                }, 15000); // 15s ping
            });

            this._ws.on('error', (err) => {
                // Silent catch, Ugreen NAS might drop WS sometimes
            });

            this._ws.on('close', () => {
                this.stopWsKeepAlive();
                // We don't forcefully reconnect here, the next UgreenClient auth or tick can handle it if needed
            });
        } catch (err) {
            console.error('[UgreenClient] WS init error:', err.message);
        }
    }

    stopWsKeepAlive() {
        if (this._wsPingInterval) {
            clearInterval(this._wsPingInterval);
            this._wsPingInterval = null;
        }
        if (this._ws) {
            try { this._ws.terminate(); } catch (e) { }
            this._ws = null;
        }
    }

    destroy() {
        this.stopWsKeepAlive();
        if (this._agent) {
            try { this._agent.close(); } catch (e) { }
        }
    }
}

module.exports = UgreenClient;
