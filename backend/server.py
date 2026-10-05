#!/usr/bin/env python3
"""
Porthole WebRTC Production Unified HTTP & WebSocket Signaling Server.
Features:
- Security hardening: CSP, X-Frame-Options, X-Content-Type-Options, nosniff
- Rate limiting and brute-force protection against session key scanning
- Connection limits and message rate throttling
- Cryptographically secure tokens and identifiers
- Loopback-protected /api/agent-token endpoint
- Multi-viewer streams with granular permissions and host kick capability
- Directory indexing disabled
"""

import asyncio
import json
import logging
import os
import re
import secrets
import time
from collections import defaultdict
from pathlib import Path
from aiohttp import web

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("SignalingServer")

PORT = int(os.environ.get("PORT", 8000))
BASE_DIR = Path(__file__).resolve().parent.parent
PUBLIC_DIR = BASE_DIR / "public"
TOKEN_FILE = BASE_DIR / ".agent_token"

# State registries
# active_sessions: key -> { "host": ws, "host_nickname": str, "clients": { client_id: { "ws": ws, "nickname": str } } }
active_sessions = {}
# socket_registry: ws -> { "session_key": key, "role": "host"|"client", "client_id": str|None, "nickname": str, "ip": str, "msg_count": int, "window_start": float }
socket_registry = {}

# Integrated OS Input Engine for remote control
try:
    from host_agent import OSInputExecutor
    os_executor = OSInputExecutor()
    logger.info("Initialized integrated OS Input Engine in server.py")
except Exception as e:
    os_executor = None
    logger.warning(f"Could not initialize local OS Input Engine in server: {e}")

# Security rate limiters
# ip_connections: ip -> count
ip_connections = defaultdict(int)
MAX_CONNECTIONS_PER_IP = 100

# failed_joins: ip -> list of timestamps
failed_joins = defaultdict(list)
FAILED_JOIN_WINDOW = 60.0       # 60 seconds
MAX_FAILED_JOINS = 5            # max 5 failed attempts per window
BLOCK_DURATION = 300.0          # 5 minutes block
ip_blocked_until = {}

# Session limits
MAX_GLOBAL_SESSIONS = 50
MAX_VIEWERS_PER_SESSION = 30
MAX_MSG_RATE_PER_SEC = 50


def sanitize_nickname(nick: str, default: str) -> str:
    """Sanitize nickname to avoid injection, tags, or control characters."""
    if not isinstance(nick, str):
        return default
    cleaned = re.sub(r"[^\w\s\u0400-\u04FF\.\-_]", "", nick).strip()
    return cleaned[:24] if cleaned else default


def generate_session_key() -> str:
    """Generate collision-free 9-digit key formatted as XXX-XXX-XXX using secrets."""
    while True:
        num = secrets.randbelow(900_000_000) + 100_000_000
        s = str(num)
        key = f"{s[0:3]}-{s[3:6]}-{s[6:9]}"
        if key not in active_sessions:
            return key


def is_ip_blocked(ip: str) -> bool:
    now = time.time()
    unblock_time = ip_blocked_until.get(ip, 0)
    if now < unblock_time:
        return True
    if ip in ip_blocked_until:
        del ip_blocked_until[ip]
    return False


def register_failed_join(ip: str):
    now = time.time()
    # Clean old entries
    failed_joins[ip] = [t for t in failed_joins[ip] if now - t < FAILED_JOIN_WINDOW]
    failed_joins[ip].append(now)
    if len(failed_joins[ip]) >= MAX_FAILED_JOINS:
        ip_blocked_until[ip] = now + BLOCK_DURATION
        logger.warning(f"IP {ip} blocked for {int(BLOCK_DURATION)}s due to repeated failed join attempts.")


