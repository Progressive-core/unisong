"""
WebSocket connection manager for fan-out to browser clients.
"""

import asyncio
import json
from typing import Dict, Set

from fastapi import WebSocket


class WebSocketManager:
    """Manages WebSocket connections and broadcasts messages."""

    def __init__(self):
        # Map of room_id -> set of WebSocket connections
        self._rooms: Dict[str, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, room_id: str):
        """Accept and register a WebSocket connection."""
        await websocket.accept()
        async with self._lock:
            if room_id not in self._rooms:
                self._rooms[room_id] = set()
            self._rooms[room_id].add(websocket)
        print(f"[WS] Client connected to room {room_id} (total: {len(self._rooms[room_id])})")

    async def disconnect(self, websocket: WebSocket, room_id: str):
        """Unregister a WebSocket connection."""
        async with self._lock:
            if room_id in self._rooms:
                self._rooms[room_id].discard(websocket)
                if not self._rooms[room_id]:
                    del self._rooms[room_id]
        print(f"[WS] Client disconnected from room {room_id}")

    async def send_to_client(self, websocket: WebSocket, message: dict):
        """Send a message to a specific client."""
        try:
            await websocket.send_json(message)
        except Exception:
            pass  # Client may have disconnected

    async def broadcast_to_room(self, room_id: str, message: dict):
        """Broadcast a message to all clients in a room."""
        async with self._lock:
            connections = self._rooms.get(room_id, set()).copy()

        disconnected = []
        for websocket in connections:
            try:
                await websocket.send_json(message)
            except Exception:
                disconnected.append(websocket)

        # Clean up disconnected clients
        if disconnected:
            async with self._lock:
                for ws in disconnected:
                    if room_id in self._rooms:
                        self._rooms[room_id].discard(ws)

    def get_room_count(self, room_id: str) -> int:
        """Get number of clients in a room."""
        return len(self._rooms.get(room_id, set()))
