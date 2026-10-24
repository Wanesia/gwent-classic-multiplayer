"use strict"

// Online multiplayer session. Both clients run the full game engine in
// lockstep: only player decisions travel over the wire. The local player's
// choices are captured at the UI hooks in gwent.js and sent as they happen;
// the remote player is represented by a ControllerRemote that awaits those
// messages and replays them through the same code paths the UI uses.
//
// Wire messages (perspective-neutral; players/rows referenced as host/guest):
//   {t:"lobby-ready", deck, chat, chatQuick, chatText} ready-up (lobby.js)
//   {t:"lobby-unready"}
//   {t:"lobby-start", seed} {t:"lobby-start-ack"}      host-driven match start
//   {t:"pick", i} {t:"pickEnd"}                        any synced carousel
//   {t:"first", who}                                   Scoia'tael go-first choice
//   {t:"play", i, d} {t:"scorch", i} {t:"pass"}        turn actions
//   {t:"decoy", i, d, j} {t:"leader"}
//   {t:"row", d}                                       mid-resolution row choice
//   {t:"sum", h}                                       per-turn state checksum
//   {t:"desync"}                                       the sender found a mismatch and left
//   {t:"afk-pass"}                                     asks the AFK player to pass (AfkClock)
//   {t:"chat", q} {t:"chat-text", s}                   chat (chat.js): these and any other
//   {t:"chat-state", quick, text}                      "chat-" type bypass the lockstep

// Hand replica for the remote human player. Mirrors the local Hand's array
// semantics exactly (sorted insert, or splice at an explicit index during
// redraw swaps) so that hand indices sent over the wire match, while using
// HandAI's hidden DOM element for card animations.
class HandRemote extends HandAI {
	addCard(card, index) {
		if (!card)
			return;
		if (!index)
			this.addCardSorted(card);
		else
			this.cards.splice(clamp(0, this.cards.length, index), 0, card);
		this.resize();
	}
}

// Replays the remote player's turn actions as they arrive over the wire.
// Satisfies the same contract as ControllerAI from the game loop's view.
class ControllerRemote {
	constructor(player) {
		this.player = player;
	}

	// Redraw is replicated through the synced carousel barrier in
	// Game.initialRedraw, not through the controller
	redraw() {}

	async startTurn(player) {
		const m = await mp.next(mp.roleOf(player), "play", "scorch", "decoy", "pass", "leader");
		AfkClock.stop();
		const desync = () => { mp.desync(); return new Promise(() => {}); };
		const validCard = Number.isInteger(m.i) && m.i >= 0 && m.i < player.hand.cards.length;
		switch (m.t) {
			case "pass":
				player.passRound();
				break;
			case "leader":
				if (!player.leaderAvailable)
					return desync();
				await player.activateLeader();
				break;
			case "scorch":
				if (!validCard || player.hand.cards[m.i].name !== "Scorch")
					return desync();
				await player.playScorch(player.hand.cards[m.i]);
				break;
			case "play": {
				const row = mp.destFromWire(m.d);
				if (!validCard || !row)
					return desync();
				const card = player.hand.cards[m.i];
				if (card.name === "Scorch" || card.name === "Decoy" || !mp.legalDests(card, player).includes(row))
					return desync();
				await player.playCardToRow(card, row);
				break;
			}
			case "decoy": {
				const row = mp.destFromWire(m.d);
				if (!validCard || !row || !Number.isInteger(m.j) || m.j < 0 || m.j >= row.cards.length)
					return desync();
				// mirrors the execution order of the sender's ui.selectCard
				const card = player.hand.cards[m.i];
				const target = row.cards[m.j];
				if (card.name !== "Decoy" || !mp.legalDests(card, player).includes(row) || !target.isUnit())
					return desync();
				board.toHand(target, row);
				await board.moveTo(card, row, player.hand);
				player.endTurn();
				break;
			}
		}
	}
}

class MPSession {
	constructor() {
		this.active = false;
		this.role = null; // "host" | "guest"
		this.queue = [];
		this.waiter = null;
		// Set while a recorded match is played back (replay.js): every human
		// player's choices then come from the recording instead of the wire
		this.replay = null;
	}

	// Game logic runs the online code paths: a live online match, or the replay
	// of one
	get lockstep() {
		return this.active || !!(this.replay && this.replay.online);
	}

	// A match whose remote choices are still being fed (online or replay)
	get live() {
		return this.active || !!this.replay;
	}

	activate(role) {
		this.active = true;
		this.role = role;
		this.queue = [];
		this.waiter = null;
		QuickChat.reset();
	}

