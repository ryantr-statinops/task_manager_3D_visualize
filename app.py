#!/usr/bin/env python3
"""
System Monitor WebSocket Backend Service
=========================================
Collects real-time hardware performance metrics (CPU, RAM, GPU, Network)
and streams them via WebSocket to connected clients (e.g., Lively Wallpaper).

Specifications:
  - Sampling rate: 1 Hz (1 second interval)
  - WebSocket endpoint: ws://127.0.0.1:8080
  - JSON payload per the Data Contract in 02_websocket_bridge.md

Dependencies:
  pip install psutil websockets gputil
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import psutil
import websockets
from websockets.server import WebSocketServerProtocol

# ---------------------------------------------------------------------------
# Logging Configuration
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("sysmon")

# ---------------------------------------------------------------------------
# Optional GPU Support (GPUtil)
# ---------------------------------------------------------------------------

try:
    import GPUtil  # type: ignore[import-untyped]

    HAS_GPU = True
except (ImportError, ModuleNotFoundError):
    logger.warning("GPUtil not installed. GPU metrics will be unavailable.")
    HAS_GPU = False

# ---------------------------------------------------------------------------
# Data Structures
# ---------------------------------------------------------------------------


@dataclass
class NetworkSpeed:
    """Network I/O speed in KB/s."""

    sent_kbps: float = 0.0
    received_kbps: float = 0.0


@dataclass
class SystemMetrics:
    """Normalised payload matching the WebSocket Data Contract."""

    metric_id: int = 0
    cpu_usage: float = 0.0
    ram_usage: float = 0.0
    gpu_usage: float = 0.0
    vram_usage: float = 0.0
    gpu_temperature: float = 0.0
    network_speed: NetworkSpeed = field(default_factory=NetworkSpeed)
    # Extended detail fields for richer frontend visualisation
    cpu_detail: Dict[str, Any] = field(default_factory=dict)
    memory_detail: Dict[str, Any] = field(default_factory=dict)
    gpu_detail: List[Dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> str:
        """Serialize to the standardised JSON string."""
        return json.dumps(
            {
                "metric_id": self.metric_id,
                "cpu_usage": self.cpu_usage,
                "ram_usage": self.ram_usage,
                "gpu_usage": self.gpu_usage,
                "vram_usage": self.vram_usage,
                "gpu_temperature": self.gpu_temperature,
                "network_speed": {
                    "sent_kbps": round(self.network_speed.sent_kbps, 1),
                    "received_kbps": round(self.network_speed.received_kbps, 1),
                },
                # Extended detail (optional for frontend)
                "cpu_detail": self.cpu_detail,
                "memory_detail": self.memory_detail,
                "gpu_detail": self.gpu_detail,
            },
            ensure_ascii=False,
        )


# ---------------------------------------------------------------------------
# System Monitor
# ---------------------------------------------------------------------------


class SystemMonitor:
    """Collects system metrics asynchronously without blocking the event loop.

    CPU, Memory and Network are obtained via ``psutil`` (instant).
    GPU metrics are offloaded to a thread executor via ``GPUtil`` to avoid
    any potential blocking.
    """

    def __init__(self) -> None:
        self._prev_net: psutil._common.snetio = psutil.net_io_counters()
        self._prev_net_time: float = time.monotonic()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def collect(self) -> SystemMetrics:
        """Gather all metrics in a single async call (non-blocking)."""
        loop = asyncio.get_running_loop()

        # CPU -- interval=None gives an instantaneous non-blocking snapshot
        cpu_total = psutil.cpu_percent(interval=None)
        cpu_cores = psutil.cpu_percent(interval=None, percpu=True)

        # Memory
        mem = psutil.virtual_memory()

        # GPU -- offload to thread executor because GPUtil may do I/O
        gpu_load, gpu_vram, gpu_temp, gpu_detail = await loop.run_in_executor(
            None, self._get_gpu_metrics
        )

        # Network I/O speed (delta-based)
        net = await loop.run_in_executor(None, self._get_network_speed)

        # Compute statistical descriptors for 16 CPU cores
        core_values = [round(c, 1) for c in cpu_cores]
        core_count = len(core_values) if core_values else 1
        core_sum = sum(core_values)
        core_avg = round(core_sum / core_count, 1)
        core_var = round(
            sum((v - core_avg) ** 2 for v in core_values) / core_count, 2
        )
        core_std = round(core_var ** 0.5, 2)

        return SystemMetrics(
            metric_id=int(time.time()),
            cpu_usage=round(cpu_total, 1),
            ram_usage=round(mem.percent, 1),
            gpu_usage=round(gpu_load, 1),
            vram_usage=round(gpu_vram, 1),
            gpu_temperature=round(gpu_temp, 1),
            network_speed=net,
            cpu_detail={
                "total": round(cpu_total, 1),
                "cores": core_values,
                "avg_utilization": core_avg,
                "std_dev": core_std,
                "variance": core_var,
            },
            memory_detail={
                "total_gb": round(mem.total / (1024**3), 1),
                "used_gb": round(mem.used / (1024**3), 1),
                "percent": round(mem.percent, 1),
                "processes": await loop.run_in_executor(
                    None, self._get_top_processes
                ),
            },
            gpu_detail=gpu_detail,
        )

    # ------------------------------------------------------------------
    # GPU Metrics
    # ------------------------------------------------------------------

    def _get_gpu_metrics(
        self,
    ) -> Tuple[float, float, float, List[Dict[str, Any]]]:
        """Return (load%, vram%, temperature_C, detail_list).

        Prefers the NVIDIA Quadro T1000 if present; otherwise falls back
        to the first available GPU.
        """
        if not HAS_GPU:
            return 0.0, 0.0, 0.0, []

        try:
            gpus: List[Any] = GPUtil.getGPUs()
        except Exception as exc:
            logger.warning("GPUtil.getGPUs() failed: %s", exc)
            return 0.0, 0.0, 0.0, []

        if not gpus:
            return 0.0, 0.0, 0.0, []

        # Build detail list for all GPUs
        detail: List[Dict[str, Any]] = []
        primary_load = 0.0
        primary_vram = 0.0
        primary_temp = 0.0

        for gpu in gpus:
            gpu_info = {
                "name": gpu.name,
                "load_percent": round(gpu.load * 100, 1),
                "vram_percent": round(gpu.memoryUtil * 100, 1),
                "vram_used_mb": round(gpu.memoryUsed, 1),
                "vram_total_mb": round(gpu.memoryTotal, 1),
                "temperature_c": round(gpu.temperature, 1),
            }
            detail.append(gpu_info)

            # Prefer NVIDIA Quadro T1000
            if "Quadro" in gpu.name or "T1000" in gpu.name:
                primary_load = gpu.load * 100
                primary_vram = gpu.memoryUtil * 100
                primary_temp = gpu.temperature

        # If no Quadro T1000 found, use the first GPU
        if primary_load == 0.0 and primary_vram == 0.0:
            primary_load = gpus[0].load * 100
            primary_vram = gpus[0].memoryUtil * 100
            primary_temp = gpus[0].temperature

        return primary_load, primary_vram, primary_temp, detail

    # ------------------------------------------------------------------
    # Top Processes by Memory
    # ------------------------------------------------------------------

    def _get_top_processes(self, count: int = 15) -> List[Dict[str, Any]]:
        """Return the top-N processes sorted by memory usage (RSS).

        Uses ``psutil.process_iter()`` with a one-shot snapshot to
        minimise overhead. Processes that are inaccessible (zombies,
        permission-denied) are silently skipped.
        """
        results: List[Dict[str, Any]] = []
        try:
            for proc in psutil.process_iter(
                ["pid", "name", "memory_percent", "memory_info"]
            ):
                try:
                    info = proc.info
                    pid: int = info["pid"]
                    name: str = info["name"] or ""
                    mem_pct: float = info["memory_percent"] or 0.0
                    mem_info = info["memory_info"]
                    rss_mb: float = (
                        round(mem_info.rss / (1024 * 1024), 1)
                        if mem_info and mem_info.rss
                        else 0.0
                    )
                    results.append({
                        "pid": pid,
                        "name": name,
                        "memory_percent": round(mem_pct, 2),
                        "memory_mb": rss_mb,
                    })
                except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
                    continue
        except Exception:
            pass

        # Sort descending by memory_percent and take top N
        results.sort(key=lambda p: p["memory_percent"], reverse=True)
        return results[:count]

    # ------------------------------------------------------------------
    # Network Speed (Delta-based)
    # ------------------------------------------------------------------

    def _get_network_speed(self) -> NetworkSpeed:
        """Calculate sent/received KB/s since last poll."""
        current = psutil.net_io_counters()
        now = time.monotonic()
        elapsed = now - self._prev_net_time

        if elapsed > 0:
            sent_kbps = ((current.bytes_sent - self._prev_net.bytes_sent) / 1024) / elapsed
            recv_kbps = ((current.bytes_recv - self._prev_net.bytes_recv) / 1024) / elapsed
        else:
            sent_kbps = 0.0
            recv_kbps = 0.0

        self._prev_net = current
        self._prev_net_time = now

        return NetworkSpeed(sent_kbps=sent_kbps, received_kbps=recv_kbps)


# ---------------------------------------------------------------------------
# WebSocket Server
# ---------------------------------------------------------------------------


class WebSocketServer:
    """Manages WebSocket connections and broadcasts metrics at 1 Hz.

    Architecture
    ------------
    * Each connected client runs inside the ``handler`` coroutine which
      simply waits for the connection to close.
    * A separate ``broadcast_metrics`` task pushes data to **all** clients
      simultaneously every second.
    * Failed clients are removed from the set automatically.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 8080) -> None:
        self.host = host
        self.port = port
        self.monitor = SystemMonitor()
        self.clients: set[WebSocketServerProtocol] = set()
        self._broadcast_task: Optional[asyncio.Task[None]] = None

    # ------------------------------------------------------------------
    # Client Connection Handler
    # ------------------------------------------------------------------

    async def handler(self, websocket: WebSocketServerProtocol) -> None:
        """Register the client and keep the connection alive.

        Uses the modern ``websockets`` library pattern (v10+). The
        connection stays open until the remote peer closes it or an
        error occurs.
        """
        addr = websocket.remote_address
        logger.info("Client connected: %s", addr)
        self.clients.add(websocket)

        try:
            # Wait indefinitely for the client to close (no inbound messages expected)
            async for _ in websocket:
                pass
        except websockets.exceptions.ConnectionClosed as exc:
            logger.info("Client disconnected: %s (code=%s)", addr, exc.code)
        except Exception as exc:
            logger.warning("Client error (%s): %s", addr, exc)
        finally:
            self.clients.discard(websocket)
            logger.info(
                "Cleaned up %s. Active clients: %d", addr, len(self.clients)
            )

    # ------------------------------------------------------------------
    # Broadcast Loop
    # ------------------------------------------------------------------

    async def broadcast_metrics(self) -> None:
        """Collect and broadcast metrics every second to all clients."""
        while True:
            try:
                metrics = await self.monitor.collect()
                payload = metrics.to_json()

                # Fast path: no clients → skip send
                if not self.clients:
                    await asyncio.sleep(1)
                    continue

                # Broadcast to all connected clients concurrently
                tasks = [
                    client.send(payload) for client in list(self.clients)
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                # Eject clients that raised an exception
                dead: list[WebSocketServerProtocol] = []
                for client, result in zip(list(self.clients), results):
                    if isinstance(result, Exception):
                        dead.append(client)
                for client in dead:
                    self.clients.discard(client)

                await asyncio.sleep(1)  # 1 Hz sampling

            except asyncio.CancelledError:
                logger.info("Broadcast task cancelled – shutting down loop.")
                break
            except Exception as exc:
                logger.error("Broadcast error: %s", exc, exc_info=True)
                await asyncio.sleep(1)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Launch the server and the broadcast loop.

        The server runs until cancelled (Ctrl+C) or an unrecoverable
        error occurs.
        """
        logger.info("=" * 52)
        logger.info("  System Monitor WebSocket Server")
        logger.info("  Endpoint: ws://%s:%d", self.host, self.port)
        logger.info("  Sampling: 1 Hz")
        logger.info("=" * 52)

        try:
            async with websockets.serve(
                self.handler,
                self.host,
                self.port,
                ping_interval=20,   # keepalive ping every 20 s
                ping_timeout=10,    # drop client if no pong in 10 s
                max_size=2**16,     # 64 KB max message size
            ):
                logger.info("Server is ready. Press Ctrl+C to stop.")
                await self.broadcast_metrics()
        except OSError as exc:
            logger.error(
                "Cannot bind to %s:%d – is the port already in use?\n  %s",
                self.host,
                self.port,
                exc,
            )
            sys.exit(1)


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Application entry point."""
    server = WebSocketServer(host="127.0.0.1", port=8080)
    try:
        await server.start()
    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("Server stopped by user.")
    except Exception as exc:
        logger.error("Fatal error: %s", exc, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        # asyncio.run() already handles SIGINT gracefully,
        # but we provide a safety net.
        logger.info("Exiting.")
