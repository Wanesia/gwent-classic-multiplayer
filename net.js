"use strict"

// Client networking for online multiplayer. Wraps a WebSocket connection to
// the relay server (server/server.js), which pairs two players by room code
// and forwards "msg" frames between them verbatim, in order.
var Net = {
	DEFAULT_URL: "wss://gwent-classic-multiplayer.duckdns.org",

	socket: null,
	connected: false,
	role: null, // "host" | "guest" | null
	code: null,
	pending: null, // resolver of the in-flight create/join request

	onMessage: null, // cb(data) - game/lobby payloads from the peer
	onPeerJoined: null, // cb() - a guest joined our room
	onPeerLeft: null, // cb() - peer left, room destroyed, or relay connection lost

	serverURL() {
		const param = new URLSearchParams(window.location.search).get("server");
		return param || localStorage?.getItem("gc-server-url") || this.DEFAULT_URL;
	},

	connect(url) {
		if (this.connected)
			return Promise.resolve();
		return new Promise((resolve, reject) => {
			let socket;
			try {
				socket = new WebSocket(url || this.serverURL());
			} catch (e) {
				return reject(new Error("unreachable"));
			}
			socket.onopen = () => {
				this.socket = socket;
				this.connected = true;
				resolve();
			};
			socket.onerror = () => {
				if (!this.connected)
					reject(new Error("unreachable"));
			};
			socket.onclose = () => this.handleClose();
			socket.onmessage = e => this.route(e.data);
		});
	},

	createRoom() {
		return new Promise((resolve, reject) => {
			this.pending = { resolve: resolve, reject: reject };
			this.sendRaw({ type: "create" });
		});
	},

	joinRoom(code) {
		return new Promise((resolve, reject) => {
			this.pending = { resolve: resolve, reject: reject };
			this.sendRaw({ type: "join", code: code });
		});
	},

	// Sends a payload to the peer through the relay
	send(data) {
		this.sendRaw({ type: "msg", data: data });
	},

	sendRaw(obj) {
		if (this.connected)
			this.socket.send(JSON.stringify(obj));
	},

	leave() {
		this.sendRaw({ type: "leave" });
		this.code = null;
		this.role = null;
	},

	route(raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch (e) {
			return;
		}
		switch (msg.type) {
			case "created":
				this.code = msg.code;
				this.role = "host";
				this.settle(null, msg.code);
				break;
			case "joined":
				this.code = msg.code;
				this.role = "guest";
				this.settle(null, msg.code);
				break;
			case "error":
				if (this.pending)
					this.settle(new Error(msg.code));
				break;
			case "msg":
				if (this.onMessage)
					this.onMessage(msg.data);
				break;
			case "peer-joined":
				if (this.onPeerJoined)
					this.onPeerJoined();
				break;
			case "peer-left":
				this.code = null;
				this.role = null;
				if (this.onPeerLeft)
					this.onPeerLeft();
				break;
		}
	},

	settle(err, val) {
		const p = this.pending;
		if (!p)
			return;
		this.pending = null;
		if (err)
			p.reject(err);
		else
			p.resolve(val);
	},

	// Losing the relay connection mid-room is equivalent to the peer leaving:
	// the match cannot continue either way.
	handleClose() {
		const wasInRoom = this.code !== null;
		this.socket = null;
		this.connected = false;
		this.code = null;
		this.role = null;
		if (this.pending)
			this.settle(new Error("unreachable"));
		else if (wasInRoom && this.onPeerLeft)
			this.onPeerLeft();
	}
};
