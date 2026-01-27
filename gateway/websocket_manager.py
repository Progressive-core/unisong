"""
WebSocket connection manager for fan-out to browser clients.
"""

import asyncio
import json
from typing import Dict, Set
from dataclasses import dataclass, asdict

from fastapi import WebSocket


@dataclass
class ClientInfo:
    """Information about a connected client."""
    client_id: str
    role: str  # 'master' or 'slave'
    ready: bool = False
    track_url: str = ""
    volume: float = 1.0  # Volume level 0.0 to 1.0 (default 100%)


class WebSocketManager:
    """Manages WebSocket connections and broadcasts messages."""

    def __init__(self):
        # Map of room_id -> set of WebSocket connections
        self._rooms: Dict[str, Set[WebSocket]] = {}
        # Map of WebSocket -> ClientInfo
        self._clients: Dict[WebSocket, ClientInfo] = {}
        # Map of room_id -> client_id counter
        self._client_counters: Dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, room_id: str, role: str = 'slave'):
        """Accept and register a WebSocket connection."""
        await websocket.accept()
        async with self._lock:
            # Generate unique client ID
            if room_id not in self._client_counters:
                self._client_counters[room_id] = 0
            self._client_counters[room_id] += 1
            client_id = f"{role}_{self._client_counters[room_id]}"

            # Register client
            if room_id not in self._rooms:
                self._rooms[room_id] = set()
            self._rooms[room_id].add(websocket)
            self._clients[websocket] = ClientInfo(client_id=client_id, role=role)

        print(f"[WS] Client {client_id} connected to room {room_id} (total: {len(self._rooms[room_id])})")

    async def disconnect(self, websocket: WebSocket, room_id: str):
        """Unregister a WebSocket connection."""
        async with self._lock:
            client_info = self._clients.get(websocket)
            client_id = client_info.client_id if client_info else "unknown"

            if room_id in self._rooms:
                self._rooms[room_id].discard(websocket)
                if not self._rooms[room_id]:
                    del self._rooms[room_id]

            if websocket in self._clients:
                del self._clients[websocket]

        print(f"[WS] Client {client_id} disconnected from room {room_id}")

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

    async def set_client_ready(self, websocket: WebSocket, ready: bool, track_url: str = ""):
        """Update client ready state."""
        async with self._lock:
            if websocket in self._clients:
                self._clients[websocket].ready = ready
                self._clients[websocket].track_url = track_url

    async def reset_ready_states(self, room_id: str):
        """Reset all clients in a room to not ready."""
        async with self._lock:
            connections = self._rooms.get(room_id, set())
            for ws in connections:
                if ws in self._clients:
                    self._clients[ws].ready = False
                    self._clients[ws].track_url = ""

    async def get_room_status(self, room_id: str) -> dict:
        """Get status of all clients in a room."""
        async with self._lock:
            connections = self._rooms.get(room_id, set())
            clients = []
            for ws in connections:
                if ws in self._clients:
                    info = self._clients[ws]
                    clients.append({
                        "client_id": info.client_id,
                        "role": info.role,
                        "ready": info.ready,
                        "track_url": info.track_url,
                        "volume": info.volume,
                    })
            return {
                "room_id": room_id,
                "client_count": len(clients),
                "clients": clients,
                "all_ready": all(c["ready"] for c in clients) if clients else False,
            }

    async def set_client_volume(self, room_id: str, client_id: str, volume: float):
        """Set volume for a specific client."""
        async with self._lock:
            connections = self._rooms.get(room_id, set())
            for ws in connections:
                if ws in self._clients and self._clients[ws].client_id == client_id:
                    self._clients[ws].volume = max(0.0, min(1.0, volume))  # Clamp 0-1
                    return True
            return False

    async def send_to_client_by_id(self, room_id: str, client_id: str, message: dict):
        """Send a message to a specific client by their client_id."""
        async with self._lock:
            connections = self._rooms.get(room_id, set())
            for ws in connections:
                if ws in self._clients and self._clients[ws].client_id == client_id:
                    try:
                        await ws.send_json(message)
                        return True
                    except Exception:
                        return False
            return False
