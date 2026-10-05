#!/usr/bin/env python3
"""
Native Host Agent for Porthole WebRTC.
Listens on a local WebSocket (ws://127.0.0.1:8765) and executes OS-level
mouse and keyboard actions dispatched by the authenticated Host Web interface.
"""

import asyncio
import json
import logging
import math
import os
import platform
import secrets
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import pyautogui
    pyautogui.FAILSAFE = False  # Prevent corner triggers from crashing remote input
    pyautogui.PAUSE = 0.001     # Ultra-low latency between calls
except ImportError:
    print("[ERROR] pyautogui is required. Install it using: pip install pyautogui")
    sys.exit(1)

# Windows high-performance cursor API
IS_WINDOWS = platform.system() == "Windows"
if IS_WINDOWS:
    import ctypes
    user32 = ctypes.windll.user32

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [AGENT] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("HostAgent")

HOST_AGENT_PORT = 8765
TOKEN_FILE = Path(__file__).parent / ".agent_token"

# Generate or refresh cryptographic auth token
AGENT_AUTH_TOKEN = secrets.token_hex(16)
try:
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        f.write(AGENT_AUTH_TOKEN)
    logger.info("Generated local session security token in .agent_token")
except Exception as e:
    logger.error(f"Failed to write security token: {e}")

# Map web key names to pyautogui recognized key identifiers
KEY_MAP = {
    "ArrowUp": "up",
    "ArrowDown": "down",
    "ArrowLeft": "left",
    "ArrowRight": "right",
    "Enter": "enter",
    "Escape": "esc",
    "Backspace": "backspace",
    "Tab": "tab",
    "Space": "space",
    "Delete": "delete",
    "Insert": "insert",
    "Home": "home",
    "End": "end",
    "PageUp": "pageup",
    "PageDown": "pagedown",
    "Control": "ctrl",
    "Shift": "shift",
    "Alt": "alt",
    "Meta": "win" if IS_WINDOWS else "command",
    "CapsLock": "capslock",
    "NumLock": "numlock",
    "ScrollLock": "scrolllock",
    "PrintScreen": "printscreen"
}

for i in range(1, 13):
    KEY_MAP[f"F{i}"] = f"f{i}"

ALLOWED_KEYS = set(KEY_MAP.keys()) | set(KEY_MAP.values())


