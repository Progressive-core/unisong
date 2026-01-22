"""
gRPC client wrapper for the gateway to communicate with Core Service.
"""

import asyncio
from typing import AsyncIterator

import grpc

import core.unisong_pb2 as pb2
import core.unisong_pb2_grpc as pb2_grpc


class GrpcClient:
    """Async gRPC client for communicating with Core Service."""

    def __init__(self, host: str = "localhost", port: int = 50051):
        self._address = f"{host}:{port}"
        self._channel = None
        self._time_stub = None
        self._room_stub = None

    async def connect(self):
        """Establish connection to gRPC server."""
        self._channel = grpc.aio.insecure_channel(self._address)
        self._time_stub = pb2_grpc.TimeServiceStub(self._channel)
        self._room_stub = pb2_grpc.RoomServiceStub(self._channel)
        print(f"gRPC client connected to {self._address}")

    async def close(self):
        """Close the gRPC connection."""
        if self._channel:
            await self._channel.close()

    async def get_server_time(self) -> int:
        """Get current server time in milliseconds."""
        response = await self._time_stub.GetServerTime(pb2.Empty())
        return response.server_time_ms

    async def schedule_play(self, room_id: str, lead_time_ms: int = 0) -> tuple[int, int]:
        """
        Schedule playback for a room.
        Returns (play_at_ms, server_time_ms).
        """
        request = pb2.SchedulePlayRequest(room_id=room_id, lead_time_ms=lead_time_ms)
        response = await self._room_stub.SchedulePlay(request)
        return response.play_at_ms, response.server_time_ms

    async def subscribe_events(self, room_id: str) -> AsyncIterator:
        """Subscribe to room events. Yields RoomEvent objects."""
        request = pb2.SubscribeRequest(room_id=room_id)
        async for event in self._room_stub.SubscribeEvents(request):
            yield event
