const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocket.Server({ server });

const rooms = {};
const TICK_RATE = 60;
const TICK_TIME = 1000 / TICK_RATE;

const LANE_X = [-4, 0, 4];
const PLAYER_START_Y = 1;
const PLAYER_START_Z = 0;
const OBSTACLE_BOUNDS = 1.6;

// Helper to broadcast to a room
const broadcastToRoom = (roomId, data) => {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
            client.send(JSON.stringify(data));
        }
    });
};

const startGame = (roomId) => {
    const room = rooms[roomId];
    if (!room || room.running) return;

    console.log(`Starting game in room ${roomId}`);
    room.running = true;
    room.score = 0;
    room.t = 0; // Time accumulator for speed calculation
    room.obstacles = [];
    
    // Initialize players for the start of the game
    for (const playerId in room.players) {
        const player = room.players[playerId];
        player.alive = true;
        player.x = 0;
        player.y = PLAYER_START_Y;
        player.z = PLAYER_START_Z;
        player.laneTarget = 1; // Center lane index
        player.laneCurrent = 0; // Actual X position
    }

    // Initial obstacle spawn
    for (let i = 1; i <= 8; i++) {
        spawnObstacle(room, -i * 20);
    }

    room.gameInterval = setInterval(() => gameLoop(roomId), TICK_TIME);
};

const stopGame = (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.running) return;

    console.log(`Stopping game in room ${roomId}`);
    clearInterval(room.gameInterval);
    room.running = false;
    
    broadcastToRoom(roomId, { type: 'gameOver', roomId });
};

const spawnObstacle = (room, z) => {
    const laneIndex = Math.floor(Math.random() * LANE_X.length);
    room.obstacles.push({
        id: uuidv4(),
        x: LANE_X[laneIndex],
        y: 0.9,
        z: z,
    });
};

const gameLoop = (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.running) return;

    room.t += TICK_TIME / 1000; // Increment time in seconds
    const speed = 0.5 + Math.min(3.5, room.t * 0.12);
    room.score += speed * (TICK_TIME / 1000) * 10;

    // Update obstacles
    for (let i = room.obstacles.length - 1; i >= 0; i--) {
        const o = room.obstacles[i];
        o.z += speed;
        if (o.z > 6) {
            // Recycle obstacle
            o.z = -(160 + Math.random() * 80);
            o.x = LANE_X[Math.floor(Math.random() * LANE_X.length)];
        }
    }

    let playersAlive = 0;
    // Update players and check for collisions
    for (const playerId in room.players) {
        const player = room.players[playerId];
        if (!player.alive) continue;

        playersAlive++;

        // Smooth lane interpolation
        const targetX = LANE_X[player.laneTarget];
        player.laneCurrent += (targetX - player.laneCurrent) * 0.15; // Smoothing factor
        player.x = player.laneCurrent;

        // Collision detection
        for (const o of room.obstacles) {
            const dx = Math.abs(o.x - player.x);
            const dz = Math.abs(o.z - player.z);
            if (dx < OBSTACLE_BOUNDS && dz < OBSTACLE_BOUNDS) {
                player.alive = false;
                console.log(`Player ${playerId} collided and is now dead.`);
                break; // No need to check other obstacles for this player
            }
        }
    }

    if (playersAlive === 0 && Object.keys(room.players).length > 0) {
        stopGame(roomId);
        return;
    }

    // Broadcast the new game state
    broadcastToRoom(roomId, {
        type: 'gameState',
        roomId,
        payload: {
            players: room.players,
            obstacles: room.obstacles,
            score: Math.floor(room.score),
            running: room.running,
        },
    });
};

wss.on("connection", (ws) => {
    console.log("Player connected");

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);
            const { roomId, playerId, action, payload } = data;

            if (!rooms[roomId]) {
                rooms[roomId] = { players: {}, running: false };
            }
            const room = rooms[roomId];

            switch (action) {
                case "join":
                    ws.roomId = roomId;
                    ws.playerId = playerId;
                    room.players[playerId] = {
                        nickname: payload.nickname,
                        color: payload.color,
                        ready: false,
                        alive: true,
                        x: 0, y: PLAYER_START_Y, z: PLAYER_START_Z,
                        laneTarget: 1, laneCurrent: 0,
                    };
                    console.log(`Player ${playerId} joined room ${roomId}`);
                    broadcastToRoom(roomId, { type: "state", roomId, players: room.players });
                    break;

                case "update": // Used for things like 'ready' status
                    const player = room.players[playerId];
                    if (player) Object.assign(player, payload);
                    broadcastToRoom(roomId, { type: "state", roomId, players: room.players });
                    
                    // Check if all players are ready to start the game
                    const allReady = Object.values(room.players).every(p => p.ready);
                    if (allReady && !room.running && Object.keys(room.players).length > 0) {
                        startGame(roomId);
                    }
                    break;

                case "input":
                    const playerInput = room.players[playerId];
                    if (playerInput && playerInput.alive) {
                        if (payload.input === 'left') {
                            playerInput.laneTarget = Math.max(0, playerInput.laneTarget - 1);
                        } else if (payload.input === 'right') {
                            playerInput.laneTarget = Math.min(LANE_X.length - 1, playerInput.laneTarget + 1);
                        }
                    }
                    break;
            }

        } catch (e) {
            console.error("Failed to process message:", msg, e);
        }
    });

    ws.on("close", () => {
        console.log("Player disconnected");
        const { roomId, playerId } = ws;

        if (roomId && playerId && rooms[roomId]) {
            console.log(`Player ${playerId} leaving room ${roomId}`);
            delete rooms[roomId].players[playerId];

            const room = rooms[roomId];
            if (Object.keys(room.players).length === 0) {
                console.log(`Room ${roomId} is empty, stopping game and deleting.`);
                stopGame(roomId);
                delete rooms[roomId];
            } else {
                broadcastToRoom(roomId, {
                    type: "state",
                    roomId,
                    players: room.players,
                });
            }
        }
    });
});
