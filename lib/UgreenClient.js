const crypto = require('crypto');
const WebSocket = require('ws');
const { Agent } = require('undici');
// fetch is available as global in Node 18+ and Homey Apps.
class UgreenClient {
    constructor({ host, port, username, password, useHttps = false }) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.useHttps = useHttps;
        this.scheme = useHttps ? 'https' : 'http';
        this.baseUrl = `${this.scheme}://${this.host}:${this.port}`;
        this.token = null;
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

        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'HomeAssistant/2026.1.0 aiohttp/3.8.1 Python/3.10',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate'
            },
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
            const loginRes = await this._request('POST', '/ugreen/v1/verify/login', {
                is_simple: true,
                keepalive: true,
                otp: false,
                username: this.username,
                password: encBase64
            });

            const { data } = loginRes;
            if (data.code !== 200) {
                throw new Error(`Login failed: ${data.msg || data.debug || data.code}`);
            }

            if (!data.data || !data.data.token) {
                throw new Error('Login succeeded but token is missing');
            }

            this.token = data.data.token;
            return true;
        } catch (error) {
            console.error('[UgreenClient] Login error:', error);
            throw error;
        }
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
