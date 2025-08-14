// server.js
// Node + ws minimal input-based authoritative server
// npm i ws uuid
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 9090;
const wss = new WebSocket.Server({ port: PORT });

console.log("Server listening on port", PORT);

const TICK_RATE = 20; // ticks per second
const DT = 1.0 / TICK_RATE;
const SPEED = 180; // pixels/second
const FRICTION = 0.9;

let players = {}; // uuid -> { ws, x, y, vx, vy, inputs:[], last_seq_processed }

function broadcast(obj) {
  const txt = JSON.stringify(obj);
  for (const id in players) {
    const p = players[id];
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(txt);
    }
  }
}

wss.on("connection", (ws) => {
  const id = uuidv4();
  console.log("connected:", id);
  players[id] = {
    ws,
    x: Math.random() * 400 + 100,
    y: Math.random() * 400 + 100,
    vx: 0,
    vy: 0,
    inputs: [],
    last_seq_processed: 0,
    last_recv_time: Date.now()
  };

  // send joined + spawn local
  ws.send(JSON.stringify({ cmd: "joined_server", content: { uuid: id } }));
  ws.send(JSON.stringify({ cmd: "spawn_local_player", content: { player: { uuid: id, x: players[id].x, y: players[id].y } } }));

  // notify others
  const newP = { uuid: id, x: players[id].x, y: players[id].y };
  for (const otherId in players) {
    if (otherId !== id && players[otherId].ws.readyState === WebSocket.OPEN) {
      players[otherId].ws.send(JSON.stringify({ cmd: "spawn_new_player", content: { player: newP } }));
    }
  }

  // send snapshot of existing players to this new client
  const snapshot = [];
  for (const otherId in players) {
    if (otherId !== id) {
      const p = players[otherId];
      snapshot.push({ uuid: otherId, x: p.x, y: p.y });
    }
  }
  ws.send(JSON.stringify({ cmd: "spawn_network_players", content: { players: snapshot } }));

  ws.on("message", (message) => {
    let data;
    try { data = JSON.parse(message.toString()); } catch(e){ console.warn("bad json", e); return; }
    const cmd = data.cmd;
    const content = data.content || {};
    if (cmd === "player_input") {
      const uuid = content.uuid;
      if (!players[uuid]) return;
      players[uuid].last_recv_time = Date.now();
      const arr = content.inputs || [];
      for (const ip of arr) {
        // validate
        const dx = Number(ip.dx) || 0;
        const dy = Number(ip.dy) || 0;
        const seq = Number(ip.seq) || 0;
        players[uuid].inputs.push({ seq, dx, dy, t: ip.t || Date.now(), actions: ip.actions || {} });
      }
    }
    // other cmds (chat etc) could be handled here
  });

  ws.on("close", () => {
    console.log("disconnected:", id);
    delete players[id];
    broadcast({ cmd: "player_disconnected", content: { uuid: id } });
  });
});

// Game loop
setInterval(() => {
  // process inputs
  for (const id in players) {
    const p = players[id];
    while (p.inputs.length > 0) {
      const ip = p.inputs.shift();
      const dx = Math.max(-1, Math.min(1, Number(ip.dx) || 0));
      const dy = Math.max(-1, Math.min(1, Number(ip.dy) || 0));
      p.vx = dx * SPEED;
      p.vy = dy * SPEED;
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      p.last_seq_processed = ip.seq || p.last_seq_processed;
    }
    // small friction
    p.vx *= FRICTION;
    p.vy *= FRICTION;
  }

  // send snapshot (update_state)
  const players_array = [];
  for (const id in players) {
    const p = players[id];
    players_array.push({ uuid: id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, seq_ack: p.last_seq_processed });
  }
  const snapshot = { cmd: "update_state", content: { players: players_array, t: Date.now() } };
  broadcast(snapshot);
}, 1000 / TICK_RATE);
