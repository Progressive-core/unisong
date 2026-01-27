"""
FastAPI Gateway - HTTP/WebSocket interface for browser clients.
"""

import asyncio
import asyncio.subprocess
import json
import os
import re
import socket
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from zeroconf import ServiceInfo, Zeroconf

from gateway.grpc_client import GrpcClient
from gateway.websocket_manager import WebSocketManager
from core.unisong_pb2 import EventType

# Paths
BASE_DIR = Path(__file__).parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
SONGS_DIR = BASE_DIR / "songs"

# Global instances
grpc_client = GrpcClient()
ws_manager = WebSocketManager()
zeroconf_instance = None
service_info = None

# Track active room subscriptions
room_subscriptions: dict[str, asyncio.Task] = {}


async def subscribe_to_room(room_id: str):
    """Background task to subscribe to gRPC events and fan out to WebSockets."""
    try:
        async for event in grpc_client.subscribe_events(room_id):
            # Relay event as-is, translating field names for JSON
            message = {
                "type": EventType.Name(event.event_type),
                "play_at": event.play_at_ms,
                "server_time": event.server_time_ms,
                "track_url": event.track_url,
            }
            await ws_manager.broadcast_to_room(room_id, message)
            print(f"[Gateway] Broadcasted {message['type']} to room {room_id}")
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[Gateway] Room subscription error: {e}")


async def ensure_room_subscription(room_id: str):
    """Ensure there's an active subscription for a room."""
    if room_id not in room_subscriptions or room_subscriptions[room_id].done():
        room_subscriptions[room_id] = asyncio.create_task(subscribe_to_room(room_id))


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    global zeroconf_instance, service_info

    # Connect to gRPC
    await grpc_client.connect()

    # Register mDNS service
    try:
        zeroconf_instance = Zeroconf()
        local_ip = get_local_ip()

        # Create service info for unisong.local
        service_info = ServiceInfo(
            "_http._tcp.local.",
            "Unisong._http._tcp.local.",
            addresses=[socket.inet_aton(local_ip)],
            port=8000,
            properties={
                'path': '/',
                'version': '1.0',
            },
            server="unisong.local.",
        )

        zeroconf_instance.register_service(service_info)
        print(f"[Gateway] mDNS service registered: unisong.local -> {local_ip}:8000")
    except Exception as e:
        print(f"[Gateway] Failed to register mDNS service: {e}")
        print("[Gateway] Continuing without mDNS...")

    yield

    # Cleanup
    for task in room_subscriptions.values():
        task.cancel()
    await grpc_client.close()

    # Unregister mDNS service
    if zeroconf_instance and service_info:
        try:
            zeroconf_instance.unregister_service(service_info)
            zeroconf_instance.close()
            print("[Gateway] mDNS service unregistered")
        except Exception as e:
            print(f"[Gateway] Error unregistering mDNS: {e}")


app = FastAPI(title="Unisong Gateway", lifespan=lifespan)


# YouTube Download Helpers

def is_valid_youtube_url(url: str) -> bool:
    """Validate YouTube URL format."""
    youtube_patterns = [
        r'(https?://)?(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)/',
    ]
    return any(re.match(pattern, url) for pattern in youtube_patterns)


async def monitor_download_progress(
    process: asyncio.subprocess.Process,
    room_id: str,
    url: str,
):
    """Monitor yt-dlp download progress and broadcast via WebSocket."""
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break

            line_str = line.decode('utf-8').strip()

            # Parse progress percentage
            if "%" in line_str:
                match = re.search(r'(\d+\.?\d*)%', line_str)
                if match:
                    percent = float(match.group(1))
                    await ws_manager.broadcast_to_room(room_id, {
                        "type": "youtube_download_progress",
                        "url": url,
                        "progress": percent,
                    })

        await process.wait()

        if process.returncode == 0:
            await ws_manager.broadcast_to_room(room_id, {
                "type": "youtube_download_complete",
                "url": url,
                "status": "success",
            })
        else:
            stderr = await process.stderr.read()
            error_msg = stderr.decode('utf-8').strip()
            await ws_manager.broadcast_to_room(room_id, {
                "type": "youtube_download_complete",
                "url": url,
                "status": "error",
                "error": error_msg or "Download failed",
            })
    except Exception as e:
        await ws_manager.broadcast_to_room(room_id, {
            "type": "youtube_download_complete",
            "url": url,
            "status": "error",
            "error": str(e),
        })


# Helper functions

def get_local_ip():
    """Get the local network IP address of this server."""
    try:
        # Create a socket connection to determine local IP
        # We don't actually connect, just use it to determine the route
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception:
        # Fallback to localhost if we can't determine IP
        return "127.0.0.1"


# API Routes

@app.get("/health")
async def health_check():
    """Health check endpoint for monitoring service readiness."""
    return JSONResponse({"status": "ok", "service": "unisong-gateway"})


@app.get("/api/time")
async def get_time():
    """Get current server time for clock synchronization."""
    server_time = await grpc_client.get_server_time()
    return JSONResponse({"server_time": server_time})


@app.get("/api/network-info")
async def get_network_info():
    """Get server network information for QR code generation."""
    local_ip = get_local_ip()
    port = 8000  # FastAPI default port
    hostname = "unisong.local"

    return JSONResponse({
        "local_ip": local_ip,
        "port": port,
        "hostname": hostname,
        "slave_url": f"http://{hostname}:{port}/connect",
        "slave_url_ip": f"http://{local_ip}:{port}/connect"  # Fallback if mDNS doesn't work
    })


