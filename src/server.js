require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const Docker = require('dockerode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '5m'; // 5 minutes
const HOST = process.env.HOST || 'localhost';
const PROTOCOL = process.env.PROTOCOL || 'ws'; // 'ws' or 'wss'
const API_KEYS = process.env.API_KEYS ? process.env.API_KEYS.split(',') : ['default-api-key-change-me'];
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== 'false'; // true by default
const UI_MODE = process.env.UI_MODE === 'true'; // false by default

// Initialize Docker client
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Middleware
app.use(cors());
app.use(express.json());

// Store active sessions
const activeSessions = new Map();

/**
 * Serve UI if UI_MODE is enabled
 */
if (UI_MODE) {
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
  });
}

/**
 * Authentication Middleware
 * Validates API key from header or query parameter
 */
function authenticateApiKey(req, res, next) {
  // Skip auth if disabled
  if (!REQUIRE_AUTH) {
    return next();
  }

  // Get API key from header or query parameter
  const apiKey = req.headers['x-api-key'] ||
                 req.headers['authorization']?.replace('Bearer ', '') ||
                 req.query.apiKey;

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'API key is required. Provide via X-API-Key header, Authorization header, or apiKey query parameter'
    });
  }

  // Validate API key
  if (!API_KEYS.includes(apiKey)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  // API key is valid, continue
  next();
}

/**
 * Generate JWT token for WebSocket authentication
 */
