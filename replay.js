"use strict"

// Plays a recorded match (history.js) back through the real game engine.
//
// Both decks are rebuilt and GameRNG is reset to the recorded seed, so every
// shuffle, coin toss and random effect comes out the same. Human players get a
// ControllerRemote: their choices are fed from the recording through the same
// code paths an online opponent's choices take. The computer opponent plays
// itself again from its seeded stream. After every turn the state checksum is
// compared with the recorded one, so a replay that no longer matches (e.g. one
// recorded before a rules change) stops instead of showing a different match.

class ReplaySession {
	constructor(rec, onEnd) {
		this.online = rec.online;
		this.localRole = rec.localRole;
		this.queues = { host: [], guest: [] };
		for (const [role, msg] of rec.log)
			this.queues[role].push(msg);
		this.sums = rec.sums;
		this.turn = 0;
		this.onEnd = onEnd;
		this.result = null;
	}

	// The next recorded choice of that player. When the recording runs out (an
	// abandoned match) the replay ends there.
	next(role, types) {
		if (this.result)
			return new Promise(() => {});
		const m = this.queues[role].shift();
		if (!m) {
			this.finish("ended");
			return new Promise(() => {});
		}
		if (!types.includes(m.t)) {
			this.diverged();
			return new Promise(() => {});
		}
		return Promise.resolve(m);
	}

	checkSum(h) {
		const want = this.sums[this.turn++];
		return want === undefined || want === h;
	}

	diverged() {
		this.finish("diverged");
	}

	finish(result) {
		if (this.result)
			return;
		this.result = result;
		this.onEnd({ result, turns: this.turn });
	}
}

const Replay = {
	session: null,

	// Starts playing a recording. Resolves once it ends: "done" (the match
	// played out), "ended" (the recording stops early) or "diverged".
	run(rec, { speed = 1 } = {}) {
		const decks = { host: MatchHistory.deckFromRecord(rec.decks.host), guest: MatchHistory.deckFromRecord(rec.decks.guest) };
		if (!decks.host || !decks.guest)
			return Promise.resolve({ result: "diverged", turns: 0 });
		this.stop();
		game.reset();
		return new Promise(resolve => {
			const session = new ReplaySession(rec, resolve);
			this.session = session;
			mp.replay = session;
			GameSpeed.factor = speed;
			GameRNG.reset(rec.seed);
			const opRole = mp.otherRole(rec.localRole);
			const names = rec.online ? [I18N.t("game.you"), I18N.t("game.opponent")] : [I18N.t("game.player1"), I18N.t("game.player2")];
			player_me = new Player(0, names[0], decks[rec.localRole]);
			player_op = new Player(1, names[1], decks[opRole], rec.aiRole !== opRole);
			player_me.controller = new ControllerRemote(player_me);
			dm.elem.classList.add("hide");
			game.endScreen.classList.add("hide");
			game.startGame();
		});
	},

	// Leaves the replay and returns to the deck builder
	stop() {
		if (!this.session)
			return;
		if (game.state !== GameState.CUSTOMIZE)
			game.returnToCustomization();
		this.detach();
	},

	// Any new game (rematch, new game, customize) ends the replay first, so it
	// is played and recorded as a normal match
	detach() {
		if (!this.session)
			return;
		this.session.finish("stopped");
		this.session = null;
		mp.replay = null;
		GameSpeed.factor = 1;
		if (player_me && player_me.controller instanceof ControllerRemote)
			player_me.controller = new Controller();
	},
};
