"""
gRPC Core Service - Authoritative clock and room coordination.
"""

import asyncio
import time
from collections import defaultdict
from concurrent import futures

import grpc

# These will be generated from the proto file
import core.unisong_pb2 as pb2
import core.unisong_pb2_grpc as pb2_grpc

# Default lead time before playback starts (ms)
# Used when client doesn't provide a lead time
DEFAULT_LEAD_TIME_MS = 3000


def get_server_time_ms() -> int:
    """Get current server time in milliseconds.

    Returns Unix wall-clock time in milliseconds (not monotonic).
    """
    return int(time.time() * 1000)


class TimeServiceServicer(pb2_grpc.TimeServiceServicer):
    """Provides authoritative server time."""

    async def GetServerTime(self, request, context):
        return pb2.TimeResponse(server_time_ms=get_server_time_ms())


class RoomServiceServicer(pb2_grpc.RoomServiceServicer):
    """Manages rooms and coordinates playback scheduling."""

    def __init__(self):
        # Map of room_id -> list of asyncio.Queue for subscribers
        self._subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def _broadcast_to_room(self, room_id: str, event: pb2.RoomEvent):
        """Send event to all subscribers in a room."""
        async with self._lock:
            subscribers = self._subscribers.get(room_id, [])
            for queue in subscribers:
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    pass  # Skip slow consumers

    async def SchedulePlay(self, request, context):
        """Schedule playback for a room."""
        room_id = request.room_id
        lead_time = request.lead_time_ms if request.lead_time_ms > 0 else DEFAULT_LEAD_TIME_MS
        server_time = get_server_time_ms()
        play_at = server_time + lead_time

        # Create event and broadcast to subscribers
        event = pb2.RoomEvent(
            event_type=pb2.EVENT_TYPE_PLAY_SCHEDULED,
            play_at_ms=play_at,
            server_time_ms=server_time,
        )

        # Broadcast to all subscribers
        await self._broadcast_to_room(room_id, event)

        print(f"[Room {room_id}] Scheduled play at {play_at} (lead_time={lead_time}ms)")

        return pb2.SchedulePlayResponse(
            play_at_ms=play_at,
            server_time_ms=server_time,
        )

    async def SubscribeEvents(self, request, context):
        """Stream events for a room to a subscriber."""
        room_id = request.room_id
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)

        # Register subscriber
        async with self._lock:
            self._subscribers[room_id].append(queue)

        print(f"[Room {room_id}] New subscriber (total: {len(self._subscribers[room_id])})")

        try:
            while True:
                # Wait for events
                event = await queue.get()
                yield event
        except asyncio.CancelledError:
            pass
        finally:
            # Unregister subscriber
            async with self._lock:
                if queue in self._subscribers[room_id]:
                    self._subscribers[room_id].remove(queue)
            print(f"[Room {room_id}] Subscriber left (total: {len(self._subscribers[room_id])})")


async def serve():
    """Start the gRPC server."""
    server = grpc.aio.server()

    room_servicer = RoomServiceServicer()

    pb2_grpc.add_TimeServiceServicer_to_server(TimeServiceServicer(), server)
    pb2_grpc.add_RoomServiceServicer_to_server(room_servicer, server)

    server.add_insecure_port("[::]:50051")

    print("=" * 50)
    print("Unisong gRPC Core Service")
    print("=" * 50)
    print(f"Listening on port 50051")
    print(f"Default lead time: {DEFAULT_LEAD_TIME_MS}ms")
    print("=" * 50)

    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
