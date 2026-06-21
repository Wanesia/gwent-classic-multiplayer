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

const MAX_CLIENTS = 400;
const MAX_PER_IP = 10;
const ROOM_TTL_MS = 30 * 60 * 1000;
const MSG_RATE = 25;
const MSG_BURST = 50;
const MAX_BUFFER = 1024 * 1024;
const VALID_EVENTS = new Set(["mode-sp", "mode-mp", "sp-game-started", "sp-game-finished", "mp-game-completed"]);
const EVENT_MAX_PER_IP = 60;
const EVENT_MAX_IPS = 5000;
const EVENT_WINDOW_MS = 60 * 1000;

const ipCounts = new Map();
let lastOverloadLog = 0;
let refusedSinceLog = 0;
let eventHits = new Map();

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
		const ip = clientIp(req);
		const hits = eventHits.get(ip) || 0;
		if (hits >= EVENT_MAX_PER_IP || (hits === 0 && eventHits.size >= EVENT_MAX_IPS)) {
			res.writeHead(429);
			res.end();
			return;
		}
		eventHits.set(ip, hits + 1);
		let body = "";
		let aborted = false;
		req.on("data", chunk => {
			if (aborted) return;
			body += chunk;
			if (body.length > 256) {
				aborted = true;
				req.destroy();
			}
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				const { type } = JSON.parse(body);
				if (VALID_EVENTS.has(type))
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

const wss = new WebSocketServer({
	server,
	maxPayload: 32 * 1024,
	perMessageDeflate: false
});

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
	if (ws && ws.readyState === ws.OPEN) {
		if (ws.bufferedAmount > MAX_BUFFER) {
			ws.terminate();
			return;
		}
		ws.send(JSON.stringify(obj));
	}
}

function peerOf(ws) {
	const room = rooms.get(ws.room);
	if (!room)
		return null;
	return room.host === ws ? room.guest : room.host;
}

function clientIp(req) {
	const xff = req.headers["x-forwarded-for"];
	if (xff) {
		const parts = xff.split(",");
		return parts[parts.length - 1].trim();
	}
	return req.socket.remoteAddress || "?";
}

function allowMessage(ws) {
	const now = Date.now();
	ws.tokens = Math.min(MSG_BURST, ws.tokens + (now - ws.lastRefill) / 1000 * MSG_RATE);
	ws.lastRefill = now;
	if (ws.tokens < 1)
		return false;
	ws.tokens -= 1;
	return true;
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

wss.on("connection", (ws, req) => {
	if (wss.clients.size > MAX_CLIENTS) {
		refusedSinceLog++;
		const now = Date.now();
		if (now - lastOverloadLog > 60000) {
			log("overloaded", { clients: wss.clients.size, refused: refusedSinceLog });
			lastOverloadLog = now;
			refusedSinceLog = 0;
		}
		ws.close(1013, "overloaded");
		return;
	}
	const ip = clientIp(req);
	if ((ipCounts.get(ip) || 0) >= MAX_PER_IP) {
		ws.close(1013, "too-many");
		return;
	}
	ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
	ws.ip = ip;
	ws.isAlive = true;
	ws.room = null;
	ws.tokens = MSG_BURST;
	ws.lastRefill = Date.now();
	ws.on("pong", () => ws.isAlive = true);

	ws.on("message", raw => {
		if (!allowMessage(ws))
			return ws.close(1008, "rate");
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
				rooms.set(code, { code: code, host: ws, guest: null, startedAt: null, createdAt: Date.now(), messages: 0 });
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

	ws.on("close", () => {
		const n = (ipCounts.get(ws.ip) || 1) - 1;
		if (n <= 0)
			ipCounts.delete(ws.ip);
		else
			ipCounts.set(ws.ip, n);
		destroyRoom(ws, true, "disconnect");
	});
});

// Reap dead connections (browsers answer pings automatically)
setInterval(() => {
	const now = Date.now();
	const stale = [];
	for (const room of rooms.values())
		if (!room.startedAt && now - room.createdAt > ROOM_TTL_MS)
			stale.push(room);
	for (const room of stale) {
		const host = room.host;
		destroyRoom(host, false, "idle-timeout");
		if (host)
			host.close(1013, "idle");
	}
	for (const ws of wss.clients) {
		if (!ws.isAlive) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		ws.ping();
	}
}, 30000);

setInterval(() => { eventHits = new Map(); }, EVENT_WINDOW_MS);

server.listen(PORT, () => log("server-start", { port: PORT }));
