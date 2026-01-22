Project Overview

This project implements a synchronous media start system where multiple browser clients (master and slaves) start playback of the same audio file at the same time.

The system is designed around a FastAPI → gRPC architecture:

FastAPI acts as an HTTP/WebSocket gateway for browsers.

gRPC Core acts as the authoritative backend for time, scheduling, and synchronization logic.

⚠️ Important constraint:
Browsers cannot communicate with gRPC directly, therefore all browser communication goes through FastAPI.

High-Level Architecture
Browser (Master / Slaves)
        │
        │ HTTP + WebSocket
        ▼
FastAPI Gateway (port 8000)
        │
        │ gRPC
        ▼
gRPC Core Service (port 50051)

Key principles

FastAPI does not perform precise timing

gRPC is the source of truth for time

Clients never receive “play now” commands

Clients receive scheduled future timestamps (play_at)

Roles and Responsibilities
FastAPI Gateway

Responsible for:

HTTP endpoints (room creation, joining)

WebSocket connections to browsers

Fan-out of events to connected clients

Acting as a gRPC client to the Core service

Not responsible for:

Clock synchronization logic

Precise timing calculations

Audio playback logic

FastAPI is a transport adapter, not a timing authority.

gRPC Core Service

Responsible for:

Being the authoritative clock

Scheduling playback events

Computing play_at timestamps in server time

Broadcasting control events to FastAPI

gRPC never communicates with browsers directly.

Initial Scope (IMPORTANT)
First milestone: ONLY synchronous start of a single audio file

To reduce complexity, the first implementation MUST:

Support only one audio file

The file is stored locally in the project root directory

No playlists

No pause, seek, or resume

No multiple tracks

No persistence

The only supported action is:

Synchronously start playback of one predefined audio file

This is intentional and non-negotiable for the first iteration.

Audio Model (Initial)

Audio file path:

.songs/Aerial Boundaries.mp3


The file is preloaded by all browser clients before playback

Playback is started locally using Web Audio API (handled on the frontend)

Backend only coordinates time

Synchronization Model
Core idea

We synchronize time, not actions.

The system works by scheduling playback in the future.

Timeline

Master requests playback

gRPC Core schedules:

play_at = server_time + LEAD_TIME


Event is sent to FastAPI

FastAPI broadcasts event via WebSocket

Each browser converts play_at → local time

Playback starts locally at the scheduled moment

Network latency does not affect the start moment, only the delivery of the schedule.

Clock Synchronization (Simplified for MVP)

For the first version:

FastAPI periodically requests server_time from gRPC

FastAPI forwards server timestamps to browsers via WebSocket

Browsers estimate:

RTT to FastAPI

Approximate clock offset to server time

This is not sample-accurate, but sufficient for MVP-level sync.

gRPC Core API (Conceptual)

The gRPC service must expose:

Unary RPCs

GetServerTime

SchedulePlay

Server-side Streaming

SubscribeEvents

The Core service must:

Maintain current server time

Accept scheduling requests

Emit PlayScheduled events

FastAPI ↔ gRPC Interaction

FastAPI:

Maintains a persistent gRPC connection

Subscribes to Core events

Relays events to browsers via WebSocket

FastAPI must NOT:

Recalculate timestamps

Modify play_at

Introduce its own timing logic

WebSocket Protocol (Browser ↔ FastAPI)
Server → Browser messages
{
  "type": "time_sync",
  "server_time": 1234567890
}

{
  "type": "play",
  "play_at": 1234567990
}

Browser responsibilities

Maintain local clock offset estimate

Schedule playback using play_at

Never start playback immediately upon message receipt

Master vs Slaves

Master

Sends play command via HTTP or WebSocket

Slaves

Receive scheduled play events only

Cannot initiate playback

The gRPC Core does not care about UI roles — it only processes scheduling requests.

What NOT to implement yet

The following are explicitly out of scope for the first version:

Audio streaming from backend

Multiple audio files

Pause / resume

Seeking

Late join compensation

Persistent rooms

Authentication

Database storage

Success Criteria for First Milestone

The implementation is considered successful when:

Multiple browser clients connect

All preload the same audio file

Master triggers playback

All clients start playback approximately simultaneously

Timing is based on play_at, not message arrival

Summary

This project is a time-coordinated control system, not a media streaming service.

FastAPI = gateway and transport

gRPC = timing authority

Browsers = local schedulers

First goal = synchronous start of one local audio file

Build only this, then stop.