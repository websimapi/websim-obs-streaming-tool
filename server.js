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
    
    // Use ffmpeg to capture the window and output frames
    const args = [
        '-f', 'x11grab',
        '-video_size', '1280x720', // We can improve this by getting actual window size
        '-framerate', '10',
        '-i', `:0.0+0,0`,
        '-vf', `crop=iw:ih:0:0`,
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
    
    const args = [
        '-f', 'x11grab',
        '-video_size', '1280x720', // We can improve this by getting actual window size
        '-framerate', '30',
        '-i', `:0.0+0,0`,
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
    
    // Replace with window-specific capture configuration if a window is selected
    if (config.windowId) {
        // Get window position and size using xwininfo
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
                
                // Update the FFmpeg arguments to capture just this window
                const inputIndex = args.indexOf('-i') + 1;
                if (inputIndex > 0 && inputIndex < args.length) {
                    args[inputIndex] = `:0.0+${x},${y}`;
                }
                
                const sizeIndex = args.indexOf('-video_size') + 1;
                if (sizeIndex > 0 && sizeIndex < args.length) {
                    args[sizeIndex] = `${width}x${height}`;
                }
                
                console.log(`Streaming window 0x${config.windowId} at ${x},${y} with size ${width}x${height}`);
                startStreamProcess(args);
            } else {
                console.error('Failed to parse window position and size');
                startStreamProcess(args); // Fall back to default capture
            }
        });
    } else {
        startStreamProcess(args);
    }
}

// Helper function to start the streaming process
function startStreamProcess(args) {
    console.log(`Starting stream with args: ${args.join(' ')}`);
    
    streamProcess = spawn('ffmpeg', args);
    
    streamProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`Stream stderr: ${output}`);
        
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