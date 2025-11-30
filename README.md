# Docker Terminal Access via WebSocket

Secure, remote shell access to Docker containers from anywhere. This service provides real-time, interactive terminal access to Docker containers over WebSocket Secure (WSS).

## Use Case

**Problem:** You have multiple Docker containers running on a host machine and want to access their shells from anywhere - your local machine, another server, or any remote location.

**Solution:**
1. Run this service on your Docker host machine
2. Call the API to create a WSS (WebSocket Secure) connection
3. Gain terminal access to any container from anywhere - no SSH needed!

## How It Works

1. **Install on Host** - Deploy this service on the machine where your Docker containers run
2. **Get WSS URL** - Call `/getaccess` API with container name to get a secure WebSocket URL
3. **Connect from Anywhere** - Use the WSS URL to access the container shell from any location:
   - Web browser (built-in UI with xterm.js)
   - Any WebSocket client
   - Your own application/script

## Features

- HTTPS & WSS (WebSocket Secure)
- API Key Authentication
- JWT tokens for WebSocket sessions
- Nginx reverse proxy with SSL
- Full terminal emulation (xterm.js)
- Web UI Mode for easy browser-based access

## Quick Start

### Step 1: Run on Your Docker Host Machine

```bash
# Clone and start the service
docker-compose up -d --build

# Service is now running and ready to provide access
```

### Step 2: Access from Anywhere

**Option A: Web UI (Browser)**
```
https://YOUR_HOST_IP:9443

Enter container name and API key to connect
```

**Option B: API (Programmatic)**
```bash
# From your local machine or any server
curl -k -H "X-API-Key: YOUR_API_KEY" \
  "https://YOUR_HOST_IP:9443/getaccess?containerName=my-container"

# Returns WSS URL - connect with any WebSocket client
```

## API Usage

### Get WebSocket URL

```bash
# Request access to a container
curl -k -H "X-API-Key: YOUR_API_KEY" \
  "https://YOUR_HOST_IP:9443/getaccess?containerName=CONTAINER_NAME"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "wss://YOUR_HOST_IP:9443/terminal?token=eyJhbGc...",
    "token": "eyJhbGc...",
    "sessionId": "uuid-here",
    "containerName": "my-container",
    "containerId": "abc123...",
    "expiresIn": "5m"
  }
}
```

Use the `url` field to connect your WebSocket client and get terminal access!

**Default API Key:**
```
OiI0MmQxZmY2Mi0yY2JjLTRjMDgtYmRkZS1lZjg0YTVmZjFmMDgiLCJ0eXBlIjoidGVybWluYWwtYWNj
```
(Change this in `docker-compose.yml` for production!)

## Example Workflow

### Scenario: Access container on remote server from local machine

1. **On Remote Server (192.168.1.100):**
   ```bash
   # Run this service
   docker-compose up -d --build
   ```

2. **From Your Local Machine:**
   ```bash
   # Get WSS URL
   curl -k -H "X-API-Key: OiI0MmQxZmY2Mi0yY2JjLTRjMDgtYmRkZS1lZjg0YTVmZjFmMDgiLCJ0eXBlIjoidGVybWluYWwtYWNj" \
     "https://192.168.1.100:9443/getaccess?containerName=my-nginx"

   # Or just open browser:
   # https://192.168.1.100:9443
   # Enter: my-nginx + API key
   # You're now in the container shell!
   ```

3. **Done!** You now have full terminal access to `my-nginx` container running on the remote server.

## Ports

- **9080** - HTTP (redirects to HTTPS)
- **9443** - HTTPS/WSS

## Configuration

Edit `docker-compose.yml` to change:
- **UI_MODE** - Enable/disable web interface (`true`/`false`)
- **API_KEYS** - Comma-separated list of valid API keys
- **JWT_SECRET** - Secret key for JWT token signing
- **TOKEN_EXPIRY** - How long tokens are valid (default: 5m)
- **REQUIRE_AUTH** - Enable/disable API key authentication
- Ports (9080 for HTTP, 9443 for HTTPS)

### UI Mode

When `UI_MODE=true` (default), a web interface is available at the root URL:
- Browse to `https://localhost:9443`
- Enter container name and API key
- Terminal opens in your browser using xterm.js

When `UI_MODE=false`, only the API endpoints are available.

## Test Containers

- `test-ubuntu` - Ubuntu 22.04
- `test-alpine` - Alpine Linux
- `test-nginx` - Nginx

## Files

- `client.html` - Web terminal interface
- `nginx/nginx.conf` - Nginx configuration
- `src/server.js` - Backend API
- `docker-compose.yml` - Services configuration

## Security Note

Uses self-signed SSL certificates for development. For production, replace with real certificates from Let's Encrypt or a CA.