class OSInputExecutor:
    def __init__(self):
        self.screen_width, self.screen_height = pyautogui.size()
        logger.info(f"Initialized OS Input Engine. Display: {self.screen_width}x{self.screen_height} px")
        self.packet_count = 0

    def move_mouse(self, norm_x: float, norm_y: float):
        """Move cursor to normalized coordinates (0.0 to 1.0)."""
        if not (isinstance(norm_x, (int, float)) and isinstance(norm_y, (int, float))):
            return
        if not (math.isfinite(norm_x) and math.isfinite(norm_y)):
            return

        clamped_x = max(0.0, min(1.0, float(norm_x)))
        clamped_y = max(0.0, min(1.0, float(norm_y)))
        target_x = int(clamped_x * (self.screen_width - 1))
        target_y = int(clamped_y * (self.screen_height - 1))

        if IS_WINDOWS:
            user32.SetCursorPos(target_x, target_y)
        else:
            pyautogui.moveTo(target_x, target_y, _pause=False)

    def mouse_down(self, button: str = "left", norm_x: float | None = None, norm_y: float | None = None):
        """Simulate mouse button press with optional coordinates."""
        if norm_x is not None and norm_y is not None:
            self.move_mouse(norm_x, norm_y)

        valid_btn = button if button in ("left", "right", "middle") else "left"
        if IS_WINDOWS:
            if valid_btn == "right":
                user32.mouse_event(0x0008, 0, 0, 0, 0)  # MOUSEEVENTF_RIGHTDOWN
            elif valid_btn == "middle":
                user32.mouse_event(0x0020, 0, 0, 0, 0)  # MOUSEEVENTF_MIDDLEDOWN
            else:
                user32.mouse_event(0x0002, 0, 0, 0, 0)  # MOUSEEVENTF_LEFTDOWN
        else:
            try:
                pyautogui.mouseDown(button=valid_btn)
            except Exception:
                pass

    def mouse_up(self, button: str = "left", norm_x: float | None = None, norm_y: float | None = None):
        """Simulate mouse button release with optional coordinates."""
        if norm_x is not None and norm_y is not None:
            self.move_mouse(norm_x, norm_y)

        valid_btn = button if button in ("left", "right", "middle") else "left"
        if IS_WINDOWS:
            if valid_btn == "right":
                user32.mouse_event(0x0010, 0, 0, 0, 0)  # MOUSEEVENTF_RIGHTUP
            elif valid_btn == "middle":
                user32.mouse_event(0x0040, 0, 0, 0, 0)  # MOUSEEVENTF_MIDDLEUP
            else:
                user32.mouse_event(0x0004, 0, 0, 0, 0)  # MOUSEEVENTF_LEFTUP
        else:
            try:
                pyautogui.mouseUp(button=valid_btn)
            except Exception:
                pass

    def mouse_wheel(self, delta_x: float, delta_y: float, norm_x: float | None = None, norm_y: float | None = None):
        """Simulate mouse scroll wheel."""
        if norm_x is not None and norm_y is not None:
            self.move_mouse(norm_x, norm_y)

        if not (isinstance(delta_x, (int, float)) and isinstance(delta_y, (int, float))):
            return
        if not (math.isfinite(delta_x) and math.isfinite(delta_y)):
            return

        if delta_y != 0:
            if IS_WINDOWS:
                # Windows WHEEL_DELTA is 120 per notch; web deltaY > 0 is scroll down
                clicks = int(-delta_y)
                # clamp to prevent erratic jumps
                clicks = max(-360, min(360, clicks))
                user32.mouse_event(0x0800, 0, 0, clicks, 0)  # MOUSEEVENTF_WHEEL
            else:
                clicks = int(-delta_y / 25)
                if clicks == 0:
                    clicks = -1 if delta_y > 0 else 1
                clicks = max(-20, min(20, clicks))
                try:
                    pyautogui.scroll(clicks)
                except Exception:
                    pass

        if delta_x != 0 and hasattr(pyautogui, "hscroll"):
            h_clicks = int(-delta_x / 25)
            h_clicks = max(-20, min(20, h_clicks))
            try:
                pyautogui.hscroll(h_clicks)
            except Exception:
                pass

    def _sanitize_key(self, key: str) -> str | None:
        if not isinstance(key, str) or len(key) > 32:
            return None
        if key in KEY_MAP:
            return KEY_MAP[key]
        if key.lower() in ALLOWED_KEYS:
            return key.lower()
        if len(key) == 1 and (key.isascii() or ord(key) > 127):
            return key.lower()
        return None

    def key_down(self, key: str):
        """Simulate key down event."""
        if not key or not isinstance(key, str):
            return
        if key in KEY_MAP:
            try:
                pyautogui.keyDown(KEY_MAP[key])
            except Exception:
                pass
            return

        target_key = self._sanitize_key(key)
        if target_key:
            try:
                pyautogui.keyDown(target_key)
                return
            except Exception:
                pass

        # Fallback for unicode or special characters
        if len(key) == 1:
            try:
                pyautogui.write(key)
            except Exception:
                pass

    def key_up(self, key: str):
        """Simulate key up event."""
        if not key or not isinstance(key, str):
            return
        if key in KEY_MAP:
            try:
                pyautogui.keyUp(KEY_MAP[key])
            except Exception:
                pass
            return

        target_key = self._sanitize_key(key)
        if target_key:
            try:
                pyautogui.keyUp(target_key)
            except Exception:
                pass

    def send_key_combo(self, combo: list):
        """Execute a key combination (e.g. ['ctrl', 'alt', 'del'])."""
        if not isinstance(combo, list) or len(combo) > 4:
            return
        sanitized = []
        for k in combo:
            target = self._sanitize_key(k)
            if target:
                sanitized.append(target)
        if not sanitized:
            return
        try:
            pyautogui.hotkey(*sanitized)
        except Exception as e:
            logger.warning(f"Failed combo {sanitized}: {e}")


executor = OSInputExecutor()


