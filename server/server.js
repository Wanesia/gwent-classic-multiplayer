"use strict"

// Relay server for gwent-classic online multiplayer.
// Pairs two clients by a short room code and forwards "msg" frames between
// them verbatim. Holds no game logic and no persistent state; a room dies as
// soon as either side leaves or disconnects.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8765;
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L
const CODE_LENGTH = 5;

const rooms = new Map(); // code -> {host, guest, startedAt, messages}

const server = http.createServer((req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	if (req.method === "OPTIONS") {
		res.setHeader("Access-Control-Allow-Methods", "POST");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		res.writeHead(204);
		res.end();
		return;
	}
	if (req.method === "POST" && req.url === "/event") {
		let body = "";
		req.on("data", chunk => { body += chunk; if (body.length > 256) body = ""; });
		req.on("end", () => {
			try {
				const { type } = JSON.parse(body);
				if (type && typeof type === "string" && type.length <= 32)
					log(type);
			} catch (_) {}
			res.writeHead(204);
			res.end();
		});
		return;
	}
	res.writeHead(404);
	res.end();
});

const wss = new WebSocketServer({ server });

function log(event, fields = {}) {
	const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("  ");
	console.log(`[${new Date().toISOString()}] ${event.padEnd(14)} ${parts}`);
}

function makeCode() {
	let code;
	do {
		code = "";
		for (let i = 0; i < CODE_LENGTH; i++)
			code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
	} while (rooms.has(code));
	return code;
}

function send(ws, obj) {
	if (ws && ws.readyState === ws.OPEN)
		ws.send(JSON.stringify(obj));
}

function peerOf(ws) {
	const room = rooms.get(ws.room);
	if (!room)
		return null;
	return room.host === ws ? room.guest : room.host;
}

function destroyRoom(ws, notifyPeer, reason) {
	const room = rooms.get(ws.room);
	ws.room = null;
	if (!room)
		return;
	rooms.delete(room.code);
	const peer = room.host === ws ? room.guest : room.host;
	if (peer) {
		peer.room = null;
		if (notifyPeer)
			send(peer, { type: "peer-left" });
	}
	if (room.startedAt) {
		const mins = Math.round((Date.now() - room.startedAt) / 60000);
		log("game-ended", { code: room.code, messages: room.messages, duration: `${mins}m`, reason });
	} else {
		log("room-closed", { code: room.code, reason });
	}
}

wss.on("connection", ws => {
	ws.isAlive = true;
	ws.room = null;
	ws.on("pong", () => ws.isAlive = true);

	ws.on("message", raw => {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch (e) {
			return send(ws, { type: "error", code: "bad-request" });
		}
		switch (msg.type) {
			case "create": {
				if (ws.room)
					return send(ws, { type: "error", code: "already-in-room" });
				const code = makeCode();
				rooms.set(code, { code: code, host: ws, guest: null, startedAt: null, messages: 0 });
				ws.room = code;
				send(ws, { type: "created", code: code });
				log("room-created", { code });
				break;
			}
			case "join": {
				if (ws.room)
					return send(ws, { type: "error", code: "already-in-room" });
				const code = String(msg.code || "").trim().toUpperCase();
				const room = rooms.get(code);
				if (!room)
					return send(ws, { type: "error", code: "not-found" });
				if (room.guest)
					return send(ws, { type: "error", code: "full" });
				room.guest = ws;
				room.startedAt = Date.now();
				ws.room = code;
				send(ws, { type: "joined", code: code });
				send(room.host, { type: "peer-joined" });
				log("game-started", { code });
				break;
			}
			case "msg": {
				const peer = peerOf(ws);
				if (!peer)
					return send(ws, { type: "error", code: "no-peer" });
				send(peer, { type: "msg", data: msg.data });
				const room = rooms.get(ws.room);
				if (room) room.messages++;
				break;
			}
			case "leave":
				destroyRoom(ws, true, "leave");
				break;
			default:
				send(ws, { type: "error", code: "bad-request" });
		}
	});

	ws.on("close", () => destroyRoom(ws, true, "disconnect"));
});

// Reap dead connections (browsers answer pings automatically)
setInterval(() => {
	for (const ws of wss.clients) {
		if (!ws.isAlive) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		ws.ping();
	}
}, 30000);

server.listen(PORT, () => log("server-start", { port: PORT }));
