// server.js
// Node.js + ws — servidor autoritativo simples (processa inputs, 30 TPS, envia update_position)
// Instalar dependências: npm i ws uuid

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 9090;
const wss = new WebSocket.Server({ port: PORT });

console.log("Server listening on port", PORT);

const TICK_RATE = 30; // ticks por segundo
const TICK_DT = 1.0 / TICK_RATE;

const SPEED = 200; // pixels por segundo (ajuste conforme seu jogo)
const PLAYER_FRICTION = 0.9;

let players = {}; // uuid -> { ws, x,y,vx,vy,hp, inputs: [], last_seq_processed: 0, last_ping: Date.now() }

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const id in players) {
    const p = players[id];
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

wss.on("connection", (ws) => {
  const id = uuidv4();
  console.log("Client connected:", id);

  // create player state
  players[id] = {
    ws: ws,
    x: Math.random() * 400 + 100,
    y: Math.random() * 400 + 100,
    vx: 0,
    vy: 0,
    hp: 100,
    inputs: [], // queue of inputs
    last_seq_processed: 0,
    last_recv_time: Date.now()
  };

  // send joined + spawn_local_player for this client
  ws.send(JSON.stringify({ cmd: "joined_server", content: { uuid: id } }));
  ws.send(JSON.stringify({ cmd: "spawn_local_player", content: { uuid: id, x: players[id].x, y: players[id].y } }));

  // notify others of new player
  const newP = { uuid: id, x: players[id].x, y: players[id].y, hp: players[id].hp };
  for (const otherId in players) {
    if (otherId !== id && players[otherId].ws.readyState === WebSocket.OPEN) {
      players[otherId].ws.send(JSON.stringify({ cmd: "spawn_new_player", content: { player: newP } }));
    }
  }

  // send existing players to this new client
  const snapshot = [];
  for (const otherId in players) {
    if (otherId !== id) {
      const p = players[otherId];
      snapshot.push({ uuid: otherId, x: p.x, y: p.y, hp: p.hp });
    }
  }
  ws.send(JSON.stringify({ cmd: "spawn_network_players", content: { players: snapshot } }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Bad JSON:", e);
      return;
    }
    const cmd = msg.cmd;
    const content = msg.content || {};

    // Accept player_input: content { uuid, seq, inputs: [{seq,t,dx,dy,actions}] }
    if (cmd === "player_input") {
      const uuid = content.uuid;
      if (!players[uuid]) return;
      players[uuid].last_recv_time = Date.now();
      const arr = content.inputs || [];
      for (const ip of arr) {
        // basic validation: ensure dx/dy exist and are numbers
        const dx = Number(ip.dx) || 0;
        const dy = Number(ip.dy) || 0;
        const seq = Number(ip.seq) || 0;
        players[uuid].inputs.push({ seq: seq, t: ip.t || Date.now(), dx: dx, dy: dy, actions: ip.actions || {} });
      }
    }

    // chat passthru
    if (cmd === "chat") {
      const chat = { cmd: "new_chat_message", content: { msg: content.msg || "" } };
      broadcast(chat);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected:", id);
    delete players[id];
    broadcast({ cmd: "player_disconnected", content: { uuid: id } });
  });
});

// Game tick loop: apply inputs, integrate, broadcast positions (authoritative)
setInterval(() => {
  // process inputs
  for (const id in players) {
    const p = players[id];
    // process all queued inputs in order
    while (p.inputs.length > 0) {
      const ip = p.inputs.shift();
      // clamp dx/dy to -1..1
      const dx = Math.max(-1, Math.min(1, Number(ip.dx) || 0));
      const dy = Math.max(-1, Math.min(1, Number(ip.dy) || 0));
      // apply velocity (simple instant velocity model)
      p.vx = dx * SPEED;
      p.vy = dy * SPEED;
      // integrate small dt
      p.x += p.vx * TICK_DT;
      p.y += p.vy * TICK_DT;
      // record that we've processed this seq
      p.last_seq_processed = ip.seq || p.last_seq_processed;
    }

    // friction fallback
    p.vx *= PLAYER_FRICTION;
    p.vy *= PLAYER_FRICTION;
  }

  // build broadcast snapshot (you can optimize to send only neighbors)
  for (const id in players) {
    const p = players[id];
    // send per-player update with seq_ack for owner
    const update = { cmd: "update_position", content: { uuid: id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, hp: p.hp, seq_ack: p.last_seq_processed, t: Date.now() } };

    // Broadcast update to everyone
    for (const otherId in players) {
      const other = players[otherId];
      if (other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(JSON.stringify(update));
      }
    }
  }
}, 1000 / TICK_RATE);