@app.get("/api/songs")
async def list_songs():
    """List available songs from the songs directory."""
    songs = []
    if SONGS_DIR.exists():
        for file_path in sorted(SONGS_DIR.iterdir()):
            if file_path.suffix.lower() in ('.mp3', '.wav', '.ogg', '.m4a'):
                songs.append({
                    "filename": file_path.name,
                    "url": f"/songs/{file_path.name}",
                    "title": file_path.stem,  # filename without extension
                })
    return JSONResponse({"songs": songs})


@app.get("/api/room/{room_id}/status")
async def get_room_status(room_id: str):
    """Get status of all clients in a room."""
    status = await ws_manager.get_room_status(room_id)
    return JSONResponse(status)


@app.post("/api/prepare")
async def prepare_track(room_id: str = "default", track_url: str = ""):
    """Tell all clients to prepare (load) a track, but don't play yet."""
    # Reset all ready states
    await ws_manager.reset_ready_states(room_id)

    # Broadcast prepare event to all clients
    await ws_manager.broadcast_to_room(room_id, {
        "type": "prepare_track",
        "track_url": track_url,
    })
    print(f"[Gateway] Prepare track broadcast to room {room_id}: {track_url}")

    # Broadcast updated status
    status = await ws_manager.get_room_status(room_id)
    await ws_manager.broadcast_to_room(room_id, {
        "type": "room_status",
        "status": status,
    })

    return JSONResponse({"status": "preparing"})


@app.post("/api/play")
async def schedule_play(room_id: str = "default", track_url: str = ""):
    """Schedule playback for a room (called when all clients ready)."""
    play_at, server_time = await grpc_client.schedule_play(room_id, track_url)
    return JSONResponse({
        "play_at": play_at,
        "server_time": server_time,
    })


@app.post("/api/youtube/download")
async def download_youtube(
    room_id: str = "default",
    url: str = "",
):
    """Download YouTube video as MP3 using yt-dlp."""
    if not url or not is_valid_youtube_url(url):
        return JSONResponse(
            {"error": "Invalid YouTube URL"},
            status_code=400
        )

    filename_template = "%(title)s.%(ext)s"

    cmd = [
        "yt-dlp",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--output", str(SONGS_DIR / filename_template),
        "--no-playlist",
        "--no-check-certificate",
        "--progress-template", "download:%(progress.percent)s",
        url,
    ]

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        asyncio.create_task(
            monitor_download_progress(process, room_id, url)
        )

        return JSONResponse({"status": "started", "url": url})
    except Exception as e:
        return JSONResponse(
            {"error": f"Download failed: {str(e)}"},
            status_code=500
        )


# WebSocket endpoint

@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str = Query(default="default"),
    role: str = Query(default="slave"),
):
    """WebSocket connection for receiving play events."""
    await ws_manager.connect(websocket, room_id, role)

    # Ensure we're subscribed to this room's gRPC events
    await ensure_room_subscription(room_id)

    try:
        # Send initial time sync
        server_time = await grpc_client.get_server_time()
        await ws_manager.send_to_client(websocket, {
            "type": "time_sync",
            "server_time": server_time,
        })

        # Handle incoming messages from client
        while True:
            data = await websocket.receive_text()
            message = json.loads(data) if data else {}

            # Handle client ready/not-ready messages
            if message.get("type") == "client_ready":
                await ws_manager.set_client_ready(websocket, True, message.get("track_url", ""))
                print(f"[Gateway] Client ready in room {room_id}: {message.get('track_url')}")

                # Get room status
                status = await ws_manager.get_room_status(room_id)

                # Broadcast room status to all clients
                await ws_manager.broadcast_to_room(room_id, {
                    "type": "room_status",
                    "status": status,
                })

                # Auto-trigger play when ALL clients are ready
                if status["all_ready"] and status["client_count"] > 0:
                    track_url = message.get("track_url", "")
                    print(f"[Gateway] All clients ready! Auto-triggering play: {track_url}")

                    # Schedule play via gRPC
                    play_at, server_time = await grpc_client.schedule_play(room_id, track_url)
                    print(f"[Gateway] Auto-scheduled play_at={play_at}")
                    # Note: The gRPC event will be broadcast automatically via subscribe_to_room

            elif message.get("type") == "client_not_ready":
                await ws_manager.set_client_ready(websocket, False, "")
                print(f"[Gateway] Client not ready in room {room_id}")

                # Broadcast room status to all clients
                status = await ws_manager.get_room_status(room_id)
                await ws_manager.broadcast_to_room(room_id, {
                    "type": "room_status",
                    "status": status,
                })

            elif message.get("type") == "set_volume":
                # Master can control volume of individual slaves
                target_client = message.get("target_client", "")
                volume = message.get("volume", 1.0)

                if role == "master" and target_client:
                    # Update volume in manager
                    await ws_manager.set_client_volume(room_id, target_client, volume)

                    # Send volume update to target client
                    await ws_manager.send_to_client_by_id(room_id, target_client, {
                        "type": "volume_change",
                        "volume": volume,
                    })

                    print(f"[Gateway] Master set {target_client} volume to {volume:.2f}")

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket, room_id)


# Static file serving

@app.get("/")
async def serve_index():
    """Serve the main HTML page."""
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/connect")
async def connect_slave(room: str = "default"):
    """Clean URL for slave clients - redirects to /?role=slave&room={room}"""
    return RedirectResponse(f"/?role=slave&room={room}")


@app.get("/master")
async def connect_master(room: str = "default"):
    """Clean URL for master clients - redirects to /?role=master&room={room}"""
    return RedirectResponse(f"/?role=master&room={room}")


@app.get("/songs/{filename}")
async def serve_song(filename: str):
    """Serve audio files."""
    file_path = SONGS_DIR / filename
    if file_path.exists():
        return FileResponse(file_path, media_type="audio/mpeg")
    return JSONResponse({"error": "File not found"}, status_code=404)


# Mount static files for JS
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