	deactivate() {
		this.active = false;
		this.role = null;
		this.queue = [];
		const w = this.waiter;
		this.waiter = null;
		if (w)
			w();
		AfkClock.stop();
		ChatLog.clear();
		QuickChat.refresh();
	}

	// A choice of the local player: recorded for the match history, and sent to
	// the opponent in online games
	send(msg) {
		if (msg.t !== "sum")
			MatchLog.add(this.localRole(), msg);
		if (this.active)
			Net.send(msg);
	}

	// Inbound game messages from Net while a match is active. Lobby messages
	// (e.g. the opponent readying up again while we are still on the end
	// screen) are forwarded so they are not swallowed by the game queue.
	route(msg) {
		// The peer is untrusted: anything that isn't a well-formed message is
		// treated as a desync instead of crashing the game loop
		if (!msg || typeof msg !== "object" || typeof msg.t !== "string")
			return this.desync();
		if (msg.t.startsWith("lobby-"))
			return lobby.routeLobby(msg);
		if (msg.t === "chat" || msg.t.startsWith("chat-"))
			return QuickChat.route(msg);
		// The peer found a mismatch: end here too, so both record a desync
		// rather than one side a walkover
		if (msg.t === "desync")
			return this.desync();
		// Outside the lockstep: what the AFK player does about it is their move
		if (msg.t === "afk-pass")
			return AfkClock.request();
		this.queue.push(msg);
		const w = this.waiter;
		if (w) {
			this.waiter = null;
			w();
		}
	}

	// Awaits the next choice of the player with the given role, as one of the
	// given types. Online there is a single remote player and the role is only
	// used for recording. Receiving any other type means the two simulations no
	// longer agree on whose choice is pending - treated as a desync.
	async next(role, ...types) {
		if (this.replay)
			return this.replay.next(role, types);
		while (this.active) {
			if (this.queue.length > 0) {
				const m = this.queue.shift();
				if (types.includes(m.t)) {
					if (m.t !== "sum")
						MatchLog.add(role, m);
					return m;
				}
				console.error("Unexpected message", m, "expected", types);
				this.desync();
				break;
			}
			if (this.waiter)
				throw new Error("Concurrent mp.next consumers");
			await new Promise(res => this.waiter = res);
		}
		// session torn down while waiting; suspend this dead game branch forever
		return new Promise(() => {});
	}

	// ---- perspective translation ----

	otherRole(role) {
		return role === "host" ? "guest" : "host";
	}

	localRole() {
		return this.active ? this.role : this.replay ? this.replay.localRole : "host";
	}

	// Role of the player with the given Player.id (0 = local)
	roleOfId(id) {
		return id === 0 ? this.localRole() : this.otherRole(this.localRole());
	}

	roleOf(player) {
		return player === player_me ? this.localRole() : this.otherRole(this.localRole());
	}

	playerOf(role) {
		return role === this.localRole() ? player_me : player_op;
	}

	isRemote(player) {
		return this.live && !!player && player.controller instanceof ControllerRemote;
	}

	// Destinations the player may legally play the card to, mirroring
	// UI.setSelectable from that player's side of the board
	legalDests(card, player) {
		if (card.faction === "weather")
			return [weather];
		const own = board.playerRows(player);
		if (card.isSpecial())
			return own.filter(r => r.special === null);
		if (card.name === "Decoy")
			return own.filter(r => r.cards.some(c => c.isUnit()));
		if (card.row === "agile")
			return [board.getRow(card, "close", player), board.getRow(card, "ranged", player)];
		return [board.getRow(card, card.row, player)];
	}

	// Row|Weather -> wire reference
	destToWire(dest) {
		if (dest === weather)
			return "weather";
		const owner = board.row.indexOf(dest) < 3 ? player_op : player_me;
		return { o: this.roleOf(owner), r: dest.type };
	}

	destFromWire(d) {
		if (d === "weather")
			return weather;
		if (!d || typeof d !== "object")
			return null;
		const isMe = this.playerOf(d.o) === player_me;
		const index = { close: isMe ? 3 : 2, ranged: isMe ? 4 : 1, siege: isMe ? 5 : 0 }[d.r];
		return board.row[index] || null;
	}

	// ---- match start ----

