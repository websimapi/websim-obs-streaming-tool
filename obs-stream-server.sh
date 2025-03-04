#!/bin/bash

# OBS Streaming Tool Server
# For MX Linux

# ---- Configuration ----
PORT=8080
LOG_FILE="/tmp/obs-stream-server.log"
TEMP_DIR="/tmp/obs-stream"
NODE_VERSION="v18.16.0"

# ---- Helper Functions ----
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

check_dependency() {
    if ! command -v "$1" &> /dev/null; then
        log "Required dependency not found: $1"
        return 1
    fi
    return 0
}

install_nodejs() {
    log "Installing Node.js $NODE_VERSION..."
    
    # Create temporary directory
    mkdir -p /tmp/nodejs-install
    cd /tmp/nodejs-install || exit 1
    
    # Download and extract Node.js
    wget "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
    tar -xf "node-$NODE_VERSION-linux-x64.tar.xz"
    
    # Move to /usr/local (requires sudo)
    sudo mkdir -p /usr/local/lib/nodejs
    sudo mv "node-$NODE_VERSION-linux-x64" "/usr/local/lib/nodejs/node-$NODE_VERSION"
    
    # Create symlinks
    sudo ln -sf "/usr/local/lib/nodejs/node-$NODE_VERSION/bin/node" /usr/local/bin/node
    sudo ln -sf "/usr/local/lib/nodejs/node-$NODE_VERSION/bin/npm" /usr/local/bin/npm
    sudo ln -sf "/usr/local/lib/nodejs/node-$NODE_VERSION/bin/npx" /usr/local/bin/npx
    
    # Clean up
    cd - || exit 1
    rm -rf /tmp/nodejs-install
    
    # Verify installation
    if ! command -v node &> /dev/null; then
        log "Failed to install Node.js"
        return 1
    fi
    
    log "Node.js $NODE_VERSION installed successfully"
    return 0
}

install_ffmpeg() {
    log "Installing FFmpeg..."
    
    sudo apt-get update
    sudo apt-get install -y ffmpeg
    
    if ! command -v ffmpeg &> /dev/null; then
        log "Failed to install FFmpeg"
        return 1
    fi
    
    log "FFmpeg installed successfully"
    return 0
}

install_dependencies() {
    log "Installing required npm packages..."
    
    # Create package.json
    cat > package.json << EOF
{
  "name": "obs-stream-server",
  "version": "1.0.0",
  "description": "OBS Streaming Tool Server",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.5.1",
    "ws": "^8.13.0"
  }
}
EOF
    
    # Install packages
    npm install
    
    # Install xdotool if not present
    if ! command -v xdotool &> /dev/null; then
        log "Installing xdotool for window management"
        sudo apt-get install -y xdotool
    fi
    
    log "NPM dependencies installed"
}

create_server_script() {
    log "Creating server script..."
    
    cat > server.js << 'EOF'
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Configuration
const PORT = process.env.PORT || 8080;
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/obs-stream';

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Streaming state
let streamProcess = null;
let previewProcess = null;
let selectedWindow = null;
let streamConfig = null;
let isStreaming = false;

// Helper function to get default RTMP URL based on platform
function getRtmpUrl(platform, streamKey) {
    switch (platform) {
        case 'twitch':
            return `rtmp://live.twitch.tv/app/${streamKey}`;
        case 'youtube':
            return `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;
        case 'facebook':
            return `rtmp://live-api-s.facebook.com:80/rtmp/${streamKey}`;
        default:
            return null;
    }
}

// Get list of windows using xwininfo
function getWindowsList() {
    return new Promise((resolve, reject) => {
        exec('xwininfo -root -tree', (error, stdout, stderr) => {
            if (error) {
                console.error(`Error getting windows: ${error.message}`);
                reject(error);
                return;
            }
            
            if (stderr) {
                console.error(`xwininfo stderr: ${stderr}`);
            }
            
            const windows = [];
            const lines = stdout.split('\n');
            
            for (const line of lines) {
                // Look for window lines with a hex ID and a name
                const match = line.match(/^\s*0x([0-9a-f]+) "([^"]+)".*/);
                if (match) {
                    const id = match[1];
                    const title = match[2];
                    
                    // Filter out some common system windows
                    if (title !== 'Desktop' && 
                        !title.includes('panel') && 
                        !title.includes('Menu') &&
                        !title.startsWith('obs-stream-server')) {
                        
                        // Generate a thumbnail for the window
                        windows.push({
                            id,
                            title
                        });
                    }
                }
            }
            
            // Generate thumbnails for windows
            const promises = windows.map(window => 
                generateWindowThumbnail(window.id)
                    .then(thumbnail => {
                        window.thumbnail = thumbnail;
                        return window;
                    })
                    .catch(() => window) // Continue without thumbnail if fails
            );
            
            Promise.all(promises)
                .then(windowsWithThumbnails => resolve(windowsWithThumbnails))
                .catch(err => reject(err));
        });
    });
}