async def handle_agent_client(websocket):
    remote = websocket.remote_address[0] if websocket.remote_address else "127.0.0.1"

    # Strict loopback connection verification: only localhost can connect
    if remote not in ("127.0.0.1", "::1", "localhost"):
        logger.warning(f"Connection rejected from non-local address: {remote}")
        await websocket.close(4403, "Forbidden")
        return

    # Origin header verification
    headers = getattr(websocket, "request", None)
    origin = ""
    if headers and hasattr(headers, "headers"):
        origin = headers.headers.get("origin", "")
    elif hasattr(websocket, "request_headers"):
        origin = websocket.request_headers.get("Origin", "")

    if origin:
        parsed_orig = urlparse(origin)
        hostname = (parsed_orig.hostname or "").lower()
        allowed_hosts = ("localhost", "127.0.0.1", "::1")
        is_allowed = (
            hostname in allowed_hosts or
            hostname.endswith(".pinggy.link") or
            hostname.endswith(".pinggy-free.link") or
            hostname.endswith(".pinggy.net") or
            hostname.endswith(".pinggy.io") or
            hostname.endswith(".onrender.com") or
            hostname.endswith(".localhost.run")
        )
        if not is_allowed:
            logger.warning(f"Rejected connection with untrusted origin: {origin}")
            await websocket.close(4403, "Untrusted Origin")
            return

    # Check query param for token if present
    req_path = getattr(websocket, "request", None)
    path_str = getattr(req_path, "path", "/") if req_path else "/"
    parsed_path = urlparse(path_str)
    qs = parse_qs(parsed_path.query)
    url_token = qs.get("token", [None])[0]

    authenticated = (url_token == AGENT_AUTH_TOKEN)

    # If not authenticated via query param, require auth message within 3 seconds
    if not authenticated:
        try:
            raw_auth = await asyncio.wait_for(websocket.recv(), timeout=3.0)
            auth_pkt = json.loads(raw_auth)
            if auth_pkt.get("type") == "auth" and auth_pkt.get("token") == AGENT_AUTH_TOKEN:
                authenticated = True
            else:
                logger.warning("Agent authentication failed: invalid token")
                await websocket.close(4401, "Unauthorized")
                return
        except (asyncio.TimeoutError, json.JSONDecodeError, Exception) as e:
            logger.warning(f"Agent authentication handshake failed: {e}")
            await websocket.close(4401, "Auth Handshake Failed")
            return

    logger.info(f"Host Web Bridge authenticated successfully from {remote}")

    # Send initial display resolution and handshake confirmation
    await websocket.send(json.dumps({
        "type": "agent-handshake",
        "status": "ready",
        "screenWidth": executor.screen_width,
        "screenHeight": executor.screen_height,
        "platform": platform.platform()
    }))

    # Rate limiting variables (max 120 packets / sec)
    rate_window_start = time.time()
    packet_rate_count = 0
    MAX_PACKETS_PER_SEC = 120

    try:
        async for raw_msg in websocket:
            # Enforce max message size (8 KB)
            if len(raw_msg) > 8192:
                continue

            now = time.time()
            if now - rate_window_start >= 1.0:
                rate_window_start = now
                packet_rate_count = 0

            packet_rate_count += 1
            if packet_rate_count > MAX_PACKETS_PER_SEC:
                # Drop excess packets to protect host OS from event flooding
                continue

            try:
                pkt = json.loads(raw_msg)
            except json.JSONDecodeError:
                continue

            event_type = pkt.get("type")
            executor.packet_count += 1

            if event_type == "mousemove":
                executor.move_mouse(pkt.get("x", 0.0), pkt.get("y", 0.0))

            elif event_type == "mousedown":
                executor.mouse_down(pkt.get("button", "left"))

            elif event_type == "mouseup":
                executor.mouse_up(pkt.get("button", "left"))

            elif event_type == "wheel":
                executor.mouse_wheel(pkt.get("deltaX", 0.0), pkt.get("deltaY", 0.0))

            elif event_type == "keydown":
                executor.key_down(pkt.get("key", ""))

            elif event_type == "keyup":
                executor.key_up(pkt.get("key", ""))

            elif event_type == "combo":
                executor.send_key_combo(pkt.get("keys", []))

            elif event_type == "ping":
                await websocket.send(json.dumps({
                    "type": "pong",
                    "timestamp": pkt.get("timestamp")
                }))

            if executor.packet_count % 1000 == 0:
                logger.info(f"Processed {executor.packet_count} remote input packets.")

    except Exception:
        logger.info("Host Web Bridge disconnected.")


async def main():
    import websockets
    logger.info(f"Starting Native Desktop Host Agent on ws://127.0.0.1:{HOST_AGENT_PORT}")
    logger.info("Ready for secure connections from Host Web Application...")
    async with websockets.serve(handle_agent_client, "127.0.0.1", HOST_AGENT_PORT, max_size=8192):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Host Agent stopped by operator.")
