"use strict"

// Relay server for gwent-classic online multiplayer.
// Pairs two clients by a short room code — or automatically via quickmatch —
// and forwards "msg" frames between them verbatim. Holds no game logic; a room
// dies as soon as either side leaves or disconnects. The only thing kept on
// disk is anonymous daily totals (see "Player counts" below).

const fs = require("fs");
const http = require("http");
const path = require("path");
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
const VALID_EVENTS = new Set(["mode-sp", "mode-mp", "mode-qm", "sp-game-started", "sp-game-finished", "mp-game-completed"]);
const PRESENCE_EVENTS = new Set(["visit", "here"]); // counted, not logged: one per player every 5 minutes
const EVENT_MAX_PER_IP = 60;
const EVENT_MAX_IPS = 5000;
const EVENT_WINDOW_MS = 60 * 1000;
const ALLOWED_ORIGINS = new Set(["https://gwent-classic-multiplayer.pages.dev"]);

// Local development pages (any port). Parsed rather than prefix-matched:
// "http://localhost.evil.example" must not pass.
function isLocalOrigin(origin) {
	try {
		const url = new URL(origin);
		return url.protocol === "http:" && url.hostname === "localhost";
	} catch (e) {
		return false;
	}
}

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
				const event = JSON.parse(body);
				if (VALID_EVENTS.has(event.type))
					log(event.type);
				else if (PRESENCE_EVENTS.has(event.type))
					countPresence(event);
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
	perMessageDeflate: false,
	verifyClient: ({ origin }, cb) => {
		const ok = !origin || isLocalOrigin(origin) || ALLOWED_ORIGINS.has(origin);
		cb(ok, 403, "forbidden");
	}
});

function log(event, fields = {}) {
	const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("  ");
	console.log(`[${new Date().toISOString()}] ${event.padEnd(14)} ${parts}`);
	if (event !== "server-start")
		countEvent(fields.mode ? `${event}-${fields.mode}` : event);
}

// Player counts. Clients never send an ID: each browser remembers which UTC
// day, ISO week and month it last reported (stats.js) and flags a visit as its
// first of each. Adding the flags up gives players per day, week and month.
// Heartbeats ("here", one per open game every 5 minutes) give players online
// at once. Only daily totals are kept, in STATS_FILE; the report is
// scripts/player-stats.js.
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, "stats.json");
const ONLINE_WINDOW_MS = 5 * 60 * 1000; // must match the client heartbeat
const STATS_SAVE_MS = 60 * 1000;

const stats = loadStats();
let statsDirty = false;
let onlineWindow = Math.floor(Date.now() / ONLINE_WINDOW_MS);
let onlineCount = 0;

function loadStats() {
	try {
		const data = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
		if (data && typeof data.days === "object")
			return data;
	} catch (e) {
		if (e.code === "ENOENT")
			return { days: {}, now: null };
	}
	// Unreadable: keep it for a look by hand rather than overwrite it
	const aside = `${STATS_FILE}.bad-${Date.now()}`;
	try { fs.renameSync(STATS_FILE, aside); } catch (_) {}
	console.error(`stats file unreadable, moved to ${aside}`);
	return { days: {}, now: null };
}

function saveStats() {
	if (!statsDirty)
		return;
	const tmp = STATS_FILE + ".tmp";
	try {
		fs.writeFileSync(tmp, JSON.stringify(stats));
		fs.renameSync(tmp, STATS_FILE);
		statsDirty = false;
	} catch (e) {
		console.error("saving stats failed:", e.message);
	}
}

function dayStats(time = Date.now()) {
	const day = new Date(time).toISOString().slice(0, 10);
	statsDirty = true;
	return stats.days[day] ||= {
		visits: 0, // page loads
		players: 0, // browsers seen for the first time this day
		weekFirsts: 0, // ... this ISO week; summed over a week = players that week
		monthFirsts: 0, // ... this month; summed over a month = players that month
		newPlayers: 0, // browsers with nothing of ours stored yet
		noStorage: 0, // visits from browsers that can't remember anything (counted in visits only)
		peakOnline: 0, // most heartbeats in one 5-minute window
		onlineByHour: new Array(24).fill(0), // the same, per UTC hour
		peakSockets: 0, // most relay connections at once (online lobby + matches)
		peakGames: 0, // most online matches at once
		events: {},
	};
}

function countEvent(name) {
	const events = dayStats().events;
	events[name] = (events[name] || 0) + 1;
}

