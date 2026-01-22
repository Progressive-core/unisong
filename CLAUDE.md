# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unisong is a synchronized audio playback system where multiple browser clients (master and slaves) start playback of the same audio file at the exact same time. It's a **time-coordinated control system**, not a media streaming service.

## Commands

```bash
make install    # Install Python dependencies
make proto      # Regenerate gRPC code from proto/unisong.proto
make core       # Run gRPC Core Service (port 50051)
make gateway    # Run FastAPI Gateway (port 8000)
make clean      # Remove generated files and __pycache__
```

Run services in separate terminals:
1. `make core` - gRPC Core Service
2. `make gateway` - FastAPI Gateway

Access the app:
- Master: `http://localhost:8000/?role=master`
- Slave: `http://localhost:8000/?role=slave`

## Architecture

```
Browser (Master/Slaves)
        │
        │ HTTP + WebSocket
        ▼
FastAPI Gateway (port 8000)
        │
        │ gRPC
        ▼
gRPC Core Service (port 50051)
```

### Key Architectural Principles

1. **gRPC Core is the timing authority** - All clock and scheduling logic lives here
2. **FastAPI Gateway is a transport adapter** - It relays messages, never modifies timestamps
3. **Browsers are local schedulers** - They receive future `play_at` timestamps and schedule locally
4. **Synchronize time, not actions** - Clients never receive "play now" commands; they receive scheduled future timestamps

### Component Responsibilities

**gRPC Core (`core/server.py`)**
- Authoritative clock source (`GetServerTime`)
- Scheduling playback (`SchedulePlay` computes `play_at = server_time + LEAD_TIME_MS`)
- Broadcasting events to subscribers (`SubscribeEvents` streaming RPC)

**FastAPI Gateway (`gateway/`)**
- HTTP endpoints for time sync and play commands
- WebSocket connections to browsers
- Fan-out of gRPC events to connected clients via `WebSocketManager`
- Acts as gRPC client to Core service

**Frontend (`frontend/`)**
- `clock_sync.js` - Calculates local-to-server time offset using RTT sampling
- `audio_player.js` - Web Audio API for precise scheduled playback via `AudioBufferSourceNode.start(when)`
- `app.js` - Coordinates clock sync, WebSocket, and audio playback
- `sync_diagnostics.js` - Read-only metrics for observing sync quality

### Critical Playback Sequence

Every playback **must** follow this sequence:
```javascript
stop() → loadAudio(url) → schedulePlayback(time)
```

Auto-next functionality (when track ends) must trigger a **new server request**, not direct playback. This ensures all clients stay synchronized.

### Time Synchronization Flow

1. Browser takes multiple RTT samples to `/api/time`
2. Uses sample with lowest RTT to estimate clock offset
3. Converts server `play_at` timestamps to local time: `localTime = serverTime - offset`
4. Schedules playback using Web Audio API's precise timing

### Proto Changes

After modifying `proto/unisong.proto`, run `make proto` to regenerate:
- `core/unisong_pb2.py`
- `core/unisong_pb2_grpc.py`
