"use strict"

// Online multiplayer session. Both clients run the full game engine in
// lockstep: only player decisions travel over the wire. The local player's
// choices are captured at the UI hooks in gwent.js and sent as they happen;
// the remote player is represented by a ControllerRemote that awaits those
// messages and replays them through the same code paths the UI uses.
//
// Wire messages (perspective-neutral; players/rows referenced as host/guest):
//   {t:"lobby-ready", deck} {t:"lobby-unready"}        ready-up (lobby.js)
//   {t:"lobby-start", seed} {t:"lobby-start-ack"}      host-driven match start
//   {t:"pick", i} {t:"pickEnd"}                        any synced carousel
//   {t:"first", who}                                   Scoia'tael go-first choice
//   {t:"play", i, d} {t:"scorch", i} {t:"pass"}        turn actions
//   {t:"decoy", i, d, j} {t:"leader"}
//   {t:"row", d}                                       mid-resolution row choice

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
		const m = await mp.next("play", "scorch", "decoy", "pass", "leader");
		switch (m.t) {
			case "pass":
				player.passRound();
				break;
			case "leader":
				await player.activateLeader();
				break;
			case "scorch":
				await player.playScorch(player.hand.cards[m.i]);
				break;
			case "play":
				await player.playCardToRow(player.hand.cards[m.i], mp.destFromWire(m.d));
				break;
			case "decoy": {
				// mirrors the execution order of the sender's ui.selectCard
				const card = player.hand.cards[m.i];
				const row = mp.destFromWire(m.d);
				const target = row.cards[m.j];
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
	}

	activate(role) {
		this.active = true;
		this.role = role;
		this.queue = [];
		this.waiter = null;
	}

	deactivate() {
		this.active = false;
		this.role = null;
		this.queue = [];
		const w = this.waiter;
		this.waiter = null;
		if (w)
			w();
	}

	send(msg) {
		if (this.active)
			Net.send(msg);
	}

	route(msg) {
		this.queue.push(msg);
		const w = this.waiter;
		if (w) {
			this.waiter = null;
			w();
		}
	}

	// Awaits the next inbound message of one of the given types. Receiving any
	// other type means the two simulations no longer agree on whose choice is
	// pending - treated as a desync.
	async next(...types) {
		while (this.active) {
			if (this.queue.length > 0) {
				const m = this.queue.shift();
				if (types.includes(m.t))
					return m;
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
		return this.active ? this.role : "host";
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
		return this.active && player && player.controller instanceof ControllerRemote;
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
		const isMe = this.playerOf(d.o) === player_me;
		const index = { close: isMe ? 3 : 2, ranged: isMe ? 4 : 1, siege: isMe ? 5 : 0 }[d.r];
		return board.row[index];
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
			lobby.matchFailed("A deck failed validation. Returning to the deck builder.");
			return;
		}
		GameRNG.reset(seed);
		player_me = new Player(0, "You", meDeck);
		player_op = new Player(1, "Opponent", opDeck, true);
		dm.elem.classList.add("hide");
		game.startGame();
	}

	deckFromRaw(raw) {
		try {
			const checked = dm.loadDeck(raw, true);
			if (!checked)
				return null;
			return { faction: checked.faction, leader: card_dict[checked.leader], cards: checked.cards };
		} catch (e) {
			return null;
		}
	}

	// ---- desync safety net ----

	// Cheap state fingerprint exchanged after every turn. Graves are left out
	// on purpose: the avenger ability prunes its summon from the grave on a
	// wall-clock timer, which could straddle the checksum point on one client.
	checksum() {
		const parts = [];
		for (const role of ["host", "guest"]) {
			const p = this.playerOf(role);
			parts.push(p.total, p.health, p.passed ? 1 : 0, p.hand.cards.length, p.deck.cards.length);
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
		if (!this.active)
			return;
		this.deactivate();
		lobby.endMultiplayerGame("Game Desynced", "The two game states no longer match, so the match cannot continue. Sorry!");
	}
}

var mp = new MPSession();