function countPresence(event) {
	rollOnlineWindow();
	onlineCount++;
	if (event.type !== "visit")
		return;
	const day = dayStats();
	day.visits++;
	if (event.day === undefined)
		day.noStorage++;
	if (event.day === true) day.players++;
	if (event.week === true) day.weekFirsts++;
	if (event.month === true) day.monthFirsts++;
	if (event.first === true) day.newPlayers++;
}

// A window's count is only complete once it has ended, so it's recorded then
function rollOnlineWindow() {
	const current = Math.floor(Date.now() / ONLINE_WINDOW_MS);
	if (current === onlineWindow)
		return;
	const start = onlineWindow * ONLINE_WINDOW_MS;
	const day = dayStats(start);
	const hour = new Date(start).getUTCHours();
	day.peakOnline = Math.max(day.peakOnline, onlineCount);
	day.onlineByHour[hour] = Math.max(day.onlineByHour[hour], onlineCount);
	// The window right after it ended is empty only if nobody played
	stats.now = { online: current === onlineWindow + 1 ? onlineCount : 0, at: new Date(start + ONLINE_WINDOW_MS).toISOString() };
	onlineWindow = current;
	onlineCount = 0;
}

function sampleRelay() {
	const day = dayStats();
	let games = 0;
	for (const room of rooms.values())
		if (room.startedAt)
			games++;
	day.peakSockets = Math.max(day.peakSockets, wss.clients.size);
	day.peakGames = Math.max(day.peakGames, games);
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
	sampleRelay();
	ws.ip = ip;
	ws.isAlive = true;
	ws.room = null;
	ws.tokens = MSG_BURST;
	ws.lastRefill = Date.now();
	ws.on("pong", () => ws.isAlive = true);
	// Oversized or invalid-UTF-8 frames surface as 'error'; unhandled, it
	// would crash the whole process.
	ws.on("error", () => ws.terminate());

	ws.on("message", raw => {
		if (!allowMessage(ws))
			return ws.close(1008, "rate");
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch (e) {
			return send(ws, { type: "error", code: "bad-request" });
		}
		if (!msg || typeof msg !== "object" || Array.isArray(msg))
			return send(ws, { type: "error", code: "bad-request" });
		switch (msg.type) {
			case "create": {
				if (ws.room)
					return send(ws, { type: "error", code: "already-in-room" });
				const code = makeCode();
				rooms.set(code, { code: code, host: ws, guest: null, quickmatch: false, startedAt: null, createdAt: Date.now(), messages: 0 });
				ws.room = code;
				send(ws, { type: "created", code: code });
				log("room-created", { code });
				break;
			}
			case "quickmatch": {
				if (ws.room)
					return send(ws, { type: "error", code: "already-in-room" });
				// Pair with the searcher who has been waiting the longest, if any.
				// Skip hosts whose socket is closing but not yet reaped.
				let match = null;
				for (const room of rooms.values())
					if (room.quickmatch && !room.guest && room.host.readyState === room.host.OPEN &&
							(!match || room.createdAt < match.createdAt))
						match = room;
				if (match) {
					match.guest = ws;
					match.startedAt = Date.now();
					ws.room = match.code;
					send(ws, { type: "joined", code: match.code });
					send(match.host, { type: "peer-joined" });
					log("game-started", { code: match.code, mode: "quickmatch" });
					sampleRelay();
				} else {
					const code = makeCode();
					rooms.set(code, { code: code, host: ws, guest: null, quickmatch: true, startedAt: null, createdAt: Date.now(), messages: 0 });
					ws.room = code;
					send(ws, { type: "created", code: code });
					send(ws, { type: "qm-status", online: wss.clients.size });
					log("qm-waiting", { code });
				}
				break;
			}
			case "join": {
				if (ws.room)
					return send(ws, { type: "error", code: "already-in-room" });
				const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
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
				sampleRelay();
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
	for (const room of rooms.values())
		if (room.quickmatch && !room.guest)
			send(room.host, { type: "qm-status", online: wss.clients.size });
}, 30000);

setInterval(() => { eventHits = new Map(); }, EVENT_WINDOW_MS);

setInterval(() => {
	rollOnlineWindow();
	saveStats();
}, STATS_SAVE_MS);

// pm2 stops the process with SIGINT
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		saveStats();
		process.exit(0);
	});

server.listen(PORT, "127.0.0.1", () => log("server-start", { port: PORT }));