// Generate a thumbnail for a window
function generateWindowThumbnail(windowId) {
    return new Promise((resolve, reject) => {
        const outputFile = path.join(TEMP_DIR, `window_${windowId}.jpg`);
        
        exec(`import -window 0x${windowId} -resize 160x120 ${outputFile}`, (error) => {
            if (error) {
                console.error(`Error generating thumbnail: ${error.message}`);
                reject(error);
                return;
            }
            
            fs.readFile(outputFile, (err, data) => {
                if (err) {
                    console.error(`Error reading thumbnail: ${err.message}`);
                    reject(err);
                    return;
                }
                
                resolve(data.toString('base64'));
                
                // Clean up the file
                fs.unlink(outputFile, () => {});
            });
        });
    });
}

// Start window preview
function startWindowPreview(windowId) {
    if (previewProcess) {
        previewProcess.kill();
        previewProcess = null;
    }
    
    // Get window position and size without focusing
    exec(`xwininfo -id 0x${windowId}`, (error, stdout) => {
        if (error) {
            console.error(`Error getting window info: ${error.message}`);
            return;
        }
        
        // Parse window position and size
        const absXMatch = stdout.match(/Absolute upper-left X:\s+(\d+)/);
        const absYMatch = stdout.match(/Absolute upper-left Y:\s+(\d+)/);
        const widthMatch = stdout.match(/Width:\s+(\d+)/);
        const heightMatch = stdout.match(/Height:\s+(\d+)/);
        
        if (absXMatch && absYMatch && widthMatch && heightMatch) {
            const x = parseInt(absXMatch[1]);
            const y = parseInt(absYMatch[1]);
            const width = parseInt(widthMatch[1]);
            const height = parseInt(heightMatch[1]);
            
            // Use ffmpeg to capture the specific window and output frames
            const args = [
                '-f', 'x11grab',
                '-video_size', `${width}x${height}`,
                '-framerate', '10',
                '-frames:v', '1',
                '-i', `:0.0+${x},${y}`,
                '-q:v', '5',
                '-update', '1',
                '-y',
                path.join(TEMP_DIR, 'preview.jpg')
            ];
            
            previewProcess = spawn('ffmpeg', args);
            
            previewProcess.stderr.on('data', (data) => {
                console.log(`Preview stderr: ${data}`);
            });
            
            previewProcess.on('close', (code) => {
                console.log(`Preview process exited with code ${code}`);
            });
            
            // Start sending preview frames to client
            startSendingPreviewFrames();
        }
    });
}

// Send preview frames to the client
function startSendingPreviewFrames() {
    const previewFile = path.join(TEMP_DIR, 'preview.jpg');
    const interval = setInterval(() => {
        if (io.sockets.sockets.size === 0) {
            clearInterval(interval);
            return;
        }
        
        fs.readFile(previewFile, (err, data) => {
            if (err) {
                console.error(`Error reading preview: ${err.message}`);
                return;
            }
            
            io.emit('window-preview', { frame: data });
        });
    }, 200); // Send 5 frames per second
}