async def broadcast_session_state(s_key: str):
    """Send updated viewer count and participant list to host and all viewers."""
    session = active_sessions.get(s_key)
    if not session:
        return

    participants = [
        {
            "clientId": c_id,
            "nickname": c_data["nickname"],
            "controlAllowed": c_data.get("controlAllowed", True)
        }
        for c_id, c_data in session["clients"].items()
    ]
    count = len(participants)

    msg = json.dumps({
        "type": "session-participants",
        "count": count,
        "participants": participants,
        "hostNickname": session.get("host_nickname", "Ведущий")
    })

    # Send to host
    if session["host"] and not session["host"].closed:
        try:
            await session["host"].send_str(msg)
        except Exception:
            pass

    # Send to all clients
    for c_data in list(session["clients"].values()):
        c_ws = c_data["ws"]
        if c_ws and not c_ws.closed:
            try:
                await c_ws.send_str(msg)
            except Exception:
                pass


async def ws_handler(request):
    """Handle WebRTC signaling over WebSocket with strict validation and rate limiting."""
    forwarded = request.headers.get("X-Forwarded-For")
    remote_ip = forwarded.split(",")[0].strip() if forwarded else (request.remote or "unknown")

    # Enforce connection limits per IP
    if ip_connections[remote_ip] >= MAX_CONNECTIONS_PER_IP:
        logger.warning(f"Connection rejected: IP {remote_ip} exceeded max connections ({MAX_CONNECTIONS_PER_IP})")
        return web.Response(status=429, text="Too Many Connections")

    ip_connections[remote_ip] += 1

    ws = web.WebSocketResponse(max_msg_size=1048576, heartbeat=25.0)
    await ws.prepare(request)

    session_info = {
        "session_key": None,
        "role": None,
        "client_id": None,
        "nickname": None,
        "ip": remote_ip,
        "msg_count": 0,
        "window_start": time.time()
    }
    socket_registry[ws] = session_info

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                now = time.time()
                if now - session_info["window_start"] >= 1.0:
                    session_info["window_start"] = now
                    session_info["msg_count"] = 0

                session_info["msg_count"] += 1
                if session_info["msg_count"] > MAX_MSG_RATE_PER_SEC:
                    # Rate limit exceeded for this socket
                    continue

                try:
                    payload = json.loads(msg.data)
                except json.JSONDecodeError:
                    await ws.send_json({"type": "error", "message": "Malformed JSON payload."})
                    continue

                msg_type = payload.get("type")

                # 1. Регистрация хоста (трансляция)
                if msg_type == "register-host":
                    if len(active_sessions) >= MAX_GLOBAL_SESSIONS:
                        await ws.send_json({
                            "type": "error",
                            "message": "Лимит активных трансляций на сервере исчерпан. Попробуйте позже."
                        })
                        continue

                    nickname = sanitize_nickname(payload.get("nickname"), "Ведущий")
                    session_key = generate_session_key()

                    active_sessions[session_key] = {
                        "host": ws,
                        "host_nickname": nickname,
                        "clients": {}
                    }
                    session_info["session_key"] = session_key
                    session_info["role"] = "host"
                    session_info["nickname"] = nickname

                    logger.info(f"Host '{nickname}' registered session: {session_key} (IP: {remote_ip})")
                    await ws.send_json({
                        "type": "host-registered",
                        "sessionKey": session_key,
                        "nickname": nickname
                    })

                # 2. Подключение зрителя (клиент)
                elif msg_type == "join-session":
                    if is_ip_blocked(remote_ip):
                        await ws.send_json({
                            "type": "join-error",
                            "message": "Слишком много неудачных попыток. Доступ временно заблокирован на 5 минут."
                        })
                        continue

                    raw_key = str(payload.get("sessionKey", "")).strip()
                    if not re.match(r"^\d{3}-\d{3}-\d{3}$", raw_key):
                        register_failed_join(remote_ip)
                        await ws.send_json({
                            "type": "join-error",
                            "message": "Неверный формат кода подключения (требуется XXX-XXX-XXX)."
                        })
                        continue

                    nickname = sanitize_nickname(payload.get("nickname"), "Гость")

                    if raw_key not in active_sessions:
                        register_failed_join(remote_ip)
                        logger.warning(f"Join rejected: session {raw_key} not found (IP: {remote_ip})")
                        await ws.send_json({
                            "type": "join-error",
                            "message": f"Сессия {raw_key} не найдена или ведущий завершил трансляцию."
                        })
                        continue

                    session = active_sessions[raw_key]

                    if len(session["clients"]) >= MAX_VIEWERS_PER_SESSION:
                        await ws.send_json({
                            "type": "join-error",
                            "message": "В данной трансляции достигнут максимум зрителей (30 человек)."
                        })
                        continue

                    client_id = f"c_{secrets.token_hex(4)}"
                    session["clients"][client_id] = {
                        "ws": ws,
                        "nickname": nickname,
                        "controlAllowed": True  # Remote control is allowed by default for authenticated session
                    }

                    session_info["session_key"] = raw_key
                    session_info["role"] = "client"
                    session_info["client_id"] = client_id
                    session_info["nickname"] = nickname

                    logger.info(f"Viewer '{nickname}' ({client_id}) joined session {raw_key} with PC control ENABLED")
                    await ws.send_json({
                        "type": "join-success",
                        "sessionKey": raw_key,
                        "clientId": client_id,
                        "nickname": nickname,
                        "hostNickname": session.get("host_nickname", "Ведущий"),
                        "viewerCount": len(session["clients"]),
                        "controlAllowed": True
                    })

                    # Оповещаем хоста о новом зрителе
                    host_ws = session["host"]
                    if host_ws and not host_ws.closed:
                        await host_ws.send_json({
                            "type": "client-joined",
                            "sessionKey": raw_key,
                            "clientId": client_id,
                            "nickname": nickname,
                            "viewerCount": len(session["clients"]),
                            "controlAllowed": True
                        })

                    await broadcast_session_state(raw_key)

                # 3. Исключение зрителя ведущим (Kick)
                elif msg_type == "kick-client":
                    if session_info["role"] != "host":
                        continue
                    s_key = session_info["session_key"]
                    session = active_sessions.get(s_key)
                    if not session:
                        continue

                    target_id = payload.get("clientId")
                    if target_id and target_id in session["clients"]:
                        client_data = session["clients"].pop(target_id)
                        c_ws = client_data["ws"]
                        if c_ws and not c_ws.closed:
                            try:
                                await c_ws.send_json({
                                    "type": "kicked",
                                    "message": "Ведущий исключил вас из трансляции."
                                })
                                await c_ws.close()
                            except Exception:
                                pass
                        logger.info(f"Host kicked viewer {client_data['nickname']} ({target_id}) from session {s_key}")
                        await broadcast_session_state(s_key)

                # 4. Маршрутизация SDP Offer
                elif msg_type == "offer":
                    if not session_info["session_key"]:
                        continue
                    s_key = session_info["session_key"]
                    session = active_sessions.get(s_key)
                    if not session:
                        continue

                    target_client_id = payload.get("targetClientId")
                    if target_client_id and target_client_id in session["clients"]:
                        client_ws = session["clients"][target_client_id]["ws"]
                        if client_ws and not client_ws.closed:
                            await client_ws.send_json({
                                "type": "offer",
                                "sdp": payload.get("sdp")
                            })

                # 5. Маршрутизация SDP Answer
                elif msg_type == "answer":
                    if not session_info["session_key"]:
                        continue
                    s_key = session_info["session_key"]
                    session = active_sessions.get(s_key)
                    if not session:
                        continue

                    host_ws = session["host"]
                    if host_ws and not host_ws.closed:
                        await host_ws.send_json({
                            "type": "answer",
                            "clientId": session_info.get("client_id"),
                            "nickname": session_info.get("nickname"),
                            "sdp": payload.get("sdp")
                        })

                # 6. Маршрутизация ICE Candidate
                elif msg_type == "ice-candidate":
                    if not session_info["session_key"]:
                        continue
                    s_key = session_info["session_key"]
                    session = active_sessions.get(s_key)
                    if not session:
                        continue

                    if session_info["role"] == "host":
                        target_client_id = payload.get("targetClientId")
                        if target_client_id and target_client_id in session["clients"]:
                            client_ws = session["clients"][target_client_id]["ws"]
                            if client_ws and not client_ws.closed:
                                await client_ws.send_json({
                                    "type": "ice-candidate",
                                    "candidate": payload.get("candidate")
                                })
                    else:
                        host_ws = session["host"]
                        if host_ws and not host_ws.closed:
                            await host_ws.send_json({
                                "type": "ice-candidate",
                                "clientId": session_info.get("client_id"),
                                "candidate": payload.get("candidate")
                            })

                # 7. Явный сигнал отключения
                elif msg_type == "disconnect-session":
                    if not session_info["session_key"]:
                        continue
                    s_key = session_info["session_key"]
                    session = active_sessions.get(s_key)
                    if session:
                        if session_info["role"] == "host":
                            for c_data in list(session["clients"].values()):
                                c_ws = c_data["ws"]
                                if c_ws and not c_ws.closed:
                                    await c_ws.send_json({
                                        "type": "peer-disconnected",
                                        "message": "Ведущий завершил трансляцию."
                                    })
                            active_sessions.pop(s_key, None)
                        else:
                            c_id = session_info.get("client_id")
                            session["clients"].pop(c_id, None)
                            if session["host"] and not session["host"].closed:
                                await session["host"].send_json({
                                    "type": "client-disconnected",
                                    "clientId": c_id,
                                    "nickname": session_info.get("nickname"),
                                    "viewerCount": len(session["clients"])
                                })
                            await broadcast_session_state(s_key)

                # 8. Прямой ввод мыши и клавиатуры (Гарантированное удаленное управление)
                elif msg_type == "agent-input":
                    s_key = session_info.get("session_key")
                    session = active_sessions.get(s_key)
                    if not session:
                        continue

                    allowed = False
                    if session_info.get("role") == "host":
                        allowed = True
                    elif session_info.get("role") == "client":
                        c_id = session_info.get("client_id")
                        client_obj = session["clients"].get(c_id, {})
                        allowed = client_obj.get("controlAllowed", True)

                    if allowed and os_executor:
                        pkt = payload.get("packet")
                        if pkt and isinstance(pkt, dict):
                            ev_type = pkt.get("type")
                            x = pkt.get("x")
                            y = pkt.get("y")
                            if ev_type == "mousemove":
                                os_executor.move_mouse(x if x is not None else 0.5, y if y is not None else 0.5)
                            elif ev_type == "mousedown":
                                logger.info(f"OS INPUT: mousedown btn={pkt.get('button', 'left')} at ({x}, {y})")
                                os_executor.mouse_down(pkt.get("button", "left"), x, y)
                            elif ev_type == "mouseup":
                                logger.info(f"OS INPUT: mouseup btn={pkt.get('button', 'left')} at ({x}, {y})")
                                os_executor.mouse_up(pkt.get("button", "left"), x, y)
                            elif ev_type == "wheel":
                                os_executor.mouse_wheel(pkt.get("deltaX", 0.0), pkt.get("deltaY", 0.0), x, y)
                            elif ev_type == "keydown":
                                logger.info(f"OS INPUT: keydown key={pkt.get('key')}")
                                os_executor.key_down(pkt.get("key", ""))
                            elif ev_type == "keyup":
                                os_executor.key_up(pkt.get("key", ""))
                            elif ev_type == "combo":
                                logger.info(f"OS INPUT: combo keys={pkt.get('keys')}")
                                os_executor.send_key_combo(pkt.get("keys", []))

                # 9. Управление правами зрителя хостом или самим зрителем
                elif msg_type == "set-control-permission":
                    s_key = session_info.get("session_key")
                    session = active_sessions.get(s_key)
                    if session:
                        if session_info.get("role") == "host":
                            target_id = payload.get("clientId")
                            granted = bool(payload.get("granted", False))
                            if target_id and target_id in session["clients"]:
                                session["clients"][target_id]["controlAllowed"] = granted
                                c_ws = session["clients"][target_id]["ws"]
                                if c_ws and not c_ws.closed:
                                    try:
                                        await c_ws.send_json({
                                            "type": "control-permission",
                                            "granted": granted
                                        })
                                    except Exception:
                                        pass
                                await broadcast_session_state(s_key)
                        elif session_info.get("role") == "client":
                            c_id = session_info.get("client_id")
                            granted = bool(payload.get("granted", True))
                            if c_id and c_id in session["clients"]:
                                session["clients"][c_id]["controlAllowed"] = granted
                                host_ws = session.get("host")
                                if host_ws and not host_ws.closed:
                                    try:
                                        await host_ws.send_json({
                                            "type": "control-permission-changed",
                                            "clientId": c_id,
                                            "granted": granted
                                        })
                                    except Exception:
                                        pass
                                await broadcast_session_state(s_key)

                # 10. Пауза трансляции ведущим
                elif msg_type == "stream-pause-toggle":
                    if session_info.get("role") == "host":
                        s_key = session_info.get("session_key")
                        session = active_sessions.get(s_key)
                        if session:
                            paused = bool(payload.get("paused", False))
                            for c_data in list(session["clients"].values()):
                                c_ws = c_data["ws"]
                                if c_ws and not c_ws.closed:
                                    try:
                                        await c_ws.send_json({
                                            "type": "stream-pause-toggle",
                                            "paused": paused
                                        })
                                    except Exception:
                                        pass

                # 11. Ping
                elif msg_type == "ping":
                    await ws.send_json({"type": "pong", "timestamp": payload.get("timestamp")})

            elif msg.type == web.WSMsgType.ERROR:
                logger.error(f"WebSocket error: {ws.exception()}")

    finally:
        ip_connections[remote_ip] = max(0, ip_connections[remote_ip] - 1)
        if ws in socket_registry:
            info = socket_registry.pop(ws)
            s_key = info.get("session_key")
            role = info.get("role")
            c_id = info.get("client_id")
            nickname = info.get("nickname", "Пользователь")

            if s_key and s_key in active_sessions:
                session = active_sessions[s_key]
                if role == "host":
                    logger.info(f"Host '{nickname}' disconnected. Closing session {s_key}.")
                    for c_data in list(session["clients"].values()):
                        c_ws = c_data["ws"]
                        if c_ws and not c_ws.closed:
                            try:
                                await c_ws.send_json({
                                    "type": "peer-disconnected",
                                    "message": "Ведущий завершил трансляцию."
                                })
                            except Exception:
                                pass
                    active_sessions.pop(s_key, None)
                elif role == "client":
                    logger.info(f"Viewer '{nickname}' ({c_id}) disconnected from session {s_key}")
                    session["clients"].pop(c_id, None)
                    if session["host"] and not session["host"].closed:
                        try:
                            await session["host"].send_json({
                                "type": "client-disconnected",
                                "clientId": c_id,
                                "nickname": nickname,
                                "viewerCount": len(session["clients"])
                            })
                        except Exception:
                            pass
                    await broadcast_session_state(s_key)

    return ws


