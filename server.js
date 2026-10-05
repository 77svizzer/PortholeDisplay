const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const HTTP_PORT = process.env.PORT || 8000;
const WS_PORT = process.env.WS_PORT || 8766;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME map for static assets
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png'
};

// Active sessions: key -> { host: ws, client: ws }
const activeSessions = new Map();
const socketRegistry = new Map();

function generateSessionKey() {
    while (true) {
        const num = Math.floor(100000000 + Math.random() * 900000000).toString();
        const key = `${num.slice(0, 3)}-${num.slice(3, 6)}-${num.slice(6, 9)}`;
        if (!activeSessions.has(key)) {
            return key;
        }
    }
}

// 1. Static HTTP Server
const server = http.createServer((req, res) => {
    let cleanUrl = req.url.split('?')[0];
    if (cleanUrl === '/' || cleanUrl === '') {
        cleanUrl = '/index.html';
    }

    const filePath = path.join(PUBLIC_DIR, path.normalize(cleanUrl));

    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Access Denied');
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
});

// 2. WebSocket Signaling Server attached to HTTP Server
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    const remoteIp = req.socket.remoteAddress;
    console.log(`[SIGNALING] Peer connected from ${remoteIp}`);

    ws.on('message', (message) => {
        let msg;
        try {
            msg = JSON.parse(message);
        } catch (e) {
            return ws.send(JSON.stringify({ type: 'error', message: 'Malformed JSON payload.' }));
        }

        switch (msg.type) {
            case 'register-host': {
                let sessionKey = msg.sessionKey;
                if (!sessionKey || activeSessions.has(sessionKey)) {
                    sessionKey = generateSessionKey();
                }

                activeSessions.set(sessionKey, { host: ws, client: null });
                socketRegistry.set(ws, { sessionKey, role: 'host' });

                console.log(`[HOST] Session registered: ${sessionKey}`);
                ws.send(JSON.stringify({
                    type: 'host-registered',
                    sessionKey
                }));
                break;
            }

            case 'join-session': {
                const targetKey = (msg.sessionKey || '').trim();
                if (!activeSessions.has(targetKey)) {
                    console.log(`[JOIN] Key rejected (not found): ${targetKey}`);
                    return ws.send(JSON.stringify({
                        type: 'join-error',
                        message: `Session key ${targetKey} does not exist or host is offline.`
                    }));
                }

                const session = activeSessions.get(targetKey);
                if (session.client !== null) {
                    console.log(`[JOIN] Key rejected (busy): ${targetKey}`);
                    return ws.send(JSON.stringify({
                        type: 'join-error',
                        message: `Session key ${targetKey} is already occupied.`
                    }));
                }

                session.client = ws;
                socketRegistry.set(ws, { sessionKey: targetKey, role: 'client' });

                console.log(`[CLIENT] Joined session: ${targetKey}`);
                ws.send(JSON.stringify({
                    type: 'join-success',
                    sessionKey: targetKey
                }));

                // Notify host to initiate SDP Offer
                if (session.host && session.host.readyState === WebSocket.OPEN) {
                    session.host.send(JSON.stringify({
                        type: 'client-joined',
                        sessionKey: targetKey
                    }));
                }
                break;
            }

            case 'offer': {
                const info = socketRegistry.get(ws);
                if (!info) return;
                const session = activeSessions.get(info.sessionKey);
                if (!session) return;

                const recipient = info.role === 'host' ? session.client : session.host;
                if (recipient && recipient.readyState === WebSocket.OPEN) {
                    recipient.send(JSON.stringify({
                        type: 'offer',
                        sdp: msg.sdp
                    }));
                }
                break;
            }

            case 'answer': {
                const info = socketRegistry.get(ws);
                if (!info) return;
                const session = activeSessions.get(info.sessionKey);
                if (!session) return;

                const recipient = info.role === 'client' ? session.host : session.client;
                if (recipient && recipient.readyState === WebSocket.OPEN) {
                    recipient.send(JSON.stringify({
                        type: 'answer',
                        sdp: msg.sdp
                    }));
                }
                break;
            }

            case 'ice-candidate': {
                const info = socketRegistry.get(ws);
                if (!info) return;
                const session = activeSessions.get(info.sessionKey);
                if (!session) return;

                const recipient = info.role === 'host' ? session.client : session.host;
                if (recipient && recipient.readyState === WebSocket.OPEN) {
                    recipient.send(JSON.stringify({
                        type: 'ice-candidate',
                        candidate: msg.candidate
                    }));
                }
                break;
            }

            case 'disconnect-session': {
                const info = socketRegistry.get(ws);
                if (!info) return;
                const session = activeSessions.get(info.sessionKey);
                if (session) {
                    const recipient = info.role === 'host' ? session.client : session.host;
                    if (recipient && recipient.readyState === WebSocket.OPEN) {
                        recipient.send(JSON.stringify({
                            type: 'peer-disconnected',
                            message: 'Remote peer terminated session.'
                        }));
                    }
                    if (info.role === 'host') {
                        activeSessions.delete(info.sessionKey);
                    } else {
                        session.client = null;
                    }
                }
                break;
            }

            case 'ping': {
                ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
                break;
            }
        }
    });

    ws.on('close', () => {
        const info = socketRegistry.get(ws);
        if (!info) return;

        socketRegistry.delete(ws);
        const { sessionKey, role } = info;
        console.log(`[DISCONNECT] ${role.toUpperCase()} disconnected from ${sessionKey}`);

        if (activeSessions.has(sessionKey)) {
            const session = activeSessions.get(sessionKey);
            if (role === 'host') {
                if (session.client && session.client.readyState === WebSocket.OPEN) {
                    session.client.send(JSON.stringify({
                        type: 'peer-disconnected',
                        message: 'Host closed session or went offline.'
                    }));
                }
                activeSessions.delete(sessionKey);
            } else if (role === 'client') {
                session.client = null;
                if (session.host && session.host.readyState === WebSocket.OPEN) {
                    session.host.send(JSON.stringify({
                        type: 'client-disconnected',
                        message: 'Remote client disconnected.'
                    }));
                }
            }
        }
    });
});

server.listen(HTTP_PORT, () => {
    console.log(`[HTTP] Web UI listening on http://localhost:${HTTP_PORT}`);
    console.log(`[SIGNALING] WebSocket server running on ws://localhost:${WS_PORT}`);
});