// Start streaming
function startStream(config) {
    if (isStreaming) {
        console.log('Stream already running');
        return;
    }
    
    streamConfig = config;
    
    // Get RTMP URL based on platform if not custom
    const rtmpUrl = config.platform === 'custom' 
        ? config.rtmpUrl 
        : getRtmpUrl(config.platform, config.streamKey);
    
    if (!rtmpUrl) {
        io.emit('stream-status', { 
            status: 'Error', 
            message: 'Invalid streaming configuration' 
        });
        return;
    }
    
    // Check if window ID is provided
    if (!config.windowId) {
        io.emit('stream-status', { 
            status: 'Error', 
            message: 'No window selected for streaming' 
        });
        return;
    }
    
    // Get window position and size without requiring focus
    exec(`xwininfo -id 0x${config.windowId}`, (error, stdout) => {
        if (error) {
            console.error(`Error getting window info: ${error.message}`);
            io.emit('stream-status', { 
                status: 'Error', 
                message: 'Failed to get window information' 
            });
            return;
        }
        
        // Parse window position and size
        const absXMatch = stdout.match(/Absolute upper-left X:\s+(\d+)/);
        const absYMatch = stdout.match(/Absolute upper-left Y:\s+(\d+)/);
        const widthMatch = stdout.match(/Width:\s+(\d+)/);
        const heightMatch = stdout.match(/Height:\s+(\d+)/);
        
        if (absXMatch && absYMatch && widthMatch && heightMatch) {
            const x = parseInt(absXMatch[1]);
            const y = parseInt(absYMatch[1]);
            const width = parseInt(widthMatch[1]);
            const height = parseInt(heightMatch[1]);
            
            // Setup FFmpeg args for specific window capture
            const args = [
                '-f', 'x11grab',
                '-video_size', `${width}x${height}`,
                '-framerate', '30',
                '-draw_mouse', '1',
                '-i', `:0.0+${x},${y}`,
                '-f', 'pulse',
                '-ac', '2',
                '-i', 'default',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-b:v', `${config.videoBitrate}k`,
                '-maxrate', `${config.videoBitrate}k`,
                '-bufsize', `${config.videoBitrate * 2}k`,
                '-pix_fmt', 'yuv420p',
                '-g', '60',
                '-c:a', 'aac',
                '-b:a', `${config.audioBitrate}k`,
                '-ar', '44100',
                '-f', 'flv',
                rtmpUrl
            ];
            
            console.log(`Starting stream of window 0x${config.windowId} at ${x},${y} with size ${width}x${height}`);
            
            streamProcess = spawn('ffmpeg', args);
            
            streamProcess.stderr.on('data', (data) => {
                const output = data.toString();
                
                // Extract fps and bitrate from ffmpeg output
                const fpsMatch = output.match(/fps=\s*([0-9.]+)/);
                const bitrateMatch = output.match(/bitrate=\s*([0-9.]+)kbits\/s/);
                
                if (fpsMatch || bitrateMatch) {
                    const stats = {};
                    if (fpsMatch) stats.fps = parseFloat(fpsMatch[1]);
                    if (bitrateMatch) stats.bitrate = parseFloat(bitrateMatch[1]);
                    
                    io.emit('stream-stats', stats);
                }
            });
            
            streamProcess.on('close', (code) => {
                console.log(`Stream process exited with code ${code}`);
                
                if (isStreaming) {
                    // If the process ended unexpectedly
                    io.emit('stream-status', { 
                        status: 'Error', 
                        message: `Stream ended unexpectedly with code ${code}` 
                    });
                }
                
                isStreaming = false;
                streamProcess = null;
            });
            
            isStreaming = true;
            io.emit('stream-status', { status: 'Streaming' });
        } else {
            console.error('Failed to parse window position and size');
            io.emit('stream-status', { 
                status: 'Error', 
                message: 'Failed to parse window information' 
            });
        }
    });
}

// Stop streaming
function stopStream() {
    if (streamProcess) {
        streamProcess.kill('SIGINT'); // Send SIGINT to allow for clean shutdown
        streamProcess = null;
    }
    
    isStreaming = false;
    io.emit('stream-status', { status: 'Idle' });
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Send current status to the newly connected client
    socket.emit('stream-status', { 
        status: isStreaming ? 'Streaming' : 'Idle' 
    });
    
    // Handle window list request
    socket.on('get-windows', async () => {
        try {
            const windows = await getWindowsList();
            socket.emit('windows-list', windows);
        } catch (error) {
            console.error('Error getting windows list:', error);
            socket.emit('windows-list', []);
        }
    });
    
    // Handle window selection
    socket.on('select-window', (data) => {
        console.log(`Window selected: ${data.windowId}`);
        selectedWindow = data.windowId;
    });
    
    // Handle window preview request
    socket.on('get-window-preview', (data) => {
        if (data.windowId) {
            startWindowPreview(data.windowId);
        }
    });
    
    // Handle start streaming
    socket.on('start-stream', (config) => {
        console.log('Start streaming request received:', config);
        startStream(config);
    });
    
    // Handle stop streaming
    socket.on('stop-stream', () => {
        console.log('Stop streaming request received');
        stopStream();
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});

// Clean up on exit
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    
    if (streamProcess) {
        streamProcess.kill('SIGINT');
    }
    
    if (previewProcess) {
        previewProcess.kill();
    }
    
    server.close(() => {
        console.log('Server stopped');
        process.exit(0);
    });
});
EOF
    
    log "Server script created"
}