	// Both decks are raw {faction, leader, cards:[[index,count]]} objects as
	// produced by DeckMaker.deckToJSON / received from the peer's ready message
	startMatch(seed, localRaw, remoteRaw) {
		this.activate(Net.role);
		Net.onMessage = m => this.route(m);

		const meDeck = this.deckFromRaw(localRaw);
		const opDeck = this.deckFromRaw(remoteRaw);
		if (!meDeck || !opDeck) {
			this.deactivate();
			lobby.matchFailed(I18N.t("lobby.deckValidationFailed"));
			return;
		}
		GameRNG.reset(seed);
		player_me = new Player(0, I18N.t("game.you"), meDeck);
		player_op = new Player(1, I18N.t("game.opponent"), opDeck, true);
		dm.elem.classList.add("hide");
		game.startGame();
	}

	deckFromRaw(raw) {
		try {
			const checked = dm.loadDeck(raw, true, true);
			if (!checked)
				return null;
			return { faction: checked.faction, leader: card_dict[checked.leader], cards: checked.cards };
		} catch (e) {
			return null;
		}
	}

	// ---- desync safety net ----

	// Cheap state fingerprint exchanged after every turn. Hands are included in
	// order (actions reference hand indices); graves are compared as a sorted
	// name list, since cards scorched together can land in either order.
	checksum() {
		const parts = [];
		for (const role of ["host", "guest"]) {
			const p = this.playerOf(role);
			parts.push(p.total, p.health, p.passed ? 1 : 0, p.hand.cards.length, p.deck.cards.length);
			parts.push(p.hand.cards.map(c => c.name).join("|"));
			parts.push(p.grave.cards.map(c => c.name).sort().join("|"));
			for (const row of board.playerRows(p))
				parts.push(row.total, row.cards.length, row.special ? 1 : 0);
		}
		parts.push(weather.cards.length, game.roundCount);
		const s = parts.join(",");
		let h = 2166136261 >>> 0;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619) >>> 0;
		}
		return h.toString(16);
	}

	desync() {
		if (this.replay)
			return this.replay.diverged();
		if (!this.active)
			return;
		Net.send({t: "desync"});
		this.deactivate();
		lobby.endMultiplayerGame(I18N.t("lobby.desyncTitle"), I18N.t("lobby.desyncBody"), "desync");
	}
}

var mp = new MPSession();

// AFK turns online. A turn that runs past TURN_MS tells both players so, and
// the waiting player may then ask the AFK one to pass the round. Only the AFK
// player's own client passes, and only once its own clock has run out too: the
// pass travels as their normal move, so nobody can pass for someone else.
var AfkClock = {
	TURN_MS: 60000,
	BANNER_MS: 2500,
	timer: null,
	side: null, // "me" | "op": whose turn is being timed
	expired: false,
	requested: false, // the opponent asked us to pass; done once our time is up

	// An online player's turn starts. Only timed when the opponent's client
	// understands pass requests: otherwise the warning would promise one.
	start(player) {
		this.stop();
		if (!mp.active || !lobby.peerAfk)
			return;
		this.side = player.tag;
		this.timer = setTimeout(() => this.expire(), this.TURN_MS);
	},

	// The timed player acted, or the turn or match ended
	stop() {
		clearTimeout(this.timer);
		this.timer = null;
		this.side = null;
		this.expired = false;
		this.requested = false;
		document.getElementById("afk-me").classList.add("hide");
		document.getElementById("afk-op").classList.add("hide");
	},

	expire() {
		this.expired = true;
		document.getElementById("afk-" + this.side).classList.remove("hide");
		if (this.side === "me" && this.requested)
			return this.passNow();
		this.banner(this.side);
	},

	// Both players get one. Shown even with game messages off, and only once the
	// player can see it: a hidden tab gets it on their return.
	async banner(side) {
		if (document.hidden)
			await new Promise(res => document.addEventListener("visibilitychange", res, { once: true }));
		if (this.side !== side || !this.expired)
			return;
		const name = side + "-afk";
		await ui.showNotification(name);
		await sleep(this.BANNER_MS);
		// Another notification (e.g. the pass) may have taken the bar meanwhile
		if (ui.notif_elem.children[0].id === "notif-" + name)
			await ui.hideNotification();
	},

	// The waiting player clicked "Pass the round for them"
	ask() {
		if (this.side !== "op" || !this.expired)
			return;
		Net.send({t: "afk-pass"});
		document.getElementById("afk-op").classList.add("hide");
	},

	// The opponent asked us to pass. Their clock may run slightly ahead of ours.
	request() {
		if (this.side !== "me")
			return;
		this.requested = true;
		if (this.expired)
			this.passNow();
	},

	// Exactly what the Pass button does, after closing anything left open
	passNow() {
		if (!player_me.takeAction())
			return;
		Carousel.curr?.cancel();
		if (ui.previewCard)
			ui.cancel();
		mp.send({t: "pass"});
		player_me.passRound();
		AudioManager.playSFX('pass');
	},
};
