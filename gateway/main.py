"""
FastAPI Gateway - HTTP/WebSocket interface for browser clients.
"""

import asyncio
import asyncio.subprocess
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

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
    await grpc_client.connect()
    yield
    # Cleanup
    for task in room_subscriptions.values():
        task.cancel()
    await grpc_client.close()


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


# API Routes

@app.get("/api/time")
async def get_time():
    """Get current server time for clock synchronization."""
    server_time = await grpc_client.get_server_time()
    return JSONResponse({"server_time": server_time})


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

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket, room_id)


# Static file serving

@app.get("/")
async def serve_index():
    """Serve the main HTML page."""
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/songs/{filename}")
async def serve_song(filename: str):
    """Serve audio files."""
    file_path = SONGS_DIR / filename
    if file_path.exists():
        return FileResponse(file_path, media_type="audio/mpeg")
    return JSONResponse({"error": "File not found"}, status_code=404)


# Mount static files for JS
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