create_public_directory() {
    log "Creating public directory and files..."
    
    mkdir -p public
    
    # Create a temporary index.html that redirects to the main website
    cat > public/index.html << EOF
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OBS Streaming Tool</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            text-align: center;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }
        h1 {
            color: #6441a5;
        }
        p {
            margin: 20px 0;
            line-height: 1.6;
        }
        .status {
            font-weight: bold;
            color: #43b581;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>OBS Streaming Tool Server</h1>
        <div class="status">Server is running</div>
        <p>Please access the streaming tool from the web interface where you downloaded the server script.</p>
    </div>
</body>
</html>
EOF
}

# ---- Main Script ----
clear
echo "==============================================="
echo "  OBS Streaming Tool Server Setup"
echo "  For MX Linux"
echo "==============================================="
echo

# Create log file directory
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

# Create temp directory
mkdir -p "$TEMP_DIR"

log "Starting OBS Streaming Tool Server setup"

# Check for required dependencies
MISSING_DEPS=()

# Check for Node.js
if ! check_dependency "node"; then
    MISSING_DEPS+=("nodejs")
fi

# Check for FFmpeg
if ! check_dependency "ffmpeg"; then
    MISSING_DEPS+=("ffmpeg")
fi

# Check for X utilities
if ! check_dependency "xwininfo"; then
    MISSING_DEPS+=("x11-utils")
fi

if ! check_dependency "import"; then
    MISSING_DEPS+=("imagemagick")
fi

# Install missing dependencies
if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo "The following dependencies are missing and will be installed:"
    for dep in "${MISSING_DEPS[@]}"; do
        echo "  - $dep"
    done
    echo
    
    read -p "Do you want to install these dependencies? (y/n): " INSTALL_DEPS
    if [[ "$INSTALL_DEPS" =~ ^[Yy]$ ]]; then
        log "Installing missing dependencies"
        
        # Update package lists
        sudo apt-get update
        
        # Install dependencies through apt
        for dep in "${MISSING_DEPS[@]}"; do
            case "$dep" in
                nodejs)
                    install_nodejs
                    ;;
                ffmpeg)
                    install_ffmpeg
                    ;;
                *)
                    log "Installing $dep"
                    sudo apt-get install -y "$dep"
                    ;;
            esac
        done
    else
        log "User declined to install dependencies. Exiting."
        echo "Cannot continue without required dependencies. Exiting."
        exit 1
    fi
fi

# After installing dependencies, make sure we have xdotool
if ! command -v xdotool &> /dev/null; then
    log "Installing xdotool for window management"
    sudo apt-get install -y xdotool
fi

# Create server directory
SERVER_DIR="$HOME/obs-stream-server"
mkdir -p "$SERVER_DIR"
cd "$SERVER_DIR" || exit 1

log "Setting up server in $SERVER_DIR"

# Create server files
install_dependencies
create_server_script
create_public_directory

# Add script to start the server
cat > start-server.sh << EOF
#!/bin/bash
cd "\$(dirname "\$0")" || exit 1
export PORT=$PORT
export TEMP_DIR=$TEMP_DIR
node server.js
EOF

chmod +x start-server.sh

log "Setup completed successfully"

# Start the server
echo
echo "==============================================="
echo "  Setup completed successfully!"
echo "==============================================="
echo
echo "The OBS Streaming Tool Server has been installed to:"
echo "  $SERVER_DIR"
echo
echo "To start the server:"
echo "  $SERVER_DIR/start-server.sh"
echo
echo "The server will be accessible at:"
echo "  http://localhost:$PORT"
echo
read -p "Do you want to start the server now? (y/n): " START_SERVER
if [[ "$START_SERVER" =~ ^[Yy]$ ]]; then
    echo "Starting server..."
    ./start-server.sh
else
    echo "You can start the server later by running:"
    echo "  $SERVER_DIR/start-server.sh"
fi

exit 0