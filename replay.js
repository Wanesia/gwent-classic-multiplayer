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
//
// The game can't run backwards: going back replays from the start with no
// delays up to the chosen point. The game stops at "gates" for that, before
// every move and on every round's final board (Game.startTurn, Game.endRound).

class ReplaySession {
	constructor(rec, ctl) {
		this.online = rec.online;
		this.localRole = rec.localRole;
		this.queues = { host: [], guest: [] };
		for (const [role, msg] of rec.log)
			this.queues[role].push(msg);
		this.sums = rec.sums;
		this.turn = 0; // moves played so far
		this.ctl = ctl;
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

	// Every move ends here, so the move counter steps as each one finishes
	checkSum(h) {
		const want = this.sums[this.turn++];
		if (this.ctl.session === this)
			this.ctl.update();
		return want === undefined || want === h;
	}

	gate(kind) {
		return this.ctl.gate(this, kind);
	}

	diverged() {
		this.finish("diverged");
	}

	finish(result) {
		if (this.result)
			return;
		this.result = result;
		this.ctl.ended(this, result);
	}
}

const Replay = {
	session: null,
	rec: null,
	speed: 1,        // playback speed chosen by the viewer (2 = twice as fast)
	paused: false,
	target: null,    // where a seek stops: {turn: n} or {roundEnd: r}
	at: null,        // the last gate reached: {kind, turn, round}
	result: null,    // how the current run ended, null while it plays
	resume: null,    // releases a paused gate
	onEnd: null,     // run(): resolves when the replay ends
	listener: null,  // the controls redraw on every change
	beforeSeek: null, // the controls freeze the board before a seek
	playAfterSeek: false, // a restart plays on from the first move

	// Plays a recording to the end without controls (tests). speed is the
	// delay factor: 0.02 runs fifty times faster. Resolves with how it ended:
	// "done" (the match played out), "ended" (the recording stops early) or
	// "diverged".
	run(rec, { speed = 1 } = {}) {
		return new Promise(resolve => {
			this.speed = 1 / speed;
			this.paused = false;
			if (!this.start(rec))
				return resolve({ result: "diverged", turns: 0 });
			this.onEnd = resolve;
		});
	},

	// Starts a recording from its beginning. With a target it runs there with
	// no delays and pauses.
	start(rec, target = null) {
		const decks = { host: MatchHistory.deckFromRecord(rec.decks.host), guest: MatchHistory.deckFromRecord(rec.decks.guest) };
		if (!decks.host || !decks.guest)
			return false;
		game.reset(); // also detaches a replay already running
		this.rec = rec;
		this.target = target;
		this.at = null;
		this.result = null;
		const session = new ReplaySession(rec, this);
		this.session = session;
		mp.replay = session;
		GameSpeed.factor = target ? 0 : this.factor();
		GameRNG.reset(rec.seed);
		const opRole = mp.otherRole(rec.localRole);
		const names = rec.online ? [I18N.t("game.you"), I18N.t("game.opponent")] : [I18N.t("game.player1"), I18N.t("game.player2")];
		player_me = new Player(0, names[0], decks[rec.localRole]);
		player_op = new Player(1, names[1], decks[opRole], rec.aiRole !== opRole);
		player_me.controller = new ControllerRemote(player_me);
		dm.elem.classList.add("hide");
		game.endScreen.classList.add("hide");
		game.startGame();
		this.update();
		return true;
	},

	factor() {
		return 1 / this.speed;
	},

	// Called by the game before every move and on every round's final board
	async gate(session, kind) {
		if (session !== this.session)
			return;
		this.at = { kind, turn: session.turn, round: game.roundCount };
		if (this.target && this.reached(this.target, kind, session)) {
			this.target = null;
			this.paused = !this.playAfterSeek;
			this.playAfterSeek = false;
			GameSpeed.factor = this.factor();
		}
		this.update();
		while (this.paused && !this.target && session === this.session)
			await new Promise(r => this.resume = r);
	},

	reached(t, kind, session) {
		if (t.turn !== undefined)
			return kind === "turn" && session.turn >= t.turn;
		return kind === "roundEnd" && game.roundCount >= t.roundEnd;
	},

	ended(session, result) {
		if (session !== this.session)
			return;
		this.result = result;
		this.target = null;
		this.playAfterSeek = false;
		GameSpeed.factor = this.factor();
		this.update();
		const done = this.onEnd;
		this.onEnd = null;
		if (done)
			done({ result, turns: session.turn });
	},

	release() {
		const r = this.resume;
		this.resume = null;
		if (r)
			r();
	},

	update() {
		if (this.listener)
			this.listener();
	},

	// ---- controls ----

	turn() {
		return this.session ? this.session.turn : 0;
	},

	turns() {
		return this.rec ? this.rec.sums.length : 0;
	},

	seeking() {
		return !!this.target;
	},

	play() {
		if (this.result)
			return this.restart();
		this.paused = false;
		this.update();
		this.release();
	},

	pause() {
		this.paused = true;
		this.update();
	},

	toggle() {
		this.paused || this.result ? this.play() : this.pause();
	},

	// From the first move, playing; reached like a seek, so it's as smooth
	restart() {
		this.playAfterSeek = true;
		this.seek({ turn: 0 });
	},

	setSpeed(speed) {
		this.speed = speed;
		if (!this.target)
			GameSpeed.factor = this.factor();
		this.update();
	},

	// Goes to a point and pauses there: onwards from here when it lies ahead,
	// otherwise replayed from the start
	seek(target) {
		if (!this.rec)
			return;
		if (this.beforeSeek)
			this.beforeSeek();
		if (!this.result && this.ahead(target)) {
			this.target = target;
			GameSpeed.factor = 0;
			this.update();
			this.release();
		} else {
			this.start(this.rec, target);
		}
	},

	ahead(t) {
		const at = this.at;
		if (t.turn !== undefined)
			return t.turn > this.turn() || (t.turn === this.turn() && !(at && at.kind === "turn" && at.turn === t.turn));
		return t.roundEnd > game.roundCount || (t.roundEnd === game.roundCount && !(at && at.kind === "roundEnd" && at.round === t.roundEnd));
	},

	nextTurn() {
		this.seek({ turn: this.turn() + 1 });
	},

	prevTurn() {
		this.seek({ turn: Math.max(0, this.turn() - 1) });
	},

	// To the end of this round, or of the next one when already there
	nextRound() {
		const r = Math.max(1, game.roundCount);
		const atEnd = this.at && this.at.kind === "roundEnd" && this.at.round === r;
		this.seek({ roundEnd: atEnd ? r + 1 : r });
	},

	// To the end of the previous round, or the first move
	prevRound() {
		const r = game.roundCount;
		this.seek(r > 1 ? { roundEnd: r - 1 } : { turn: 0 });
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
		const session = this.session;
		this.session = null;
		mp.replay = null;
		GameSpeed.factor = 1;
		this.release();
		session.finish("stopped");
		const done = this.onEnd;
		this.onEnd = null;
		if (done)
			done({ result: "stopped", turns: session.turn });
		if (player_me && player_me.controller instanceof ControllerRemote)
			player_me.controller = new Controller();
	},
};

// The controls shown on the right of the board while a replay plays
const ReplayUI = {
	SPEEDS: [0.5, 1, 2, 4],
	ICONS: {
		restart: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
		prevRound: "M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z",
		prevTurn: "M6 6h2v12H6zm3.5 6l8.5 6V6z",
		play: "M8 5v14l11-7z",
		pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
		nextTurn: "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z",
		nextRound: "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z",
		download: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z",
		minimize: "M6 19h12v2H6z",
		expand: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
		grip: "M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
	},

	init() {
		this.bar = document.getElementById("replay-bar");
		this.label = this.bar.querySelector(".rp-label");
		this.status = this.bar.querySelector(".rp-status");
		this.buttons = {};
		const controls = this.bar.querySelector(".rp-controls");
		for (const name of ["restart", "prevRound", "prevTurn", "toggle", "nextTurn", "nextRound"]) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "rp-btn rp-" + name;
			b.append(this.icon(name === "toggle" ? "pause" : name));
			b.addEventListener("click", () => Replay[name]());
			controls.append(b);
			this.buttons[name] = b;
		}
		const speeds = this.bar.querySelector(".rp-speeds");
		this.speedButtons = this.SPEEDS.map(s => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "rp-speed";
			b.textContent = String(s).replace(".", I18N.t("replay.decimal")) + "×";
			b.addEventListener("click", () => Replay.setSpeed(s));
			speeds.append(b);
			return b;
		});
		this.bar.querySelector(".rp-exit").addEventListener("click", () => this.exit());
		this.bar.querySelector(".rp-grip").append(this.icon("grip"));
		this.sizeButton = this.bar.querySelector(".rp-size");
		this.sizeButton.addEventListener("click", () => this.setMini(!this.mini));
		Replay.listener = () => this.render();
		Replay.beforeSeek = () => this.freeze();

