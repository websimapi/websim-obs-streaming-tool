document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const connectionStatus = document.getElementById('connection-status');
    const serverAddressInput = document.getElementById('server-address');
    const connectBtn = document.getElementById('connect-btn');
    const setupContainer = document.getElementById('setup-container');
    const streamingPanel = document.getElementById('streaming-panel');
    const streamKeyInput = document.getElementById('stream-key');
    const showKeyBtn = document.getElementById('show-key');
    const streamingPlatform = document.getElementById('streaming-platform');
    const customRtmpSection = document.getElementById('custom-rtmp');
    const rtmpUrlInput = document.getElementById('rtmp-url');
    const videoBitrateSlider = document.getElementById('video-bitrate');
    const videoBitrateValue = document.getElementById('video-bitrate-value');
    const audioBitrateSlider = document.getElementById('audio-bitrate');
    const audioBitrateValue = document.getElementById('audio-bitrate-value');
    const windowSelection = document.getElementById('window-selection');
    const streamPreview = document.getElementById('stream-preview');
    const streamStatus = document.getElementById('stream-status');
    const streamFps = document.getElementById('stream-fps');
    const currentBitrate = document.getElementById('current-bitrate');
    const streamDuration = document.getElementById('stream-duration');
    const startStreamBtn = document.getElementById('start-stream');
    const stopStreamBtn = document.getElementById('stop-stream');
    const notificationsContainer = document.getElementById('notifications');

    // State
    let socket = null;
    let selectedWindow = null;
    let isStreaming = false;
    let streamStartTime = null;
    let durationInterval = null;
    let previewVideo = null;

    // Initialize UI elements
    updateBitrateDisplay();
    
    // Event listeners
    connectBtn.addEventListener('click', connectToServer);
    showKeyBtn.addEventListener('click', toggleStreamKeyVisibility);
    streamingPlatform.addEventListener('change', handlePlatformChange);
    videoBitrateSlider.addEventListener('input', updateBitrateDisplay);
    audioBitrateSlider.addEventListener('input', updateBitrateDisplay);
    startStreamBtn.addEventListener('click', startStreaming);
    stopStreamBtn.addEventListener('click', stopStreaming);

    // Functions
    function connectToServer() {
        const serverAddress = serverAddressInput.value.trim();
        if (!serverAddress) {
            showNotification('Please enter a server address', 'error');
            return;
        }

        connectionStatus.textContent = 'Connecting...';
        connectionStatus.className = 'connecting';

        try {
            // If we already have a socket, close it
            if (socket) {
                socket.disconnect();
            }

            // Create socket.io connection with proper URL formatting
            let socketUrl = serverAddress;
            
            // Make sure the URL has a protocol
            if (!socketUrl.startsWith('http://') && !socketUrl.startsWith('https://')) {
                socketUrl = `http://${socketUrl}`;
            }
            
            console.log(`Connecting to: ${socketUrl}`);
            socket = io(socketUrl, {
                reconnectionAttempts: 5,
                timeout: 10000,
                transports: ['websocket', 'polling'] // Try both transport methods
            });

            // Setup socket event handlers
            socket.on('connect', handleSocketConnect);
            socket.on('disconnect', handleSocketDisconnect);
            socket.on('connect_error', (error) => {
                console.error("Connection error:", error);
                handleSocketError(error);
            });
            socket.on('error', handleSocketError);
            socket.on('windows-list', handleWindowsList);
            socket.on('window-preview', handleWindowPreview);
            socket.on('stream-status', handleStreamStatus);
            socket.on('stream-stats', handleStreamStats);
        } catch (error) {
            console.error("Connection error:", error);
            connectionStatus.textContent = 'Disconnected';
            connectionStatus.className = 'disconnected';
            showNotification(`Connection error: ${error.message}`, 'error');
        }
    }

    function handleSocketConnect() {
        connectionStatus.textContent = 'Connected';
        connectionStatus.className = 'connected';
        showNotification('Connected to server successfully', 'success');
        
        // Switch to streaming panel
        setupContainer.classList.add('hidden');
        streamingPanel.classList.remove('hidden');
        
        // Request window list
        socket.emit('get-windows');
    }

    function handleSocketDisconnect() {
        connectionStatus.textContent = 'Disconnected';
        connectionStatus.className = 'disconnected';
        showNotification('Disconnected from server', 'error');
        
        // Switch back to setup
        streamingPanel.classList.add('hidden');
        setupContainer.classList.remove('hidden');
        
        // Reset streaming state
        if (isStreaming) {
            stopStreaming();
        }
    }

    function handleSocketError(error) {
        showNotification(`Connection error: ${error.message || 'Unknown error'}`, 'error');
        console.error("Socket error:", error);
        connectionStatus.textContent = 'Disconnected';
        connectionStatus.className = 'disconnected';
    }

    function handleWindowsList(windows) {
        windowSelection.innerHTML = '';
        
        if (windows.length === 0) {
            windowSelection.innerHTML = '<p>No windows available for capture.</p>';
            return;
        }
        
        windows.forEach(window => {
            const windowElement = document.createElement('div');
            windowElement.className = 'window-item';
            windowElement.dataset.windowId = window.id;
            
            // Create thumbnail if available
            if (window.thumbnail) {
                const img = document.createElement('img');
                img.src = `data:image/jpeg;base64,${window.thumbnail}`;
                img.alt = window.title;
                windowElement.appendChild(img);
            }
            
            const title = document.createElement('div');
            title.textContent = window.title || `Window ${window.id}`;
            windowElement.appendChild(title);
            
            windowElement.addEventListener('click', () => selectWindow(window.id));
            windowSelection.appendChild(windowElement);
        });
    }

    function selectWindow(windowId) {
        console.log(`Selecting window: ${windowId}`);
        
        // Clear previous selection
        const previousSelected = windowSelection.querySelector('.selected');
        if (previousSelected) {
            previousSelected.classList.remove('selected');
        }
        
        // Highlight new selection
        const windowElement = windowSelection.querySelector(`[data-window-id="${windowId}"]`);
        if (windowElement) {
            windowElement.classList.add('selected');
        }
        
        selectedWindow = windowId;
        
        // Request preview of selected window
        socket.emit('get-window-preview', { windowId });
        
        // Enable start streaming button if a window is selected and not currently streaming
        if (!isStreaming) {
            startStreamBtn.classList.remove('disabled');
        }
        
        showNotification(`Window selected: ${windowElement?.querySelector('div').textContent || windowId}`, 'info');
    }

    function handleWindowPreview(data) {
        // Create or get the preview video element
        if (!previewVideo) {
            // Remove placeholder if it exists
            const placeholder = streamPreview.querySelector('.placeholder');
            if (placeholder) {
                placeholder.remove();
            }
            
            // Create image element for preview
            previewVideo = document.createElement('img');
            previewVideo.style.width = '100%';
            previewVideo.style.height = '100%';
            previewVideo.style.objectFit = 'contain';
            streamPreview.appendChild(previewVideo);
        }
        
        // Update the preview with the received frame
        if (data.frame) {
            try {
                // Use a data URL for the image
                previewVideo.src = `data:image/jpeg;base64,${data.frame}`;
                
                previewVideo.onerror = function(e) {
                    console.error("Error loading preview image:", e);
                    showNotification("Error loading preview image", "error");
                };
            } catch (error) {
                console.error("Error processing preview frame:", error);
                showNotification("Error processing preview frame", "error");
            }
        }
    }

    function handleStreamStatus(data) {
        streamStatus.textContent = data.status;
        
        if (data.status === 'Streaming') {
            startStreamBtn.classList.add('disabled');
            stopStreamBtn.classList.remove('disabled');
            
            if (!isStreaming) {
                isStreaming = true;
                streamStartTime = new Date();
                startDurationCounter();
            }
        } else if (data.status === 'Idle' || data.status === 'Error') {
            startStreamBtn.classList.remove('disabled');
            stopStreamBtn.classList.add('disabled');
            
            if (isStreaming) {
                isStreaming = false;
                stopDurationCounter();
            }
            
            if (data.status === 'Error' && data.message) {
                showNotification(`Streaming error: ${data.message}`, 'error');
            }
        }
    }

    function handleStreamStats(stats) {
        streamFps.textContent = stats.fps ? stats.fps.toFixed(1) : '0';
        currentBitrate.textContent = stats.bitrate ? `${stats.bitrate.toFixed(0)} kbps` : '0 kbps';
    }

    function startStreaming() {
        if (isStreaming) {
            return;
        }
        
        if (!selectedWindow) {
            showNotification('Please select a window to stream', 'error');
            return;
        }
        
        const streamKey = streamKeyInput.value.trim();
        if (!streamKey) {
            showNotification('Please enter a stream key', 'error');
            return;
        }
        
        const platform = streamingPlatform.value;
        let rtmpUrl = '';
        
        if (platform === 'custom') {
            rtmpUrl = rtmpUrlInput.value.trim();
            if (!rtmpUrl) {
                showNotification('Please enter an RTMP URL', 'error');
                return;
            }
        }
        
        // Prepare streaming configuration
        const config = {
            windowId: selectedWindow,
            streamKey: streamKey,
            platform: platform,
            rtmpUrl: rtmpUrl,
            videoBitrate: parseInt(videoBitrateSlider.value),
            audioBitrate: parseInt(audioBitrateSlider.value)
        };
        
        console.log('Starting stream with config:', config);
        
        // Send start streaming command to server
        socket.emit('start-stream', config);
        showNotification('Starting stream...', 'info');
    }

    function stopStreaming() {
        if (!isStreaming) return;
        
        socket.emit('stop-stream');
        showNotification('Stopping stream...', 'info');
    }

    function startDurationCounter() {
        stopDurationCounter(); // Clear any existing interval
        
        durationInterval = setInterval(() => {
            if (!streamStartTime) return;
            
            const elapsed = new Date() - streamStartTime;
            const hours = Math.floor(elapsed / 3600000).toString().padStart(2, '0');
            const minutes = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2, '0');
            const seconds = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
            
            streamDuration.textContent = `${hours}:${minutes}:${seconds}`;
        }, 1000);
    }

    function stopDurationCounter() {
        if (durationInterval) {
            clearInterval(durationInterval);
            durationInterval = null;
        }
        streamDuration.textContent = '00:00:00';
    }

    function toggleStreamKeyVisibility() {
        if (streamKeyInput.type === 'password') {
            streamKeyInput.type = 'text';
            showKeyBtn.textContent = 'Hide';
        } else {
            streamKeyInput.type = 'password';
            showKeyBtn.textContent = 'Show';
        }
    }

    function handlePlatformChange() {
        if (streamingPlatform.value === 'custom') {
            customRtmpSection.classList.remove('hidden');
        } else {
            customRtmpSection.classList.add('hidden');
        }
    }

    function updateBitrateDisplay() {
        videoBitrateValue.textContent = videoBitrateSlider.value;
        audioBitrateValue.textContent = audioBitrateSlider.value;
    }

    function showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        
        notificationsContainer.appendChild(notification);
        
        // Automatically remove after 5 seconds
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            
            // Remove from DOM after transition
            setTimeout(() => {
                notification.remove();
            }, 300);
        }, 5000);
    }
});