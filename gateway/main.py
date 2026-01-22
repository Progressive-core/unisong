"""
FastAPI Gateway - HTTP/WebSocket interface for browser clients.
"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

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


# API Routes

@app.get("/api/time")
async def get_time():
    """Get current server time for clock synchronization."""
    server_time = await grpc_client.get_server_time()
    return JSONResponse({"server_time": server_time})


@app.post("/api/play")
async def schedule_play(room_id: str = "default", lead_time: int = 0):
    """Schedule playback for a room (master triggers this)."""
    play_at, server_time = await grpc_client.schedule_play(room_id, lead_time)
    return JSONResponse({
        "play_at": play_at,
        "server_time": server_time,
    })


# WebSocket endpoint

@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str = Query(default="default"),
):
    """WebSocket connection for receiving play events."""
    await ws_manager.connect(websocket, room_id)

    # Ensure we're subscribed to this room's gRPC events
    await ensure_room_subscription(room_id)

    try:
        # Send initial time sync
        server_time = await grpc_client.get_server_time()
        await ws_manager.send_to_client(websocket, {
            "type": "time_sync",
            "server_time": server_time,
        })

        # Keep connection alive and handle incoming messages
        while True:
            # We don't expect messages from client, but need to read to detect disconnect
            data = await websocket.receive_text()
            # Could handle ping/pong or other messages here if needed

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