		// Where the viewer left the controls, and whether folded up
		let saved = null;
		try { saved = JSON.parse(safeStorage.get("gc-replay-bar")); } catch (e) {}
		this.mini = !!(saved && saved.mini);
		this.pos = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : null;
		this.initDrag();
	},

	// ---- a still board while skipping ----

	// Skipping plays every move at once, which flashes and jumps. A copy of
	// the board as it is now stays on top meanwhile, then fades into the new
	// position. The copy comes after <main> in the page, so lookups by id and
	// tag still find the real board.
	freeze() {
		if (this.frozen || !this.isOpen())
			return; // a seek during a seek keeps the first picture
		const board = document.querySelector("main");
		const still = board.cloneNode(true);
		still.classList.add("replay-still");
		still.setAttribute("aria-hidden", "true");
		board.after(still);
		this.frozen = still;
		// the corner buttons live outside the board: keep them above the copy,
		// unless the results cover them anyway
		document.body.classList.toggle("replay-still-icons", game.endScreen.classList.contains("hide"));
	},

	thaw(now = false) {
		const still = this.frozen;
		if (!still)
			return;
		this.frozen = null;
		const done = () => {
			still.remove();
			if (!this.frozen)
				document.body.classList.remove("replay-still-icons");
		};
		if (now)
			return done();
		requestAnimationFrame(() => {
			still.classList.add("replay-still-out");
			setTimeout(done, 350);
		});
	},

	// ---- folding and moving the controls ----

	setMini(mini) {
		this.mini = mini;
		this.render();
		this.keepInside();
		this.save();
	},

	save() {
		safeStorage.set("gc-replay-bar", JSON.stringify({ mini: this.mini, ...(this.pos || {}) }));
	},

	// Press anywhere but a button and drag; the controls stay on the board
	initDrag() {
		const bar = this.bar;
		bar.addEventListener("pointerdown", e => {
			if (e.button !== 0 || e.target.closest("button"))
				return;
			const box = bar.getBoundingClientRect();
			this.drag = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top };
			bar.setPointerCapture(e.pointerId);
			bar.classList.add("rp-dragging");
			e.preventDefault();
		});
		bar.addEventListener("pointermove", e => {
			if (this.drag && e.pointerId === this.drag.id)
				this.place(e.clientX - this.drag.dx, e.clientY - this.drag.dy);
		});
		const end = e => {
			if (!this.drag || e.pointerId !== this.drag.id)
				return;
			this.drag = null;
			bar.classList.remove("rp-dragging");
			this.save();
		};
		bar.addEventListener("pointerup", end);
		bar.addEventListener("pointercancel", end);
		window.addEventListener("resize", () => this.keepInside());
	},

	// Puts the top-left corner at a screen point, kept on the board. Stored as
	// a fraction of the board, so it holds when the window is resized.
	place(left, top) {
		const area = document.querySelector("main").getBoundingClientRect();
		const box = this.bar.getBoundingClientRect();
		const x = Math.min(Math.max(left, area.left), area.right - box.width);
		const y = Math.min(Math.max(top, area.top), area.bottom - box.height);
		this.pos = { x: (x - area.left) / area.width, y: (y - area.top) / area.height };
		this.applyPos();
	},

	// The board is 100vw wide and 1080/1920 of that high, scaled or not
	applyPos() {
		const s = this.bar.style;
		if (!this.pos) {
			s.left = s.top = s.right = "";
			return;
		}
		s.left = (this.pos.x * 100) + "vw";
		s.top = "calc(" + (this.pos.y * 100) + "vw * 1080 / 1920)";
		s.right = "auto";
	},

	// After folding, unfolding or a resize the box may stick out: pull it back
	keepInside() {
		if (!this.isOpen() || !this.pos)
			return;
		const box = this.bar.getBoundingClientRect();
		this.place(box.left, box.top);
	},

	icon(name) {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		const path = document.createElementNS(ns, "path");
		path.setAttribute("d", this.ICONS[name]);
		svg.append(path);
		return svg;
	},

	isOpen() {
		return !!this.bar && !this.bar.classList.contains("hide");
	},

	// Starts watching a recorded match from the main menu
	open(rec) {
		Replay.speed = 1;
		Replay.paused = false;
		lobby.elem.classList.add("hide");
		ui.toggleSettings.forEach(e => e.classList.remove("lobby-menu"));
		if (!Replay.start(rec)) {
			lobby.showMenu();
			return false;
		}
		this.bar.classList.remove("hide");
		this.applyPos();
		this.render();
		this.keepInside();
		return true;
	},

	// Back to the main menu, with the match history open again
	exit() {
		const open = this.isOpen();
		this.bar.classList.add("hide");
		document.body.classList.remove("replay-seeking");
		this.thaw(true);
		Replay.stop();
		if (open) {
			lobby.showMenu();
			HistoryUI.open();
		}
	},

	render() {
		if (!this.bar)
			return;
		const r = Replay;
		const round = Math.max(1, game.roundCount);
		const part = (cls, text) => { const e = document.createElement("span"); e.className = cls; e.textContent = text; return e; };
		this.label.replaceChildren(
			part("rp-round", I18N.t("replay.labelRound", { round })),
			part("rp-move", I18N.t("replay.labelMove", { turn: r.turn(), turns: r.turns() })));
		const playing = !r.paused && !r.result;
		const toggle = this.buttons.toggle;
		toggle.replaceChildren(this.icon(playing ? "pause" : "play"));
		const titles = { restart: "replay.restart", prevRound: "replay.prevRound", prevTurn: "replay.prevTurn",
			toggle: playing ? "replay.pause" : "replay.play", nextTurn: "replay.nextTurn", nextRound: "replay.nextRound" };
		for (const [name, key] of Object.entries(titles))
			this.buttons[name].setAttribute("data-title", I18N.t(key));
		this.buttons.nextTurn.disabled = this.buttons.nextRound.disabled = !!r.result;
		this.speedButtons.forEach((b, i) => b.classList.toggle("active", this.SPEEDS[i] === r.speed));
		this.bar.classList.toggle("rp-mini", this.mini);
		this.sizeButton.replaceChildren(this.icon(this.mini ? "expand" : "minimize"));
		this.sizeButton.setAttribute("data-title", I18N.t(this.mini ? "replay.expand" : "replay.minimize"));
		const status = { done: "replay.done", ended: "replay.ended", diverged: "replay.diverged" }[r.result];
		this.status.textContent = status ? I18N.t(status) : "";
		this.status.classList.toggle("hide", !status);
		// no transitions to wait for while skipping
		document.body.classList.toggle("replay-seeking", r.seeking() && this.isOpen());
		if (!r.seeking())
			this.thaw();
	},

	// Space: play/pause. Arrows: moves, with Shift: rounds. M: fold the
	// controls. Escape: leave.
	onKey(k, e) {
		switch (k) {
			case " ": Replay.toggle(); return true;
			case "ArrowLeft": e.shiftKey ? Replay.prevRound() : Replay.prevTurn(); return true;
			case "ArrowRight": if (!Replay.result) e.shiftKey ? Replay.nextRound() : Replay.nextTurn(); return true;
			case "Escape": case "Backspace": this.exit(); return true;
			case "m": this.setMini(!this.mini); return true;
		}
		return false;
	},
};

ReplayUI.init();
