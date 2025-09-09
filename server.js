const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000; // Render will inject PORT
const server = app.listen(PORT, () => console.log(`Listening on ${PORT}`));
const wss = new WebSocket.Server({ server });

// store game rooms: { roomId: { players: { playerId: {...data} } } }
let rooms = {};

wss.on("connection", (ws) => {
  console.log("Player connected");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      const { roomId, playerId, action, payload } = data;

      if (!rooms[roomId]) {
        rooms[roomId] = { players: {} };
      }

      if (action === "join") {
        rooms[roomId].players[playerId] = {
          nickname: payload.nickname,
          color: payload.color,
          ready: false,
          alive: true,
          x: 0,
          y: 0,
        };
      }

      if (action === "update") {
        Object.assign(rooms[roomId].players[playerId], payload);
      }

      // broadcast updated room state to everyone in room
      const state = { type: "state", players: rooms[roomId].players };
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ roomId, ...state }));
        }
      });
    } catch (e) {
      console.error("Bad message:", e);
    }
  });

  ws.on("close", () => {
    console.log("Player disconnected");
    // you could clean up players here if you track ws → player mapping
  });
});