function generateToken(containerName, sessionId) {
  return jwt.sign(
    {
      containerName,
      sessionId,
      type: 'terminal-access'
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * API Endpoint: /getaccess
 * Returns WebSocket URL with token for container access
 */
app.get('/getaccess', authenticateApiKey, async (req, res) => {
  try {
    const { containerName } = req.query;

    if (!containerName) {
      return res.status(400).json({
        success: false,
        error: 'containerName is required as query parameter'
      });
    }

    // Verify container exists
    const containers = await docker.listContainers({ all: true });
    const container = containers.find(c =>
      c.Names.some(name => name.includes(containerName)) || c.Id.startsWith(containerName)
    );

    if (!container) {
      return res.status(404).json({
        success: false,
        error: `Container '${containerName}' not found`
      });
    }

    // Check if container is running
    if (container.State !== 'running') {
      return res.status(400).json({
        success: false,
        error: `Container '${containerName}' is not running (state: ${container.State})`
      });
    }

    // Generate session ID and token
    const sessionId = uuidv4();
    const token = generateToken(containerName, sessionId);

    // Store session info
    activeSessions.set(sessionId, {
      containerName,
      containerId: container.Id,
      createdAt: Date.now()
    });

    // Clean up old sessions (older than 10 minutes)
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    for (const [id, session] of activeSessions.entries()) {
      if (session.createdAt < tenMinutesAgo) {
        activeSessions.delete(id);
      }
    }

    // Return WebSocket URL (proxy-aware)
    // Check if behind nginx proxy using X-Forwarded-Proto header
    const forwardedProto = req.headers['x-forwarded-proto'] || PROTOCOL;
    const wsProtocol = forwardedProto === 'https' ? 'wss' : 'ws';

    // Use forwarded host or configured host
    let forwardedHost = req.headers['x-forwarded-host'] || req.headers.host || HOST;

    // Smart port handling:
    // - If Host already includes a non-standard port (like localhost:9443), keep it
    // - If host is without port (like ai.sshai.convesio.com), don't add port (assumes standard 443/80)
    const hostHasPort = forwardedHost.includes(':');
    if (hostHasPort) {
      const port = forwardedHost.split(':')[1];
      // If it's a standard port, remove it
      if (port === '80' || port === '443') {
        forwardedHost = forwardedHost.split(':')[0];
      }
      // Otherwise keep the port as-is (e.g., localhost:9443)
    }

    // Build WebSocket URL
    const wsUrl = `${wsProtocol}://${forwardedHost}/terminal?token=${token}`;

    res.json({
      success: true,
      data: {
        url: wsUrl,
        token: token,
        sessionId: sessionId,
        containerName: containerName,
        containerId: container.Id,
        expiresIn: TOKEN_EXPIRY
      }
    });

  } catch (error) {
    console.error('Error in /getaccess:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString()
  });
});

/**
 * WebSocket connection handler
 */
wss.on('connection', async (ws, req) => {
  // Parse token from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.send(JSON.stringify({ error: 'No token provided' }));
    ws.close();
    return;
  }

  // Verify token
  const decoded = verifyToken(token);
  if (!decoded) {
    ws.send(JSON.stringify({ error: 'Invalid or expired token' }));
    ws.close();
    return;
  }

  const { containerName, sessionId } = decoded;

  // Verify session exists
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) {
    ws.send(JSON.stringify({ error: 'Session not found or expired' }));
    ws.close();
    return;
  }

  console.log(`WebSocket connected for container: ${containerName}, session: ${sessionId}`);

  try {
    // Get container
    const container = docker.getContainer(sessionInfo.containerId);

    // Create exec instance
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color'],
      Cmd: ['/bin/sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi']
    });

    // Start exec and get stream
    const stream = await exec.start({
      hijack: true,
      stdin: true,
      Tty: true
    });

    // Handle WebSocket messages (base64 encoded like Rancher)
    ws.on('message', (message) => {
      try {
        // Decode base64 input
        const decoded = Buffer.from(message.toString(), 'base64');

        // Filter 1: Detect specific corruption pattern: 0xCD 0xE4 0xD3 0x63 ('c')
        // This is the "\315\344\323c" pattern that appears during resize
        if (decoded.length >= 4 &&
            decoded[0] === 0xCD &&
            decoded[1] === 0xE4 &&
            decoded[2] === 0xD3 &&
            decoded[3] === 0x63) { // 'c'
          console.log('Filtering resize corruption pattern:', decoded.toString('hex').substring(0, 50));
          return;
        }

        // Filter 2: Detect any short message starting with high bytes
        // Likely terminal control sequences
        if (decoded.length < 50 && decoded.length > 0) {
          const firstByte = decoded[0];
          if (firstByte > 0x7F) {
            console.log('Filtering high-byte sequence:', decoded.toString('hex').substring(0, 50));
            return;
          }
        }

        // Filter 3: Check if contains binary control sequences (resize events)
        // OSC sequences often start with ESC ] or contain specific patterns
        const hasControlSeq = decoded.includes(0x1b) && decoded.includes(0x5d); // ESC ]

        if (hasControlSeq) {
          // Log and skip OSC/resize sequences
          console.log('Skipping ESC ] control sequence:', decoded.toString('hex').substring(0, 50));
          return;
        }

        const text = decoded.toString('utf-8');

        // Check if this is a resize command (format: "rows,cols" or JSON)
        // Common patterns: "80,24" or {"Width":80,"Height":24}
        if (text.match(/^\d+,\d+$/)) {
          // Format: "cols,rows"
          const [cols, rows] = text.split(',').map(Number);
          console.log(`Resize: ${cols}x${rows}`);
          exec.resize({ h: rows, w: cols }).catch(err =>
            console.error('Resize error:', err)
          );
          return;
        }

        // Check for JSON resize format
        if (text.startsWith('{') && (text.includes('Width') || text.includes('height'))) {
          try {
            const resizeData = JSON.parse(text);
            const rows = resizeData.Height || resizeData.height || resizeData.h;
            const cols = resizeData.Width || resizeData.width || resizeData.w;
            if (rows && cols) {
              console.log(`Resize JSON: ${cols}x${rows}`);
              exec.resize({ h: rows, w: cols }).catch(err =>
                console.error('Resize error:', err)
              );
              return;
            }
          } catch (e) {
            // Not valid JSON, treat as regular input
          }
        }

        // Regular input - send to container
        stream.write(decoded);
      } catch (err) {
        console.error('Error decoding base64 input:', err);
      }
    });

    // Handle container output - TTY mode gives raw stream without multiplexing
    stream.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // TTY mode: data comes as raw buffer, encode to base64
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const encoded = buffer.toString('base64');
          ws.send(encoded);
        } catch (err) {
          console.error('Error encoding output:', err);
        }
      }
    });

    // Handle stream end
    stream.on('end', () => {
      console.log(`Stream ended for session: ${sessionId}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    // Handle WebSocket close
    ws.on('close', () => {
      console.log(`WebSocket closed for session: ${sessionId}`);
      stream.end();
      activeSessions.delete(sessionId);
    });

    // Handle errors
    stream.on('error', (error) => {
      console.error('Stream error:', error);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: error.message }));
        ws.close();
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      stream.end();
    });

  } catch (error) {
    console.error('Error creating exec:', error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ error: error.message }));
      ws.close();
    }
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API endpoint: http://${HOST}:${PORT}/getaccess`);
  console.log(`WebSocket endpoint: ${PROTOCOL}://${HOST}:${PORT}/terminal`);
  if (UI_MODE) {
    console.log(`UI Mode: ENABLED - Access web interface at http://${HOST}:${PORT}/`);
  } else {
    console.log(`UI Mode: DISABLED`);
  }
});