async def agent_token_handler(request):
    """Provide local agent auth token only to requests from localhost."""
    remote_ip = request.remote or "unknown"
    if remote_ip not in ("127.0.0.1", "::1", "localhost"):
        return web.Response(status=403, text="Forbidden: local access only")

    token = ""
    if TOKEN_FILE.exists():
        try:
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                token = f.read().strip()
        except Exception:
            pass

    return web.json_response(
        {"token": token},
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Access-Control-Allow-Origin": "null"
        }
    )


async def health_handler(request):
    return web.json_response({"status": "ok", "time": time.time()})


async def index_handler(request):
    return web.FileResponse(PUBLIC_DIR / "index.html")


@web.middleware
async def security_headers_middleware(request, handler):
    """Inject strict security headers into every HTTP response."""
    response = await handler(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "connect-src 'self' ws: wss: ws://127.0.0.1:8765; "
        "media-src 'self' blob:; "
        "img-src 'self' data: blob:; "
        "object-src 'none'; "
        "frame-ancestors 'none';"
    )
    response.headers["Permissions-Policy"] = "camera=(), geolocation=(), payment=()"
    return response


def create_app():
    app = web.Application(middlewares=[security_headers_middleware])
    app.router.add_get("/health", health_handler)
    app.router.add_get("/api/agent-token", agent_token_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/", index_handler)
    # Disabled show_index to prevent directory traversal and file listing
    app.router.add_static("/", PUBLIC_DIR, show_index=False)
    return app


# Top-level exports for WSGI/ASGI/hosting runners and test suites
app = create_app()
application = app
handler = app


if __name__ == "__main__":
    logger.info(f"Starting hardened Porthole Signaling & Web Application on port {PORT}...")
    web.run_app(app, host="0.0.0.0", port=PORT)
