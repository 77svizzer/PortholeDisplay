/**
 * PORTHOLE // WEBRTC CORE CLIENT
 * Natural mouse & keyboard remote control without Pointer Lock.
 * Multi-viewer streaming, mandatory nicknames, granular control permissions,
 * host live preview, mic audio, P2P file transfer, and chat.
 */

(function () {
    'use strict';

    // --- Configuration ---
    function resolveSignalingUrl() {
        const urlParams = new URLSearchParams(window.location.search);
        let custom = urlParams.get('server') || localStorage.getItem('porthole_signaling_url');
        if (custom) {
            custom = custom.trim();
            if (custom.startsWith('http://')) custom = 'ws://' + custom.slice(7);
            else if (custom.startsWith('https://')) custom = 'wss://' + custom.slice(8);
            else if (!custom.startsWith('ws://') && !custom.startsWith('wss://')) {
                custom = (location.protocol === 'https:' ? 'wss://' : 'ws://') + custom;
            }
            if (!custom.endsWith('/ws')) {
                custom = custom.replace(/\/+$/, '') + '/ws';
            }
            return custom;
        }
        const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${wsProto}//${location.host}/ws`;
    }

    let SIGNALING_URL = resolveSignalingUrl();
    const AGENT_WS_URL = 'ws://127.0.0.1:8765';

    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ]
    };

    const CHUNK_SIZE = 16384; // 16 KB chunks for DataChannel file transfer

    // --- DOM Elements ---
    const el = {
        serverStatusDot: document.getElementById('server-status-dot'),
        serverStatusText: document.getElementById('server-status-text'),
        lobbyView: document.getElementById('lobby-view'),
        sessionView: document.getElementById('session-view'),

        // Никнейм
        userNickname: document.getElementById('user-nickname'),

        // Вкладки
        tabBtnShare: document.getElementById('tab-btn-share'),
        tabBtnConnect: document.getElementById('tab-btn-connect'),
        tabContentShare: document.getElementById('tab-content-share'),
        tabContentConnect: document.getElementById('tab-content-connect'),

        // Хост (трансляция)
        shareIdleState: document.getElementById('share-idle-state'),
        shareActiveState: document.getElementById('share-active-state'),
        btnStartHost: document.getElementById('btn-start-host'),
        btnStopHost: document.getElementById('btn-stop-host'),
        optHostMic: document.getElementById('opt-host-mic'),
        localSessionKey: document.getElementById('local-session-key'),
        btnCopyKey: document.getElementById('btn-copy-key'),
        btnCopyLink: document.getElementById('btn-copy-link'),
        hostViewerCount: document.getElementById('host-viewer-count'),
        hostPreviewVideo: document.getElementById('host-preview-video'),
        participantsCountTag: document.getElementById('participants-count-tag'),
        participantsList: document.getElementById('participants-list'),
        btnToggleMic: document.getElementById('btn-toggle-mic'),
        micStatusText: document.getElementById('mic-status-text'),
        btnHostOpenFile: document.getElementById('btn-host-open-file'),
        hostFileInput: document.getElementById('host-file-input'),
        hostChatMessages: document.getElementById('host-chat-messages'),
        hostChatForm: document.getElementById('host-chat-form'),
        hostChatInput: document.getElementById('host-chat-input'),

        // Клиент (подключение)
        connectForm: document.getElementById('connect-form'),
        remoteKeyInput: document.getElementById('remote-session-key'),
        btnConnectRemote: document.getElementById('btn-connect-remote'),

        // Окно сессии (зритель)
        hudTargetKey: document.getElementById('hud-target-key'),
        hudControlStatus: document.getElementById('hud-control-status'),
        permStatusText: document.getElementById('perm-status-text'),
        hudViewersCount: document.getElementById('hud-viewers-count'),
        hudRtt: document.getElementById('hud-rtt'),
        hudFps: document.getElementById('hud-fps'),
        hudRes: document.getElementById('hud-res'),
        btnRequestControl: document.getElementById('btn-request-control'),
        btnToggleChat: document.getElementById('btn-toggle-chat'),
        chatUnreadBadge: document.getElementById('chat-unread-badge'),
        btnViewerOpenFile: document.getElementById('btn-viewer-open-file'),
        viewerFileInput: document.getElementById('viewer-file-input'),
        btnSendCad: document.getElementById('btn-send-cad'),
        btnFullscreen: document.getElementById('btn-fullscreen'),
        btnDisconnect: document.getElementById('btn-disconnect'),
        sessionChatPanel: document.getElementById('session-chat-panel'),
        btnCloseChat: document.getElementById('btn-close-chat'),
        viewerChatMessages: document.getElementById('viewer-chat-messages'),
        viewerChatForm: document.getElementById('viewer-chat-form'),
        viewerChatInput: document.getElementById('viewer-chat-input'),
        viewportStage: document.getElementById('viewport-stage'),
        remoteVideo: document.getElementById('remote-video'),
        remoteAudio: document.getElementById('remote-audio'),

        // Тост
        toastContainer: document.getElementById('toast-container'),
        toastMessage: document.getElementById('toast-message'),

        // Тема оформления
        btnThemeToggle: document.getElementById('btn-theme-toggle'),
        themeIconSun: document.querySelector('.theme-icon-sun'),
        themeIconMoon: document.querySelector('.theme-icon-moon'),

        // Док ведущего
        btnPauseHost: document.getElementById('btn-pause-host'),
        pauseStatusText: document.getElementById('pause-status-text'),
        hostPauseOverlay: document.getElementById('host-pause-overlay'),
        btnHostShareLink: document.getElementById('btn-host-share-link'),
        hostMicOnIcon: document.querySelector('.host-dock .mic-on-icon'),
        hostMicOffIcon: document.querySelector('.host-dock .mic-off-icon'),
        hostPauseIcon: document.querySelector('.host-dock .pause-icon'),
        hostResumeIcon: document.querySelector('.host-dock .resume-icon'),

        // Док зрителя
        viewerPauseOverlay: document.getElementById('viewer-pause-overlay'),
        controlTooltip: document.getElementById('control-tooltip'),
        remoteClickRipple: document.getElementById('remote-click-ripple')
    };

    // --- State Management ---
    const state = {
        role: null,                 // 'host' | 'client' | null
        sessionKey: null,
        myClientId: null,
        myNickname: '',
        signalingWs: null,
        agentWs: null,
        agentToken: null,

        // Host multi-client storage: clientId -> { pc, dc, nickname, controlAllowed: boolean }
        hostClients: {},

        // Client single connection
        clientPc: null,
        clientDc: null,
        clientIceQueue: [],
        hasControlPermission: true, // Default: control allowed

        localStream: null,
        micStream: null,
        isMicActive: false,
        isStreamPaused: false,

        // File transfer assembly: fileId -> { name, size, mimeType, chunks: [], totalChunks, receivedChunks }
        incomingFiles: {},

        statsInterval: null,
        pingInterval: null,
        unreadChatCount: 0,
        mouseThrottled: false,
        toastTimer: null,
        rippleTimer: null
    };

    // --- Инициализация никнейма ---
    const savedNick = localStorage.getItem('porthole_nickname') || '';
    if (savedNick) {
        el.userNickname.value = savedNick;
    }

    function getValidatedNickname() {
        const raw = el.userNickname.value.trim();
        const val = raw.replace(/[^\w\s\u0400-\u04FF\.\-_]/g, '').trim().substring(0, 24);
        if (!val) {
            el.userNickname.focus();
            showToast('Пожалуйста, введите ваш никнейм');
            return null;
        }
        el.userNickname.value = val;
        localStorage.setItem('porthole_nickname', val);
        state.myNickname = val;
        return val;
    }

    // --- Управление темой оформления ---
    const savedTheme = localStorage.getItem('porthole_theme') || 'dark';
    applyTheme(savedTheme);

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('porthole_theme', theme);
        if (theme === 'light') {
            if (el.themeIconSun) el.themeIconSun.classList.remove('hidden');
            if (el.themeIconMoon) el.themeIconMoon.classList.add('hidden');
        } else {
            if (el.themeIconSun) el.themeIconSun.classList.add('hidden');
            if (el.themeIconMoon) el.themeIconMoon.classList.remove('hidden');
        }
    }

    if (el.btnThemeToggle) {
        el.btnThemeToggle.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            showToast(`Включена ${next === 'dark' ? 'темная' : 'светлая'} тема`);
        });
    }

    // --- Визуальный эффект клика (Ripple) ---
    function showClickRipple(clientX, clientY) {
        if (!el.remoteClickRipple || !el.viewportStage) return;
        const rect = el.viewportStage.getBoundingClientRect();
        const rx = clientX - rect.left;
        const ry = clientY - rect.top;
        el.remoteClickRipple.style.left = `${rx}px`;
        el.remoteClickRipple.style.top = `${ry}px`;
        el.remoteClickRipple.classList.remove('hidden');
        clearTimeout(state.rippleTimer);
        state.rippleTimer = setTimeout(() => {
            if (el.remoteClickRipple) el.remoteClickRipple.classList.add('hidden');
        }, 450);
    }

    // --- Уведомления ---
    function showToast(message, duration = 2500) {
        if (!el.toastContainer || !el.toastMessage) return;
        el.toastMessage.textContent = message;
        el.toastContainer.classList.remove('toast-hidden');

        clearTimeout(state.toastTimer);
        state.toastTimer = setTimeout(() => {
            el.toastContainer.classList.add('toast-hidden');
        }, duration);
    }

    // --- Переключение вкладок ---
    function setTab(tabName) {
        if (tabName === 'share') {
            el.tabBtnShare.classList.add('active');
            el.tabBtnConnect.classList.remove('active');
            el.tabContentShare.classList.remove('hidden');
            el.tabContentConnect.classList.add('hidden');
        } else {
            el.tabBtnConnect.classList.add('active');
            el.tabBtnShare.classList.remove('active');
            el.tabContentConnect.classList.remove('hidden');
            el.tabContentShare.classList.add('hidden');
            el.remoteKeyInput.focus();
        }
    }

    el.tabBtnShare.addEventListener('click', () => setTab('share'));
    el.tabBtnConnect.addEventListener('click', () => setTab('connect'));

    // --- Форматирование 9-значного кода ---
    function formatKey(val) {
        const digits = val.replace(/\D/g, '').slice(0, 9);
        const parts = [];
        for (let i = 0; i < digits.length; i += 3) {
            parts.push(digits.slice(i, i + 3));
        }
        return parts.join('-');
    }

    el.remoteKeyInput.addEventListener('input', (e) => {
        const cursor = e.target.selectionStart;
        const oldLen = e.target.value.length;
        e.target.value = formatKey(e.target.value);
        const newLen = e.target.value.length;
        if (cursor < oldLen) {
            e.target.setSelectionRange(cursor, cursor);
        }
    });

    el.btnCopyKey.addEventListener('click', () => {
        if (!state.sessionKey) return;
        navigator.clipboard.writeText(state.sessionKey).then(() => {
            showToast(`Код ${state.sessionKey} скопирован`);
        });
    });

    el.btnCopyLink.addEventListener('click', () => {
        if (!state.sessionKey) return;
        const directUrl = `${location.origin}${location.pathname}?join=${encodeURIComponent(state.sessionKey)}`;
        navigator.clipboard.writeText(directUrl).then(() => {
            showToast('Прямая ссылка для зрителей скопирована');
        });
    });

    // =========================================================================
    // 1. СЕРВЕР СИГНАЛИЗАЦИИ
    // =========================================================================
    function initSignaling() {
        if (state.signalingWs && (state.signalingWs.readyState === WebSocket.OPEN || state.signalingWs.readyState === WebSocket.CONNECTING)) {
            return;
        }

        SIGNALING_URL = resolveSignalingUrl();

        try {
            state.signalingWs = new WebSocket(SIGNALING_URL);
        } catch (e) {
            updateStatus(false);
            return;
        }

        state.signalingWs.onopen = () => {
            updateStatus(true);
            checkUrlParameters();
        };

        state.signalingWs.onclose = () => {
            updateStatus(false);
            setTimeout(initSignaling, 3000);
        };

        state.signalingWs.onerror = () => {
            updateStatus(false);
        };

        state.signalingWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleSignalingMessage(msg);
            } catch (err) {}
        };
    }

    function updateStatus(online) {
        if (!el.serverStatusDot || !el.serverStatusText) return;
        if (online) {
            el.serverStatusDot.className = 'status-dot online';
            el.serverStatusText.textContent = 'Онлайн';
            if (el.serverStatusDot.parentElement) {
                el.serverStatusDot.parentElement.title = 'Сервер подключен: ' + SIGNALING_URL;
            }
        } else {
            el.serverStatusDot.className = 'status-dot';
            el.serverStatusText.textContent = 'Подключение...';
            if (el.serverStatusDot.parentElement) {
                el.serverStatusDot.parentElement.title = 'Попытка подключения к ' + SIGNALING_URL + ' (нажмите для смены адреса)';
            }
        }
    }

    // Позволяет вручную указать адрес сервера сигнализации (например, при размещении на Vercel)
    if (el.serverStatusDot && el.serverStatusDot.parentElement) {
        el.serverStatusDot.parentElement.style.cursor = 'pointer';
        el.serverStatusDot.parentElement.addEventListener('click', () => {
            const current = localStorage.getItem('porthole_signaling_url') || location.host;
            const input = prompt(
                'Адрес сервера сигнализации (например: porthole.onrender.com или wss://.../ws):\n(Оставьте пустым для сброса на текущий адрес)',
                current
            );
            if (input !== null) {
                const trimmed = input.trim();
                if (trimmed) {
                    localStorage.setItem('porthole_signaling_url', trimmed);
                } else {
                    localStorage.removeItem('porthole_signaling_url');
                }
                SIGNALING_URL = resolveSignalingUrl();
                if (state.signalingWs) {
                    state.signalingWs.close();
                }
                initSignaling();
                showToast('Адрес сервера: ' + SIGNALING_URL);
            }
        });
    }

    function sendSignaling(msg) {
        if (state.signalingWs && state.signalingWs.readyState === WebSocket.OPEN) {
            state.signalingWs.send(JSON.stringify(msg));
        } else {
            showToast('Нет связи с сервером');
        }
    }

    function handleSignalingMessage(msg) {
        switch (msg.type) {
            case 'host-registered':
                state.sessionKey = msg.sessionKey;
                el.localSessionKey.textContent = msg.sessionKey;
                el.shareIdleState.classList.add('hidden');
                el.shareActiveState.classList.remove('hidden');
                el.hostViewerCount.textContent = '0';
                renderParticipantsList();
                showToast(`Сессия открыта: ${msg.sessionKey}`);
                break;

            case 'session-participants':
                if (el.hostViewerCount) el.hostViewerCount.textContent = msg.count;
                if (el.hudViewersCount) el.hudViewersCount.textContent = msg.count;
                if (state.role === 'host') {
                    msg.participants.forEach(p => {
                        if (state.hostClients[p.clientId]) {
                            state.hostClients[p.clientId].nickname = p.nickname;
                            if (p.controlAllowed !== undefined) {
                                state.hostClients[p.clientId].controlAllowed = !!p.controlAllowed;
                            }
                        }
                    });
                    renderParticipantsList();
                }
                break;

            case 'client-joined':
                showToast(`"${msg.nickname}" подключился (всего: ${msg.viewerCount})`);
                if (el.hostViewerCount) el.hostViewerCount.textContent = msg.viewerCount;
                createHostPeerConnectionForClient(msg.clientId, msg.nickname);
                break;

            case 'join-success':
                state.myClientId = msg.clientId;
                state.hasControlPermission = (msg.controlAllowed !== undefined) ? !!msg.controlAllowed : true;
                updateViewerPermissionBadge(state.hasControlPermission);
                if (el.hudViewersCount) el.hudViewersCount.textContent = msg.viewerCount || '1';
                showToast(`Вы подключились к трансляции "${msg.hostNickname}"`);
                switchToSessionView();
                break;

            case 'join-error':
                showToast(msg.message || 'Ошибка подключения');
                if (el.btnConnectRemote) {
                    el.btnConnectRemote.disabled = false;
                    el.btnConnectRemote.textContent = 'Подключиться к трансляции';
                }
                resetToLobby();
                break;

            case 'offer':
                if (state.role === 'client') {
                    handleRemoteOffer(msg.sdp);
                }
                break;

            case 'answer':
                if (state.role === 'host' && msg.clientId && state.hostClients[msg.clientId]) {
                    const client = state.hostClients[msg.clientId];
                    client.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(() => {
                        if (client.iceQueue) {
                            while (client.iceQueue.length > 0) {
                                const cand = client.iceQueue.shift();
                                client.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
                            }
                        }
                    }).catch(() => {});
                }
                break;

            case 'ice-candidate':
                if (state.role === 'host') {
                    if (msg.clientId && state.hostClients[msg.clientId]) {
                        const client = state.hostClients[msg.clientId];
                        if (client.pc && client.pc.remoteDescription) {
                            client.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
                        } else {
                            if (!client.iceQueue) client.iceQueue = [];
                            client.iceQueue.push(msg.candidate);
                        }
                    }
                } else if (state.role === 'client') {
                    if (state.clientPc && state.clientPc.remoteDescription) {
                        state.clientPc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
                    } else {
                        state.clientIceQueue.push(msg.candidate);
                    }
                }
                break;

            case 'peer-disconnected':
                showToast(msg.message || 'Сессия завершена ведущим');
                resetToLobby();
                break;

            case 'kicked':
                showToast(msg.message || 'Ведущий исключил вас из трансляции');
                resetToLobby();
                break;

            case 'stream-pause-toggle':
                if (state.role === 'client' && el.viewerPauseOverlay) {
                    if (msg.paused) {
                        el.viewerPauseOverlay.classList.remove('hidden');
                    } else {
                        el.viewerPauseOverlay.classList.add('hidden');
                    }
                }
                break;

            case 'control-permission':
                if (state.role === 'client') {
                    state.hasControlPermission = !!msg.granted;
                    updateViewerPermissionBadge(state.hasControlPermission);
                    if (state.hasControlPermission) {
                        showToast('Управление мышью и клавиатурой активно');
                    } else {
                        showToast('Управление ПК приостановлено (режим просмотра)');
                    }
                }
                break;

            case 'control-permission-changed':
                if (state.role === 'host' && msg.clientId && state.hostClients[msg.clientId]) {
                    state.hostClients[msg.clientId].controlAllowed = !!msg.granted;
                    renderParticipantsList();
                }
                break;

            case 'client-disconnected':
                if (msg.clientId && state.hostClients[msg.clientId]) {
                    state.hostClients[msg.clientId].pc.close();
                    delete state.hostClients[msg.clientId];
                    renderParticipantsList();
                }
                if (el.hostViewerCount) el.hostViewerCount.textContent = msg.viewerCount;
                showToast(`"${msg.nickname || 'Зритель'}" отключился`);
                break;
        }
    }

    // =========================================================================
    // 2. ХОСТ: ТРАНСЛЯЦИЯ И РАЗДАЧА ПРАВ
    // =========================================================================
    el.btnStartHost.addEventListener('click', async () => {
        const nick = getValidatedNickname();
        if (!nick) return;

        try {
            state.localStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: { ideal: 60, max: 60 },
                    cursor: 'always'
                },
                audio: false
            });

            state.role = 'host';

            // Превью экрана хоста
            if (el.hostPreviewVideo) {
                el.hostPreviewVideo.srcObject = state.localStream;
            }

            // Опциональный микрофон
            if (el.optHostMic.checked) {
                await enableMicAudio();
            }

            // Подключение к локальному агенту OS (pyautogui)
            connectToHostAgent();

            state.localStream.getVideoTracks()[0].onended = () => {
                stopHosting();
            };

            sendSignaling({
                type: 'register-host',
                nickname: nick
            });

        } catch (err) {
            showToast('Запуск трансляции отменен');
        }
    });

    async function connectToHostAgent() {
        if (state.agentWs && (state.agentWs.readyState === WebSocket.OPEN || state.agentWs.readyState === WebSocket.CONNECTING)) return;

        if (!state.agentToken) {
            try {
                const res = await fetch('/api/agent-token');
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.token) {
                        state.agentToken = data.token;
                    }
                }
            } catch (e) {}
        }

        try {
            const tokenQuery = state.agentToken ? `?token=${encodeURIComponent(state.agentToken)}` : '';
            state.agentWs = new WebSocket(`${AGENT_WS_URL}/${tokenQuery}`);
            state.agentWs.onopen = () => {
                if (state.agentToken) {
                    state.agentWs.send(JSON.stringify({
                        type: 'auth',
                        token: state.agentToken
                    }));
                }
            };
            state.agentWs.onclose = () => { state.agentWs = null; };
            state.agentWs.onerror = () => { state.agentWs = null; };
        } catch (e) {
            state.agentWs = null;
        }
    }

    function updateMicUI(isActive) {
        if (isActive) {
            if (el.micStatusText) el.micStatusText.textContent = 'Микрофон: вкл';
            if (el.btnToggleMic) el.btnToggleMic.classList.add('active');
            if (el.hostMicOnIcon) el.hostMicOnIcon.classList.remove('hidden');
            if (el.hostMicOffIcon) el.hostMicOffIcon.classList.add('hidden');
        } else {
            if (el.micStatusText) el.micStatusText.textContent = 'Микрофон: выкл';
            if (el.btnToggleMic) el.btnToggleMic.classList.remove('active');
            if (el.hostMicOnIcon) el.hostMicOnIcon.classList.add('hidden');
            if (el.hostMicOffIcon) el.hostMicOffIcon.classList.remove('hidden');
        }
    }

    async function enableMicAudio() {
        try {
            if (!state.micStream || !state.micStream.getAudioTracks()[0] || state.micStream.getAudioTracks()[0].readyState === 'ended') {
                state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
            const audioTrack = state.micStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = true;
            }
            state.isMicActive = true;
            updateMicUI(true);

            for (const cId in state.hostClients) {
                const client = state.hostClients[cId];
                if (!client || !client.pc) continue;

                const senders = client.pc.getSenders();
                const audioSender = senders.find(s => s.track?.kind === 'audio' || (s.dtlsTransport && s.track === null));
                if (audioSender) {
                    audioSender.replaceTrack(audioTrack).catch(() => {});
                } else {
                    try {
                        client.pc.addTrack(audioTrack, state.micStream);
                    } catch (e) {}
                }
            }
            showToast('Микрофон включен');
        } catch (e) {
            state.isMicActive = false;
            updateMicUI(false);
            showToast('Микрофон недоступен');
        }
    }

    function toggleMic() {
        if (!state.localStream) return;

        if (!state.isMicActive) {
            if (state.micStream && state.micStream.getAudioTracks()[0] && state.micStream.getAudioTracks()[0].readyState === 'live') {
                const audioTrack = state.micStream.getAudioTracks()[0];
                audioTrack.enabled = true;
                state.isMicActive = true;
                updateMicUI(true);
                showToast('Микрофон включен');
            } else {
                enableMicAudio();
            }
        } else {
            // Мягкое отключение без уничтожения потока: звук перестает идти, но канал связи не разрывается
            if (state.micStream) {
                const audioTrack = state.micStream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = false;
                }
            }
            state.isMicActive = false;
            updateMicUI(false);
            showToast('Микрофон выключен');
        }
    }

    el.btnToggleMic.addEventListener('click', toggleMic);
    el.btnStopHost.addEventListener('click', stopHosting);

    if (el.btnPauseHost) {
        el.btnPauseHost.addEventListener('click', () => {
            if (!state.localStream) return;
            const vTrack = state.localStream.getVideoTracks()[0];
            if (!vTrack) return;

            state.isStreamPaused = !state.isStreamPaused;
            vTrack.enabled = !state.isStreamPaused;

            if (state.isStreamPaused) {
                el.btnPauseHost.classList.add('dock-btn-amber');
                if (el.hostPauseIcon) el.hostPauseIcon.classList.add('hidden');
                if (el.hostResumeIcon) el.hostResumeIcon.classList.remove('hidden');
                if (el.pauseStatusText) el.pauseStatusText.textContent = 'Возобновить';
                if (el.hostPauseOverlay) el.hostPauseOverlay.classList.remove('hidden');
                showToast('Трансляция приостановлена');
            } else {
                el.btnPauseHost.classList.remove('dock-btn-amber');
                if (el.hostPauseIcon) el.hostPauseIcon.classList.remove('hidden');
                if (el.hostResumeIcon) el.hostResumeIcon.classList.add('hidden');
                if (el.pauseStatusText) el.pauseStatusText.textContent = 'Приостановить';
                if (el.hostPauseOverlay) el.hostPauseOverlay.classList.add('hidden');
                showToast('Трансляция возобновлена');
            }

            sendSignaling({
                type: 'stream-pause-toggle',
                paused: state.isStreamPaused
            });
        });
    }

    if (el.btnHostShareLink) {
        el.btnHostShareLink.addEventListener('click', () => {
            if (!state.sessionKey) return;
            const directUrl = `${location.origin}${location.pathname}?join=${encodeURIComponent(state.sessionKey)}`;
            navigator.clipboard.writeText(directUrl).then(() => {
                showToast('Ссылка на трансляцию скопирована');
            });
        });
    }

    function stopHosting() {
        if (state.localStream) {
            state.localStream.getTracks().forEach(track => track.stop());
            state.localStream = null;
        }

        if (state.micStream) {
            state.micStream.getTracks().forEach(track => track.stop());
            state.micStream = null;
        }
        state.isMicActive = false;
        updateMicUI(false);

        // Сброс состояния паузы
        state.isStreamPaused = false;
        if (el.hostPauseOverlay) el.hostPauseOverlay.classList.add('hidden');
        if (el.btnPauseHost) {
            el.btnPauseHost.classList.remove('dock-btn-amber');
            if (el.hostPauseIcon) el.hostPauseIcon.classList.remove('hidden');
            if (el.hostResumeIcon) el.hostResumeIcon.classList.add('hidden');
            if (el.pauseStatusText) el.pauseStatusText.textContent = 'Приостановить';
        }

        if (el.hostPreviewVideo) {
            el.hostPreviewVideo.srcObject = null;
        }

        if (state.agentWs) {
            state.agentWs.close();
            state.agentWs = null;
        }

        for (const cId in state.hostClients) {
            try { state.hostClients[cId].pc.close(); } catch (e) {}
        }
        state.hostClients = {};

        if (state.sessionKey) {
            sendSignaling({ type: 'disconnect-session' });
        }

        state.role = null;
        state.sessionKey = null;
        el.localSessionKey.textContent = '--- --- ---';
        el.shareActiveState.classList.add('hidden');
        el.shareIdleState.classList.remove('hidden');

        showToast('Трансляция остановлена');
    }

    async function createHostPeerConnectionForClient(clientId, nickname) {
        connectToHostAgent();

        const pc = new RTCPeerConnection(RTC_CONFIG);

        state.localStream.getTracks().forEach(track => {
            pc.addTrack(track, state.localStream);
        });

        if (state.isMicActive && state.micStream) {
            state.micStream.getAudioTracks().forEach(track => {
                pc.addTrack(track, state.micStream);
            });
        } else {
            // Подготавливаем аудио-трансивер в SDP для динамического включения микрофона
            try {
                pc.addTransceiver('audio', { direction: 'sendonly' });
            } catch (e) {}
        }

        const dc = pc.createDataChannel('control', { ordered: true });
        state.hostClients[clientId] = {
            pc,
            dc,
            nickname: nickname || 'Зритель',
            controlAllowed: true // По умолчанию: УПРАВЛЕНИЕ РАЗРЕШЕНО
        };

        renderParticipantsList();

        dc.onmessage = (event) => {
            try {
                const pkt = JSON.parse(event.data);
                handleHostReceivedPacket(pkt, clientId);
            } catch (e) {}
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignaling({
                    type: 'ice-candidate',
                    targetClientId: clientId,
                    candidate: event.candidate
                });
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sendSignaling({
            type: 'offer',
            targetClientId: clientId,
            sdp: pc.localDescription
        });
    }

    function renderParticipantsList() {
        if (!el.participantsList) return;
        el.participantsList.replaceChildren();

        const clientIds = Object.keys(state.hostClients);
        el.participantsCountTag.textContent = `${clientIds.length} чел.`;

        if (clientIds.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-list-note';
            empty.textContent = 'Зрители пока не подключились';
            el.participantsList.appendChild(empty);
            return;
        }

        clientIds.forEach(cId => {
            const client = state.hostClients[cId];
            const row = document.createElement('div');
            row.className = 'participant-item';

            const left = document.createElement('div');
            left.className = 'participant-left';

            const name = document.createElement('span');
            name.className = 'participant-name';
            name.textContent = client.nickname;

            const tag = document.createElement('span');
            tag.className = `participant-status-tag ${client.controlAllowed ? 'active' : ''}`;
            tag.textContent = client.controlAllowed ? 'Управляет ПК' : 'Просмотр';

            left.appendChild(name);
            left.appendChild(tag);

            const actions = document.createElement('div');
            actions.className = 'participant-actions';

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = `btn-perm-toggle ${client.controlAllowed ? 'revoking' : ''}`;
            toggleBtn.textContent = client.controlAllowed ? 'Забрать управление' : 'Дать управление';
            toggleBtn.onclick = () => {
                toggleClientControlPermission(cId);
            };

            const kickBtn = document.createElement('button');
            kickBtn.type = 'button';
            kickBtn.className = 'btn-perm-kick';
            kickBtn.textContent = 'Исключить';
            kickBtn.title = 'Отключить зрителя от трансляции';
            kickBtn.onclick = () => {
                kickClient(cId);
            };

            actions.appendChild(toggleBtn);
            actions.appendChild(kickBtn);

            row.appendChild(left);
            row.appendChild(actions);
            el.participantsList.appendChild(row);
        });
    }

    function kickClient(clientId) {
        const client = state.hostClients[clientId];
        if (!client) return;

        const name = client.nickname;
        sendSignaling({
            type: 'kick-client',
            clientId: clientId
        });

        if (client.pc) {
            try { client.pc.close(); } catch (e) {}
        }
        delete state.hostClients[clientId];
        renderParticipantsList();
        showToast(`Участник "${name}" исключен`);
        appendChatMessage(el.hostChatMessages, 'Система', `Ведущий исключил "${name}" из трансляции`);
    }

    function toggleClientControlPermission(clientId) {
        const client = state.hostClients[clientId];
        if (!client) return;

        client.controlAllowed = !client.controlAllowed;

        if (client.dc && client.dc.readyState === 'open') {
            client.dc.send(JSON.stringify({
                type: 'control-permission',
                granted: client.controlAllowed
            }));
        }

        // Синхронизируем права с сервером
        sendSignaling({
            type: 'set-control-permission',
            clientId: clientId,
            granted: client.controlAllowed
        });

        renderParticipantsList();

        if (client.controlAllowed) {
            showToast(`Права управления выданы: ${client.nickname}`);
            appendChatMessage(el.hostChatMessages, 'Система', `Ведущий предоставил права управления участнику "${client.nickname}"`);
            broadcastDataPacket({
                type: 'chat',
                sender: 'Система',
                text: `Ведущий предоставил права управления участнику "${client.nickname}"`,
                timestamp: Date.now()
            });
        } else {
            showToast(`Права управления отозваны: ${client.nickname}`);
        }
    }

    function handleHostReceivedPacket(pkt, senderClientId) {
        const client = state.hostClients[senderClientId];
        if (!client) return;

        if (pkt.type === 'ping') {
            if (client.dc && client.dc.readyState === 'open') {
                client.dc.send(JSON.stringify({ type: 'pong', timestamp: pkt.timestamp }));
            }
        } else if (pkt.type === 'request-control') {
            showToast(`Пользователь "${client.nickname}" просит права управления!`);
            appendChatMessage(el.hostChatMessages, 'Запрос', `"${client.nickname}" просит права на управление мышью и клавиатурой`);
        } else if (pkt.type === 'chat') {
            appendChatMessage(el.hostChatMessages, pkt.sender, pkt.text);
            broadcastDataPacket(pkt);
        } else if (pkt.type === 'file-start' || pkt.type === 'file-chunk' || pkt.type === 'file-end') {
            handleIncomingFilePacket(pkt, el.hostChatMessages);
            broadcastDataPacket(pkt, senderClientId);
        } else if (['mousemove', 'mousedown', 'mouseup', 'wheel', 'keydown', 'keyup', 'combo'].includes(pkt.type)) {
            // ВВОД (МЫШЬ / КЛАВИАТУРА): ПРОВЕРКА ПРАВ
            if (!client.controlAllowed) {
                return;
            }

            // Передача в локальный агент (если он запущен на хосте)
            if (state.agentWs && state.agentWs.readyState === WebSocket.OPEN) {
                state.agentWs.send(JSON.stringify(pkt));
            }
        }
    }

    function broadcastDataPacket(pkt, excludeClientId = null) {
        const str = JSON.stringify(pkt);
        for (const cId in state.hostClients) {
            if (excludeClientId && cId === excludeClientId) continue;
            const dc = state.hostClients[cId].dc;
            if (dc && dc.readyState === 'open') {
                dc.send(str);
            }
        }
    }

    // =========================================================================
    // 3. ЗРИТЕЛЬ: ПОДКЛЮЧЕНИЕ И УПРАВЛЕНИЕ БЕЗ БЛОКИРОВКИ КУРСОРА
    // =========================================================================
    function handleConnectSubmit(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const nick = getValidatedNickname();
        if (!nick) return;

        const rawKey = el.remoteKeyInput.value.trim();
        if (!/^\d{3}-\d{3}-\d{3}$/.test(rawKey)) {
            showToast('Введите 9-значный код (формат 000-000-000)');
            return;
        }

        connectToHost(rawKey, nick);
    }

    if (el.connectForm) {
        el.connectForm.addEventListener('submit', handleConnectSubmit);
    }
    if (el.btnConnectRemote) {
        el.btnConnectRemote.addEventListener('click', handleConnectSubmit);
    }
    if (el.remoteKeyInput) {
        el.remoteKeyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                handleConnectSubmit(e);
            }
        });
    }

    function connectToHost(key, nickname) {
        state.role = 'client';
        state.sessionKey = key;
        state.myNickname = nickname;
        state.hasControlPermission = true;
        updateViewerPermissionBadge(true);

        if (el.btnConnectRemote) {
            el.btnConnectRemote.disabled = true;
            el.btnConnectRemote.textContent = 'Подключение...';
        }

        showToast(`Подключение к ${key}...`);
        sendSignaling({
            type: 'join-session',
            sessionKey: key,
            nickname: nickname
        });
    }

    async function handleRemoteOffer(offerSdp) {
        if (state.clientPc) state.clientPc.close();

        state.clientPc = new RTCPeerConnection(RTC_CONFIG);
        state.clientIceQueue = [];

        state.clientPc.ondatachannel = (event) => {
            state.clientDc = event.channel;
            setupClientDataChannel();
        };

        state.clientPc.ontrack = (event) => {
            if (event.track.kind === 'video') {
                el.remoteVideo.srcObject = event.streams[0];
                el.remoteVideo.play().catch(() => {});
            } else if (event.track.kind === 'audio') {
                el.remoteAudio.srcObject = event.streams[0];
                el.remoteAudio.play().catch(() => {});
            }
            switchToSessionView();
        };

        state.clientPc.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignaling({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        let disconnectTimer = null;
        state.clientPc.onconnectionstatechange = () => {
            const cState = state.clientPc ? state.clientPc.connectionState : 'closed';
            if (cState === 'failed') {
                showToast('Сбой прямого WebRTC соединения с ведущим');
                resetToLobby();
            } else if (cState === 'disconnected') {
                if (!disconnectTimer) {
                    disconnectTimer = setTimeout(() => {
                        if (state.clientPc && state.clientPc.connectionState === 'disconnected') {
                            showToast('Трансляция завершена');
                            resetToLobby();
                        }
                        disconnectTimer = null;
                    }, 5000);
                }
            } else if (cState === 'connected') {
                if (disconnectTimer) {
                    clearTimeout(disconnectTimer);
                    disconnectTimer = null;
                }
                if (el.btnConnectRemote) {
                    el.btnConnectRemote.disabled = false;
                    el.btnConnectRemote.textContent = 'Подключиться к трансляции';
                }
            }
        };

        await state.clientPc.setRemoteDescription(new RTCSessionDescription(offerSdp));

        while (state.clientIceQueue && state.clientIceQueue.length > 0) {
            const cand = state.clientIceQueue.shift();
            state.clientPc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }

        const answer = await state.clientPc.createAnswer();
        await state.clientPc.setLocalDescription(answer);

        sendSignaling({
            type: 'answer',
            sdp: state.clientPc.localDescription
        });
    }

    function setupClientDataChannel() {
        state.clientDc.onopen = () => {
            startPingLoop();
            startStatsMonitoring();
        };

        state.clientDc.onclose = () => {
            stopMonitoring();
        };

        state.clientDc.onmessage = (event) => {
            try {
                const pkt = JSON.parse(event.data);
                if (pkt.type === 'pong') {
                    const rtt = Date.now() - pkt.timestamp;
                    el.hudRtt.textContent = `${rtt} ms`;
                } else if (pkt.type === 'control-permission') {
                    state.hasControlPermission = !!pkt.granted;
                    updateViewerPermissionBadge(state.hasControlPermission);
                    if (state.hasControlPermission) {
                        showToast('Ведущий разрешил управление мышью и клавиатурой');
                    } else {
                        showToast('Управление отозвано ведущим');
                    }
                } else if (pkt.type === 'chat') {
                    appendChatMessage(el.viewerChatMessages, pkt.sender, pkt.text);
                    if (el.sessionChatPanel.classList.contains('hidden')) {
                        state.unreadChatCount++;
                        if (el.chatUnreadBadge) {
                            el.chatUnreadBadge.textContent = state.unreadChatCount;
                            el.chatUnreadBadge.classList.remove('hidden');
                        }
                    }
                } else if (pkt.type === 'file-start' || pkt.type === 'file-chunk' || pkt.type === 'file-end') {
                    handleIncomingFilePacket(pkt, el.viewerChatMessages);
                }
            } catch (e) {}
        };
    }

    function updateViewerPermissionBadge(granted) {
        if (!el.hudControlStatus || !el.permStatusText) return;
        if (granted) {
            el.hudControlStatus.className = 'perm-badge control-granted';
            el.permStatusText.textContent = 'Управление активно';
            if (el.btnRequestControl) {
                el.btnRequestControl.classList.add('active');
                if (el.controlTooltip) el.controlTooltip.textContent = 'Управление активно (клик для паузы)';
            }
            if (el.viewportStage) el.viewportStage.classList.add('control-active');
        } else {
            el.hudControlStatus.className = 'perm-badge view-only';
            el.permStatusText.textContent = 'Только просмотр';
            if (el.btnRequestControl) {
                el.btnRequestControl.classList.remove('active');
                if (el.controlTooltip) el.controlTooltip.textContent = 'Включить управление ПК';
            }
            if (el.viewportStage) el.viewportStage.classList.remove('control-active');
        }
    }

    if (el.btnRequestControl) {
        el.btnRequestControl.addEventListener('click', (e) => {
            if (e) e.stopPropagation();
            state.hasControlPermission = !state.hasControlPermission;
            updateViewerPermissionBadge(state.hasControlPermission);
            sendSignaling({
                type: 'set-control-permission',
                clientId: state.myClientId,
                granted: state.hasControlPermission
            });
            if (state.hasControlPermission) {
                showToast('Управление ПК включено');
            } else {
                showToast('Управление ПК приостановлено (режим просмотра)');
            }
        });
    }

    function sendClientDataChannelPacket(packet) {
        if (state.clientDc && state.clientDc.readyState === 'open') {
            state.clientDc.send(JSON.stringify(packet));
        }
    }

    // =========================================================================
    // 4. КОННЕКТОРЫ: ЧАТ И P2P ПЕРЕДАЧА ФАЙЛОВ
    // =========================================================================
    el.hostChatForm.addEventListener('submit', (e) => {
        if (e) e.preventDefault();
        const text = el.hostChatInput.value.trim();
        if (!text) return;
        el.hostChatInput.value = '';

        const senderName = state.myNickname ? `${state.myNickname} (Ведущий)` : 'Ведущий';
        const pkt = { type: 'chat', sender: senderName, text, timestamp: Date.now() };
        appendChatMessage(el.hostChatMessages, 'Вы', text);
        broadcastDataPacket(pkt);
    });

    el.viewerChatForm.addEventListener('submit', (e) => {
        if (e) e.preventDefault();
        const text = el.viewerChatInput.value.trim();
        if (!text) return;
        el.viewerChatInput.value = '';

        const senderName = state.myNickname || 'Зритель';
        const pkt = { type: 'chat', sender: senderName, text, timestamp: Date.now() };
        appendChatMessage(el.viewerChatMessages, 'Вы', text);
        sendClientDataChannelPacket(pkt);
    });

    function appendChatMessage(container, sender, text) {
        const row = document.createElement('div');
        row.className = 'chat-msg';

        const senderEl = document.createElement('span');
        senderEl.className = 'chat-msg-sender';
        senderEl.textContent = sender;

        const textEl = document.createElement('span');
        textEl.className = 'chat-msg-text';
        textEl.textContent = text;

        row.appendChild(senderEl);
        row.appendChild(textEl);
        container.appendChild(row);
        container.scrollTop = container.scrollHeight;
    }

    el.btnHostOpenFile.addEventListener('click', () => el.hostFileInput.click());
    el.hostFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) sendFileOverP2P(file, el.hostChatMessages, true);
    });

    el.btnViewerOpenFile.addEventListener('click', () => el.viewerFileInput.click());
    el.viewerFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) sendFileOverP2P(file, el.viewerChatMessages, false);
    });

    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB max file transfer
    const MAX_FILE_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE) + 1;

    async function sendFileOverP2P(file, chatContainer, isHost) {
        if (!file) return;
        if (file.size > MAX_FILE_SIZE) {
            showToast('Размер файла превышает лимит (100 МБ)');
            return;
        }

        const safeFileName = file.name.replace(/[^\w\s\u0400-\u04FF\.\-_()]/g, '_').substring(0, 80);
        const fileId = `f_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const senderName = state.myNickname || (isHost ? 'Ведущий' : 'Зритель');

        showToast(`Отправка: ${safeFileName}`);
        appendFileDownloadCard(chatContainer, 'Вы', safeFileName, file.size, null);

        const startPkt = {
            type: 'file-start',
            fileId,
            name: safeFileName,
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
            sender: senderName,
            totalChunks
        };

        if (isHost) broadcastDataPacket(startPkt);
        else sendClientDataChannelPacket(startPkt);

        const reader = new FileReader();
        let offset = 0;
        let chunkIndex = 0;

        reader.onload = (e) => {
            const base64Data = btoa(
                new Uint8Array(e.target.result).reduce((data, byte) => data + String.fromCharCode(byte), '')
            );

            const chunkPkt = {
                type: 'file-chunk',
                fileId,
                chunkIndex,
                data: base64Data
            };

            if (isHost) broadcastDataPacket(chunkPkt);
            else sendClientDataChannelPacket(chunkPkt);

            chunkIndex++;
            offset += CHUNK_SIZE;

            if (offset < file.size) {
                readNextSlice();
            } else {
                const endPkt = { type: 'file-end', fileId };
                if (isHost) broadcastDataPacket(endPkt);
                else sendClientDataChannelPacket(endPkt);
                showToast(`Файл ${safeFileName} отправлен`);
            }
        };

        function readNextSlice() {
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        }

        readNextSlice();
    }

    function handleIncomingFilePacket(pkt, chatContainer) {
        if (pkt.type === 'file-start') {
            if (!pkt.fileId || typeof pkt.fileId !== 'string') return;
            if (!pkt.size || pkt.size > MAX_FILE_SIZE || pkt.size <= 0) return;
            if (!pkt.totalChunks || pkt.totalChunks > MAX_FILE_CHUNKS || pkt.totalChunks <= 0) return;
            if (Object.keys(state.incomingFiles).length >= 3) return;

            const safeName = String(pkt.name || 'file').replace(/[^\w\s\u0400-\u04FF\.\-_()]/g, '_').substring(0, 80);
            const safeSender = String(pkt.sender || 'Пользователь').replace(/[^\w\s\u0400-\u04FF\.\-_]/g, '').substring(0, 24);

            state.incomingFiles[pkt.fileId] = {
                name: safeName,
                size: Number(pkt.size),
                mimeType: String(pkt.mimeType || 'application/octet-stream').substring(0, 64),
                sender: safeSender,
                totalChunks: Number(pkt.totalChunks),
                chunks: new Array(Number(pkt.totalChunks)),
                receivedChunks: 0
            };
        } else if (pkt.type === 'file-chunk') {
            const f = state.incomingFiles[pkt.fileId];
            if (!f) return;
            if (pkt.chunkIndex < 0 || pkt.chunkIndex >= f.totalChunks) return;
            if (typeof pkt.data !== 'string' || pkt.data.length > CHUNK_SIZE * 2) return;

            try {
                const binary = atob(pkt.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                f.chunks[pkt.chunkIndex] = bytes;
                f.receivedChunks++;
            } catch (err) {}
        } else if (pkt.type === 'file-end') {
            const f = state.incomingFiles[pkt.fileId];
            if (!f) return;
            if (f.receivedChunks < f.totalChunks) return;

            const blob = new Blob(f.chunks, { type: f.mimeType || 'application/octet-stream' });
            const downloadUrl = URL.createObjectURL(blob);
            appendFileDownloadCard(chatContainer, f.sender, f.name, f.size, downloadUrl);
            showToast(`Получен файл: ${f.name}`);
            delete state.incomingFiles[pkt.fileId];
        }
    }

    function appendFileDownloadCard(container, sender, name, size, downloadUrl) {
        const row = document.createElement('div');
        row.className = 'chat-msg';

        const senderEl = document.createElement('span');
        senderEl.className = 'chat-msg-sender';
        senderEl.textContent = `${sender} отправил файл:`;

        const card = document.createElement('div');
        card.className = 'file-card-box';

        const info = document.createElement('div');
        info.className = 'file-info';

        const nameEl = document.createElement('span');
        nameEl.className = 'file-name';
        nameEl.textContent = name;

        const sizeEl = document.createElement('span');
        sizeEl.className = 'file-size';
        sizeEl.textContent = formatBytes(size);

        info.appendChild(nameEl);
        info.appendChild(sizeEl);
        card.appendChild(info);

        if (downloadUrl) {
            const dlBtn = document.createElement('a');
            dlBtn.className = 'btn-file-dl';
            dlBtn.href = downloadUrl;
            dlBtn.download = name;
            dlBtn.textContent = 'Скачать';
            card.appendChild(dlBtn);
        } else {
            const statusBadge = document.createElement('span');
            statusBadge.className = 'file-size';
            statusBadge.textContent = 'Отправлено';
            card.appendChild(statusBadge);
        }

        row.appendChild(senderEl);
        row.appendChild(card);
        container.appendChild(row);
        container.scrollTop = container.scrollHeight;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
    }

    el.btnToggleChat.addEventListener('click', () => {
        el.sessionChatPanel.classList.toggle('hidden');
        if (!el.sessionChatPanel.classList.contains('hidden')) {
            state.unreadChatCount = 0;
            if (el.chatUnreadBadge) {
                el.chatUnreadBadge.textContent = '0';
                el.chatUnreadBadge.classList.add('hidden');
            }
        }
    });

    el.btnCloseChat.addEventListener('click', () => {
        el.sessionChatPanel.classList.add('hidden');
    });

    // =========================================================================
    // 5. ЕСТЕСТВЕННЫЙ ВВОД МЫШИ И КЛАВИАТУРЫ (БЕЗ POINTER LOCK)
    // =========================================================================
    const btnMap = ['left', 'middle', 'right'];

    function sendClientInput(pkt) {
        if (!state.hasControlPermission) return;
        // 1. Отправка через WebRTC DataChannel (P2P ведущему)
        sendClientDataChannelPacket(pkt);
        // 2. Отправка через WebSocket сигнализации напрямую в OSInputExecutor на сервере
        sendSignaling({
            type: 'agent-input',
            packet: pkt
        });
    }

    function getNormalizedCoordinates(e, videoEl) {
        const rect = videoEl.getBoundingClientRect();
        const videoWidth = videoEl.videoWidth || rect.width;
        const videoHeight = videoEl.videoHeight || rect.height;
        const videoRatio = videoWidth / videoHeight;
        const elemRatio = rect.width / rect.height;

        let renderW, renderH, offsetX, offsetY;
        if (elemRatio > videoRatio) {
            renderH = rect.height;
            renderW = renderH * videoRatio;
            offsetX = (rect.width - renderW) / 2;
            offsetY = 0;
        } else {
            renderW = rect.width;
            renderH = renderW / videoRatio;
            offsetX = 0;
            offsetY = (rect.height - renderH) / 2;
        }

        const clientX = e.clientX - rect.left - offsetX;
        const clientY = e.clientY - rect.top - offsetY;

        if (!renderW || !renderH) return { x: 0.5, y: 0.5 };
        const normX = Math.max(0, Math.min(1, clientX / renderW));
        const normY = Math.max(0, Math.min(1, clientY / renderH));
        return {
            x: Number.isFinite(normX) ? normX : 0.5,
            y: Number.isFinite(normY) ? normY : 0.5
        };
    }

    // Движение мыши (без блокировки)
    el.viewportStage.addEventListener('mousemove', (e) => {
        if (e.target.closest('.discord-dock') || e.target.closest('.chat-drawer') || e.target.closest('.stream-pause-overlay')) return;
        if (!state.hasControlPermission || state.mouseThrottled) return;

        state.mouseThrottled = true;
        requestAnimationFrame(() => {
            state.mouseThrottled = false;
        });

        const coords = getNormalizedCoordinates(e, el.remoteVideo);
        sendClientInput({
            type: 'mousemove',
            x: coords.x,
            y: coords.y
        });
    });

    // Нажатие кнопки мыши
    el.viewportStage.addEventListener('mousedown', (e) => {
        if (e.target.closest('.discord-dock') || e.target.closest('.chat-drawer') || e.target.closest('.stream-pause-overlay') || e.target.closest('button')) {
            return;
        }

        if (!state.hasControlPermission) {
            showToast('У вас режим просмотра. Нажмите кнопку управления в нижнем меню.');
            return;
        }

        // Фокусируем рабочее окно для мгновенного ввода с клавиатуры
        el.viewportStage.focus();

        const coords = getNormalizedCoordinates(e, el.remoteVideo);
        const btn = btnMap[e.button] || 'left';
        showClickRipple(e.clientX, e.clientY);

        sendClientInput({
            type: 'mousedown',
            button: btn,
            x: coords.x,
            y: coords.y
        });
    });

    // Отпускание кнопки мыши
    el.viewportStage.addEventListener('mouseup', (e) => {
        if (e.target.closest('.discord-dock') || e.target.closest('.chat-drawer') || e.target.closest('.stream-pause-overlay') || e.target.closest('button')) {
            return;
        }
        if (!state.hasControlPermission) return;
        const coords = getNormalizedCoordinates(e, el.remoteVideo);
        const btn = btnMap[e.button] || 'left';
        sendClientInput({
            type: 'mouseup',
            button: btn,
            x: coords.x,
            y: coords.y
        });
    });

    // Правый клик мыши: перехват контекстного меню
    el.viewportStage.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.discord-dock') || e.target.closest('.chat-drawer')) {
            return;
        }
        e.preventDefault();
    });

    // Колесо мыши
    el.viewportStage.addEventListener('wheel', (e) => {
        if (e.target.closest('.discord-dock') || e.target.closest('.chat-drawer') || e.target.closest('.stream-pause-overlay')) return;
        if (!state.hasControlPermission) return;
        e.preventDefault();
        const coords = getNormalizedCoordinates(e, el.remoteVideo);
        const dx = Number.isFinite(e.deltaX) ? e.deltaX : 0;
        const dy = Number.isFinite(e.deltaY) ? e.deltaY : 0;
        sendClientInput({
            type: 'wheel',
            deltaX: dx,
            deltaY: dy,
            x: coords.x,
            y: coords.y
        });
    }, { passive: false });

    // Клавиатура: отправка нажатий клавиш
    window.addEventListener('keydown', (e) => {
        if (state.role !== 'client' || el.sessionView.classList.contains('view-hidden')) return;
        if (!state.hasControlPermission) return;

        // Не перехватываем, если зритель печатает в строке чата
        if (document.activeElement === el.viewerChatInput || document.activeElement === el.hostChatInput) return;

        // Блокируем системные шорткаты браузера (Tab, Backspace, стрелки), чтобы они передавались в удаленный ПК
        const interceptKeys = ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'F1', 'F3', 'F5', 'F6', 'F7', 'F12'];
        if (interceptKeys.includes(e.key) || (e.altKey && e.key === 'Tab')) {
            e.preventDefault();
        }

        sendClientInput({
            type: 'keydown',
            key: e.key,
            code: e.code
        });
    });

    window.addEventListener('keyup', (e) => {
        if (state.role !== 'client' || el.sessionView.classList.contains('view-hidden')) return;
        if (!state.hasControlPermission) return;
        if (document.activeElement === el.viewerChatInput || document.activeElement === el.hostChatInput) return;

        sendClientInput({
            type: 'keyup',
            key: e.key,
            code: e.code
        });
    });

    el.btnFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            el.sessionView.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    });

    el.btnSendCad.addEventListener('click', () => {
        if (!state.hasControlPermission) {
            showToast('У вас нет прав управления');
            return;
        }
        sendClientInput({
            type: 'combo',
            keys: ['ctrl', 'alt', 'del']
        });
        showToast('Отправлена комбинация Ctrl+Alt+Del');
    });

    // =========================================================================
    // 6. ТЕЛЕМЕТРИЯ И УПРАВЛЕНИЕ СЕССИЕЙ
    // =========================================================================
    function startPingLoop() {
        state.pingInterval = setInterval(() => {
            sendClientDataChannelPacket({
                type: 'ping',
                timestamp: Date.now()
            });
        }, 1000);
    }

    function startStatsMonitoring() {
        state.statsInterval = setInterval(async () => {
            if (!state.clientPc) return;
            const stats = await state.clientPc.getStats();
            let currentFps = 0;
            let currentWidth = 0;
            let currentHeight = 0;

            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    currentFps = report.framesPerSecond || 0;
                    currentWidth = report.frameWidth || el.remoteVideo.videoWidth;
                    currentHeight = report.frameHeight || el.remoteVideo.videoHeight;
                }
            });

            el.hudFps.textContent = Math.round(currentFps);
            if (currentWidth && currentHeight) {
                el.hudRes.textContent = `${currentWidth}×${currentHeight}`;
            }
        }, 1000);
    }

    function stopMonitoring() {
        clearInterval(state.pingInterval);
        clearInterval(state.statsInterval);
    }

    function switchToSessionView() {
        el.hudTargetKey.textContent = state.sessionKey;
        el.lobbyView.classList.replace('view-active', 'view-hidden');
        el.sessionView.classList.replace('view-hidden', 'view-active');
        el.viewportStage.focus();
    }

    function resetToLobby() {
        stopMonitoring();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

        if (state.clientPc) {
            try { state.clientPc.close(); } catch (e) {}
            state.clientPc = null;
        }

        state.role = null;
        state.sessionKey = null;
        state.hasControlPermission = false;
        updateViewerPermissionBadge(false);

        if (el.viewerPauseOverlay) {
            el.viewerPauseOverlay.classList.add('hidden');
        }

        state.unreadChatCount = 0;
        if (el.chatUnreadBadge) {
            el.chatUnreadBadge.textContent = '0';
            el.chatUnreadBadge.classList.add('hidden');
        }

        if (el.btnConnectRemote) {
            el.btnConnectRemote.disabled = false;
            el.btnConnectRemote.textContent = 'Подключиться к трансляции';
        }

        el.remoteVideo.srcObject = null;
        el.remoteAudio.srcObject = null;
        el.sessionView.classList.replace('view-active', 'view-hidden');
        el.lobbyView.classList.replace('view-hidden', 'view-active');
    }

    el.btnDisconnect.addEventListener('click', (e) => {
        if (e) e.stopPropagation();
        sendSignaling({ type: 'disconnect-session' });
        resetToLobby();
        showToast('Вы вышли из трансляции');
    });

    // --- Авто-подключение по прямой ссылке (?join=123-456-789) ---
    function checkUrlParameters() {
        const params = new URLSearchParams(location.search);
        const joinKey = params.get('join');
        if (joinKey) {
            setTab('connect');
            el.remoteKeyInput.value = formatKey(joinKey);
        }
    }

    initSignaling();
})();
