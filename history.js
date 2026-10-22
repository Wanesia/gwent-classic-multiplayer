"use strict"

// Match history and replays, kept only in this browser (IndexedDB).
//
// Every match is recorded from its first moment: a small summary (result,
// factions, leaders, round scores) and the data needed to replay it - the
// seed, both decks, every human choice as a netplay wire message and the state
// checksum after every turn. The computer opponent replays itself from its own
// seeded random stream (GameRNG.ai), so its choices are not stored.
//
// A match is saved as "playing" when it starts. One that is still "playing"
// the next time the game loads was abandoned (tab closed, crash, flat battery)
// and counts as a defeat.

const HISTORY_RESULTS = ["win", "lose", "draw", "left", "walkover", "desync"];
const HISTORY_MODES = ["ai", "friend", "quick"];
const HISTORY_ROLES = ["host", "guest"];
const HISTORY_MSG_TYPES = ["play", "scorch", "decoy", "pass", "leader", "pick", "pickEnd", "row", "first"];

// The replay being recorded: human choices and per-turn checksums
const MatchLog = {
	rec: null,

	// Only game choices: chat goes through mp.send too, but isn't replayed
	add(role, msg) {
		if (this.rec && !mp.replay && HISTORY_MSG_TYPES.includes(msg.t))
			this.rec.log.push([role, JSON.parse(JSON.stringify(msg))]);
	},

	sum(h) {
		if (this.rec && !mp.replay)
			this.rec.sums.push(h);
	},
};

// Thin promise wrapper around the two object stores. Every failure (storage
// blocked, private mode, quota) rejects; callers decide what to tell the player.
const HistoryDB = {
	opening: null,
	failWrites: 0, // tests: make the next n writes fail as if storage were full

	open() {
		if (!this.opening) {
			this.opening = new Promise((resolve, reject) => {
				const req = indexedDB.open("gwent-classic", 1);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains("matches"))
						db.createObjectStore("matches", { keyPath: "id" });
					if (!db.objectStoreNames.contains("replays"))
						db.createObjectStore("replays", { keyPath: "id" });
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			// indexedDB itself may throw (blocked storage) before a request exists
			this.opening = this.opening.catch(e => { throw e || new Error("indexedDB unavailable"); });
		}
		return this.opening;
	},

	// Runs fn(matches, replays) in one transaction. Resolves with fn's result
	// (a function is called to read request results) once the transaction commits.
	async tx(mode, fn) {
		const db = await this.open();
		return new Promise((resolve, reject) => {
			const t = db.transaction(["matches", "replays"], mode);
			const out = fn(t.objectStore("matches"), t.objectStore("replays"));
			t.oncomplete = () => resolve(typeof out === "function" ? out() : out);
			t.onerror = () => reject(t.error);
			t.onabort = () => reject(t.error || new DOMException("Transaction aborted", "AbortError"));
		});
	},

	put(summary, replay) {
		if (this.failWrites > 0) {
			this.failWrites--;
			return Promise.reject(new DOMException("Simulated full storage", "QuotaExceededError"));
		}
		return this.tx("readwrite", (m, r) => {
			m.put(summary);
			if (replay)
				r.put(replay);
		});
	},

	getAll(store) {
		return this.tx("readonly", (m, r) => {
			const req = (store === "replays" ? r : m).getAll();
			return () => req.result;
		});
	},

	get(store, id) {
		return this.tx("readonly", (m, r) => {
			const req = (store === "replays" ? r : m).get(id);
			return () => req.result;
		});
	},

	replayIds() {
		return this.tx("readonly", (m, r) => {
			const req = r.getAllKeys();
			return () => req.result;
		});
	},

	// One transaction: a replace that fails half-way (e.g. storage full)
	// leaves the old history untouched
	putMany(matches, replays, replace) {
		if (this.failWrites > 0) {
			this.failWrites--;
			return Promise.reject(new DOMException("Simulated full storage", "QuotaExceededError"));
		}
		return this.tx("readwrite", (m, r) => {
			if (replace) {
				m.clear();
				r.clear();
			}
			matches.forEach(x => m.put(x));
			replays.forEach(x => r.put(x));
		});
	},

	deleteReplays(ids) {
		return this.tx("readwrite", (m, r) => ids.forEach(id => r.delete(id)));
	},

	clear() {
		return this.tx("readwrite", (m, r) => { m.clear(); r.clear(); });
	},
};

const MatchHistory = {
	current: null, // {summary, replay} of the match being played

	init() {
		this.ready = this.recoverUnfinished().catch(() => {});
		// Best effort: an abandoned match keeps the choices made so far
		window.addEventListener("pagehide", () => this.persist());
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden")
				this.persist();
		});
	},

	// Matches left "playing" by a closed tab or a crash count as a defeat
	async recoverUnfinished() {
		const all = await HistoryDB.getAll("matches");
		const stale = all.filter(m => m.status === "playing" && m.id !== this.current?.summary.id);
		for (const m of stale) {
			m.status = "done";
			m.result = "left";
			await HistoryDB.put(m);
		}
	},

	begin() {
		if (mp.replay)
			return;
		const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
		const side = p => ({ faction: p.deck_data.faction, leader: p.deck_data.leader.name });
		const ai = player_op.controller instanceof ControllerAI;
		const summary = {
			id, ts: Date.now(), ver: (typeof Changelog !== "undefined" && Changelog.version) || "",
			mode: mp.active ? (lobby.matchMode || "friend") : "ai",
			status: "playing", result: null,
			me: side(player_me), op: side(player_op), rounds: [], fav: false,
		};
		const replay = {
			id, v: 1, seed: GameRNG.seed, online: mp.active,
			localRole: mp.localRole(), aiRole: ai ? mp.roleOf(player_op) : null,
			decks: {
				[mp.roleOf(player_me)]: this.deckRecord(player_me.deck_data),
				[mp.roleOf(player_op)]: this.deckRecord(player_op.deck_data),
			},
			log: [], sums: [],
		};
		this.current = { summary, replay };
		MatchLog.rec = replay;
		this.persist();
	},

	// Card indices plus names: a later version may reorder card_dict
	deckRecord(deck) {
		const li = card_dict.indexOf(deck.leader);
		return {
			faction: deck.faction,
			leader: [li, deck.leader.name],
			cards: deck.cards.map(c => [Number(c.index), Number(c.count), card_dict[c.index].name]),
		};
	},

	// Rebuilds a deck in the format Player expects (see DeckMaker.startNewGame)
	deckFromRecord(rec) {
		const index = ([i, name]) => card_dict[i] && card_dict[i].name === name ? i : card_dict.findIndex(c => c.name === name);
		const li = index(rec.leader);
		const cards = rec.cards.map(c => ({ index: index([c[0], c[2]]), count: c[1] }));
		if (li < 0 || cards.some(c => c.index < 0))
			return null;
		return { faction: rec.faction, leader: card_dict[li], cards };
	},

	rounds() {
		return game.roundHistory.map(r => ({
			me: r.score_me, op: r.score_op,
			w: r.winner === player_me ? "me" : r.winner === player_op ? "op" : null,
		}));
	},

	roundEnded() {
		if (!this.current)
			return;
		this.current.summary.rounds = this.rounds();
		this.persist();
	},

	// Called once a match is over, however it ended; later calls are ignored
	finish(result) {
		if (!this.current || mp.replay)
			return;
		const { summary } = this.current;
		summary.status = "done";
		summary.result = result;
		summary.rounds = this.rounds();
		this.persist();
		this.current = null;
		MatchLog.rec = null;
		HistoryUI.refresh();
	},

	persist() {
		if (!this.current)
			return Promise.resolve();
		const { summary, replay } = this.current;
		// Copies: the live record keeps changing while the write is pending
		return this.save(JSON.parse(JSON.stringify(summary)), JSON.parse(JSON.stringify(replay)));
	},

	// Out of storage: the oldest replays without a star go first. Match
	// summaries are tiny and always kept.
	async save(summary, replay) {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await HistoryDB.put(summary, replay);
			} catch (e) {
				if (!e || e.name !== "QuotaExceededError" || !(await this.pruneReplays(summary.id)))
					return console.warn("Match history not saved:", e);
			}
		}
	},

	async pruneReplays(keepId) {
		try {
			const [matches, ids] = await Promise.all([HistoryDB.getAll("matches"), HistoryDB.replayIds()]);
			const has = new Set(ids);
			const candidates = matches.filter(m => has.has(m.id) && !m.fav && m.id !== keepId).sort((a, b) => a.ts - b.ts);
			const drop = candidates.slice(0, Math.max(20, Math.ceil(candidates.length / 10))).map(m => m.id);
			if (!drop.length)
				return false;
			await HistoryDB.deleteReplays(drop);
			const prev = Number(safeStorage.get("gc-history-pruned")) || 0;
			safeStorage.set("gc-history-pruned", String(prev + drop.length));
			return true;
		} catch (e) {
			return false;
		}
	},

	async list() {
		const [matches, ids] = await Promise.all([HistoryDB.getAll("matches"), HistoryDB.replayIds()]);
		const has = new Set(ids);
		return matches.map(m => ({ ...m, hasReplay: has.has(m.id) })).sort((a, b) => b.ts - a.ts);
	},

	// Walkovers count as wins and leaving as a defeat. Desyncs and matches
	// still being played don't count.
	stats(matches) {
		const s = { played: 0, wins: 0, losses: 0, draws: 0 };
		for (const m of matches) {
			if (m.status !== "done")
				continue;
			if (m.result === "win" || m.result === "walkover") s.wins++;
			else if (m.result === "lose" || m.result === "left") s.losses++;
			else if (m.result === "draw") s.draws++;
			else continue;
			s.played++;
		}
		s.rate = s.played ? Math.round(100 * s.wins / s.played) : 0;
		return s;
	},

	async setFavorite(id, fav) {
		const m = await HistoryDB.get("matches", id);
		if (!m)
			return;
		m.fav = !!fav;
		await HistoryDB.put(m);
	},

	async exportData() {
		const [matches, replays] = await Promise.all([HistoryDB.getAll("matches"), HistoryDB.getAll("replays")]);
		return { format: "gwent-classic-history", v: 1, exported: Date.now(), matches, replays };
	},

	// mode: "merge" adds matches not already here (by id), "replace" swaps the
	// whole history for the file's. Invalid records are skipped.
	async importData(data, mode) {
		if (!data || typeof data !== "object" || data.format !== "gwent-classic-history" || !Array.isArray(data.matches))
			throw new Error("invalid");
		const matches = [];
		let skipped = 0;
		const seen = new Set();
		for (const raw of data.matches.slice(0, 100000)) {
			const m = HistoryValidate.summary(raw);
			if (!m || seen.has(m.id)) { skipped++; continue; }
			seen.add(m.id);
			matches.push(m);
		}
		skipped += Math.max(0, data.matches.length - 100000);
		const replays = new Map();
		for (const raw of Array.isArray(data.replays) ? data.replays.slice(0, 100000) : []) {
			const r = HistoryValidate.replay(raw);
			if (r && seen.has(r.id))
				replays.set(r.id, r);
		}
		let fresh = matches;
		if (mode !== "replace") {
			const existing = new Set((await HistoryDB.getAll("matches")).map(m => m.id));
			fresh = matches.filter(m => !existing.has(m.id));
			skipped += matches.length - fresh.length;
		}
		await HistoryDB.putMany(fresh, fresh.map(m => replays.get(m.id)).filter(Boolean), mode === "replace");
		const added = fresh.length;
		return { added, skipped };
	},
};

// Everything read from an imported file is checked here and rebuilt from known
// values, so a hand-edited or malicious file can't break the game or the page.
const HistoryValidate = {
	id: v => typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v),
	int: (v, min, max) => Number.isInteger(v) && v >= min && v <= max,
	faction: v => typeof v === "string" && ["realms", "nilfgaard", "monsters", "scoiatael", "skellige"].includes(v),
	leader: v => typeof v === "string" && card_dict.some(c => c.row === "leader" && c.name === v),

	side(s) {
		if (!s || typeof s !== "object" || !this.faction(s.faction) || !this.leader(s.leader))
			return null;
		return { faction: s.faction, leader: s.leader };
	},

	summary(m) {
		if (!m || typeof m !== "object" || !this.id(m.id))
			return null;
		const now = Date.now() + 86400000;
		if (!Number.isFinite(m.ts) || m.ts < Date.UTC(2020, 0, 1) || m.ts > now)
			return null;
		if (!HISTORY_MODES.includes(m.mode) || !Array.isArray(m.rounds) || m.rounds.length > 3)
			return null;
		// A match exported mid-game was never finished: a defeat, as on load
		const result = m.status === "playing" ? "left" : m.result;
		if (!HISTORY_RESULTS.includes(result))
			return null;
		const me = this.side(m.me), op = this.side(m.op);
		if (!me || !op)
			return null;
		const rounds = [];
		for (const r of m.rounds) {
			if (!r || !this.int(r.me, 0, 9999) || !this.int(r.op, 0, 9999) || ![null, "me", "op"].includes(r.w))
				return null;
			rounds.push({ me: r.me, op: r.op, w: r.w });
		}
		const ver = typeof m.ver === "string" && /^[0-9.]{0,20}$/.test(m.ver) ? m.ver : "";
		return { id: m.id, ts: m.ts, ver, mode: m.mode, status: "done", result, me, op, rounds, fav: m.fav === true };
	},

	deck(d) {
		if (!d || typeof d !== "object" || !this.faction(d.faction) || !Array.isArray(d.leader) || !Array.isArray(d.cards) || d.cards.length > 200)
			return null;
		const ref = x => Array.isArray(x) && this.int(x[0], 0, 100000) && typeof x[1] === "string" && x[1].length <= 80;
		if (!ref(d.leader))
			return null;
		const cards = [];
		for (const c of d.cards) {
			if (!Array.isArray(c) || !this.int(c[0], 0, 100000) || !this.int(c[1], 1, 10) || typeof c[2] !== "string" || c[2].length > 80)
				return null;
			cards.push([c[0], c[1], c[2]]);
		}
		return { faction: d.faction, leader: [d.leader[0], d.leader[1]], cards };
	},

	msg(m) {
		if (!m || typeof m !== "object" || !HISTORY_MSG_TYPES.includes(m.t))
			return null;
		const out = { t: m.t };
		const dest = d => d === "weather" || d === null || (d && typeof d === "object" && HISTORY_ROLES.includes(d.o) && ["close", "ranged", "siege"].includes(d.r));
		for (const k of ["i", "j"])
			if (k in m) {
				if (!this.int(m[k], 0, 1000))
					return null;
				out[k] = m[k];
			}
		if ("d" in m) {
			if (!dest(m.d))
				return null;
			out.d = m.d && typeof m.d === "object" ? { o: m.d.o, r: m.d.r } : m.d;
		}
		if ("who" in m) {
			if (!HISTORY_ROLES.includes(m.who))
				return null;
			out.who = m.who;
		}
		return out;
	},

	replay(r) {
		if (!r || typeof r !== "object" || !this.id(r.id) || r.v !== 1 || !this.int(r.seed, 0, 4294967295))
			return null;
		if (!HISTORY_ROLES.includes(r.localRole) || (r.aiRole !== null && !HISTORY_ROLES.includes(r.aiRole)) || typeof r.online !== "boolean")
			return null;
		if (!r.decks || typeof r.decks !== "object" || !Array.isArray(r.log) || r.log.length > 5000 || !Array.isArray(r.sums) || r.sums.length > 1000)
			return null;
		const decks = { host: this.deck(r.decks.host), guest: this.deck(r.decks.guest) };
		if (!decks.host || !decks.guest)
			return null;
		const log = [];
		for (const e of r.log) {
			const m = Array.isArray(e) && HISTORY_ROLES.includes(e[0]) ? this.msg(e[1]) : null;
			if (!m)
				return null;
			log.push([e[0], m]);
		}
		if (!r.sums.every(h => typeof h === "string" && /^[0-9a-f]{1,8}$/.test(h)))
			return null;
		return { id: r.id, v: 1, seed: r.seed, online: r.online, localRole: r.localRole, aiRole: r.aiRole, decks, log, sums: r.sums.slice() };
	},
};

// The match history window: statistics, the list of matches, import/export
const HistoryUI = {
	PAGE: 100,
	MAX_FILE: 50 * 1024 * 1024,

	init() {
		this.modal = document.getElementById("history-modal");
		this.statsElem = this.modal.querySelector(".hist-stats");
		this.listElem = this.modal.querySelector(".hist-list");
		this.moreButton = this.modal.querySelector(".hist-more");
		this.noticeElem = this.modal.querySelector(".hist-notice");
		this.askElem = this.modal.querySelector(".hist-ask");
		this.fileInput = this.modal.querySelector(".hist-file");
		this.filter = "all";
		this.shown = this.PAGE;
		this.matches = [];

		document.getElementById("lobby-history-toggle").addEventListener("click", () => this.open());
		this.modal.querySelector(".fb-close").addEventListener("click", () => this.close());
		this.modal.addEventListener("click", e => { if (e.target === this.modal) this.close(); });
		document.addEventListener("keydown", e => {
			// defaultPrevented: the same Escape just left a replay and opened this
			if (e.key === "Escape" && !e.defaultPrevented && !this.modal.classList.contains("hide")) {
				e.stopImmediatePropagation();
				this.askElem.classList.contains("hide") ? this.close() : this.hideAsk();
			}
		});
		this.modal.querySelectorAll(".hist-filter button").forEach(b => b.addEventListener("click", () => {
			this.filter = b.dataset.filter;
			this.shown = this.PAGE;
			this.render();
		}));
		this.moreButton.addEventListener("click", () => { this.shown += this.PAGE; this.render(); });
		this.listElem.addEventListener("scroll", () => this.hideTip());
		this.modal.querySelector(".hist-export").addEventListener("click", () => this.exportFile());
		this.modal.querySelector(".hist-import").addEventListener("click", () => this.fileInput.click());
		this.fileInput.addEventListener("change", () => this.pickFile());
		this.modal.querySelector(".hist-clear").addEventListener("click", () => this.ask(I18N.t("history.clearAsk"), [
			[I18N.t("history.clearYes"), () => this.clearAll()],
		]));
	},

	isOpen() {
		return this.modal && !this.modal.classList.contains("hide");
	},

	async open() {
		AudioManager.playSFX("ui_card");
		this.modal.classList.remove("hide");
		this.hideAsk();
		this.shown = this.PAGE;
		// Asks the browser not to evict the history when the disk fills up.
		// Firefox may show a permission prompt; others decide on their own.
		if (!this.persistAsked && navigator.storage?.persist) {
			this.persistAsked = true;
			navigator.storage.persist().catch(() => {});
		}
		const pruned = Number(safeStorage.get("gc-history-pruned")) || 0;
		if (pruned) {
			safeStorage.remove("gc-history-pruned");
			this.notice(I18N.t("history.pruned", { n: pruned }));
		} else {
			this.notice("");
		}
		await this.refresh();
	},

	close() {
		this.hideTip();
		this.modal.classList.add("hide");
	},

	async refresh() {
		if (!this.isOpen())
			return;
		try {
			await MatchHistory.ready;
			this.matches = await MatchHistory.list();
			this.available = true;
		} catch (e) {
			this.matches = [];
			this.available = false;
		}
		this.render();
	},

	notice(text) {
		this.noticeElem.textContent = text;
		this.noticeElem.classList.toggle("hide", !text);
	},

	filtered() {
		if (this.filter === "ai")
			return this.matches.filter(m => m.mode === "ai");
		if (this.filter === "online")
			return this.matches.filter(m => m.mode !== "ai");
		return this.matches;
	},

	render() {
		this.modal.querySelectorAll(".hist-filter button").forEach(b => b.classList.toggle("active", b.dataset.filter === this.filter));
		const list = this.filtered();
		const s = MatchHistory.stats(list);
		const stat = (label, value) => {
			const d = document.createElement("div");
			const v = document.createElement("b");
			v.textContent = value;
			const l = document.createElement("span");
			l.textContent = label;
			d.append(v, l);
			return d;
		};
		this.statsElem.replaceChildren(
			stat(I18N.t("history.played"), s.played),
			stat(I18N.t("history.wins"), s.wins),
			stat(I18N.t("history.losses"), s.losses),
			stat(I18N.t("history.draws"), s.draws),
			stat(I18N.t("history.winRate"), s.rate + "%"),
		);

		if (!this.available) {
			this.listElem.replaceChildren(this.emptyRow(I18N.t("history.unavailable")));
			this.moreButton.classList.add("hide");
			return;
		}
		if (!list.length) {
			this.listElem.replaceChildren(this.emptyRow(I18N.t("history.empty")));
			this.moreButton.classList.add("hide");
			return;
		}
		this.hideTip();
		this.listElem.replaceChildren(...list.slice(0, this.shown).map(m => this.row(m)));
		this.moreButton.classList.toggle("hide", list.length <= this.shown);
	},

	// The list scrolls, which would clip a CSS tooltip on its last rows, so
	// this one lives on the panel and opens above the button when there's no
	// room below
	showTip(target, text) {
		const panel = this.modal.querySelector(".hist-panel");
		if (!this.tip) {
			this.tip = document.createElement("div");
			this.tip.className = "hist-tip";
			panel.append(this.tip);
		}
		this.tip.textContent = text;
		this.tip.classList.remove("hide");
		// The game screen is scaled: convert screen pixels to panel pixels
		const p = panel.getBoundingClientRect(), t = target.getBoundingClientRect();
		const scale = p.width / panel.offsetWidth || 1;
		const gap = 4;
		let top = (t.bottom - p.top) / scale + gap;
		if (top + this.tip.offsetHeight > panel.clientHeight)
			top = (t.top - p.top) / scale - this.tip.offsetHeight - gap;
		this.tip.style.left = (t.left - p.left) / scale + "px";
		this.tip.style.top = top + "px";
	},

	hideTip() {
		this.tip?.classList.add("hide");
	},

	emptyRow(text) {
		const p = document.createElement("p");
		p.className = "hist-empty";
		p.textContent = text;
		return p;
	},

	row(m) {
		const el = (tag, cls, text) => {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (text !== undefined) e.textContent = text;
			return e;
		};
		const row = el("div", "hist-row");

		const star = el("button", "hist-star" + (m.fav ? " on" : ""), m.fav ? "★" : "☆");
		star.type = "button";
		star.addEventListener("mouseenter", () => this.showTip(star, I18N.t("history.favorite")));
		star.addEventListener("mouseleave", () => this.hideTip());
		star.addEventListener("click", async () => {
			m.fav = !m.fav;
			star.classList.toggle("on", m.fav);
			star.textContent = m.fav ? "★" : "☆";
			try { await MatchHistory.setFavorite(m.id, m.fav); } catch (e) {}
		});

		const status = m.status === "done" ? m.result : "playing";
		const result = el("span", "hist-result hist-" + status, I18N.t("history.result." + status));
		const hint = { left: "history.hintLeft", walkover: "history.hintWalkover", desync: "history.hintDesync" }[status];
		if (hint)
			result.title = I18N.t(hint);

		const when = el("div", "hist-when");
		let date, time;
		try {
			date = new Intl.DateTimeFormat(I18N.lang, { dateStyle: "medium" }).format(new Date(m.ts));
			time = new Intl.DateTimeFormat(I18N.lang, { timeStyle: "short" }).format(new Date(m.ts));
		} catch (e) {
			date = new Date(m.ts).toLocaleDateString();
			time = new Date(m.ts).toLocaleTimeString();
		}
		const detail = el("span", "hist-mode");
		detail.append(el("span", "", time), el("span", "", I18N.t("history.mode." + m.mode)));
		when.append(el("span", "hist-date", date), detail);

		const side = s => {
			const wrap = el("div", "hist-side");
			const leader = card_dict.find(c => c.row === "leader" && c.name === s.leader);
			const thumb = el("div", "hist-thumb");
			if (leader)
				thumb.style.backgroundImage = smallURL(leader.deck + "_" + leader.filename);
			const names = el("div", "hist-names");
			const name = el("span", "hist-leader", I18N.card(s.leader));
			name.title = name.textContent; // long leader names are cut off
			names.append(
				name,
				el("span", "hist-faction", I18N.faction(s.faction, "name", factions[s.faction].name)),
			);
			wrap.append(thumb, names);
			return wrap;
		};

		const rounds = el("div", "hist-rounds");
		for (const r of m.rounds) {
			const span = el("span", "hist-round");
			const me = el("b", r.w === "me" ? "won" : "", String(r.me));
			const op = el("b", r.w === "op" ? "won" : "", String(r.op));
			span.append(me, document.createTextNode(":"), op);
			rounds.append(span);
		}

		// Watch and download need the replay, which full storage may have cost
		const tool = (cls, icon, tip, action) => {
			const b = el("button", "hist-tool " + cls);
			b.type = "button";
			b.append(ReplayUI.icon(icon));
			b.disabled = !m.hasReplay;
			const text = m.hasReplay ? I18N.t(tip) : I18N.t("replay.noReplay");
			// a disabled button gets no mouse events: the cell shows its tip
			const wrap = el("span", "hist-tool-wrap");
			wrap.append(b);
			wrap.addEventListener("mouseenter", () => this.showTip(wrap, text));
			wrap.addEventListener("mouseleave", () => this.hideTip());
			b.addEventListener("click", action);
			return wrap;
		};
		const tools = el("div", "hist-tools");
		tools.append(star,
			tool("hist-watch", "play", "replay.watch", () => this.watch(m)),
			tool("hist-download", "download", "replay.download", () => this.download(m)));

		row.append(tools, result, when, side(m.me), el("span", "hist-vs", I18N.t("history.vs")), side(m.op), rounds);
		return row;
	},

	async watch(m) {
		let rec = null;
		try { rec = await HistoryDB.get("replays", m.id); } catch (e) {}
		if (!rec)
			return this.notice(I18N.t("replay.noReplay"));
		this.close();
		if (!ReplayUI.open(rec))
			this.open().then(() => this.notice(I18N.t("replay.diverged")));
	},

	// One match as a file that Import (merge) takes on another device
	async download(m) {
		try {
			const [summary, replay] = await Promise.all([HistoryDB.get("matches", m.id), HistoryDB.get("replays", m.id)]);
			if (!summary)
				return;
			const data = { format: "gwent-classic-history", v: 1, exported: Date.now(), matches: [summary], replays: replay ? [replay] : [] };
			const stamp = new Date(summary.ts).toISOString().slice(0, 16).replace("T", "-").replace(":", "");
			this.saveFile(data, "gwent-match-" + stamp + ".json");
		} catch (e) {
			this.notice(I18N.t("history.unavailable"));
		}
	},

	saveFile(data, name) {
		const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	},

	// Inline confirmation inside the window (the game's popup sits under it)
	ask(text, actions) {
		const p = el => this.askElem.querySelector(el);
		p(".hist-ask-text").textContent = text;
		const buttons = p(".hist-ask-buttons");
		buttons.replaceChildren();
		for (const [label, fn] of actions) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "fb-btn";
			b.textContent = label;
			b.addEventListener("click", () => { this.hideAsk(); fn(); });
			buttons.append(b);
		}
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "fb-btn hist-cancel";
		cancel.textContent = I18N.t("history.cancel");
		cancel.addEventListener("click", () => this.hideAsk());
		buttons.append(cancel);
		this.askElem.classList.remove("hide");
	},

	hideAsk() {
		this.askElem.classList.add("hide");
	},

	async exportFile() {
		try {
			const data = await MatchHistory.exportData();
			this.saveFile(data, "gwent-history-" + new Date().toISOString().slice(0, 10) + ".json");
		} catch (e) {
			this.notice(I18N.t("history.unavailable"));
		}
	},

	pickFile() {
		const file = this.fileInput.files[0];
		this.fileInput.value = "";
		if (!file)
			return;
		if (file.size > this.MAX_FILE)
			return this.notice(I18N.t("history.importTooLarge"));
		const reader = new FileReader();
		reader.onload = () => {
			let data;
			try { data = JSON.parse(reader.result); } catch (e) { return this.notice(I18N.t("history.importInvalid")); }
			if (!data || data.format !== "gwent-classic-history")
				return this.notice(I18N.t("history.importInvalid"));
			this.ask(I18N.t("history.importAsk"), [
				[I18N.t("history.importMerge"), () => this.importFile(data, "merge")],
				[I18N.t("history.importReplace"), () => this.ask(I18N.t("history.replaceAsk"), [
					[I18N.t("history.importReplace"), () => this.importFile(data, "replace")],
				])],
			]);
		};
		reader.readAsText(file);
	},

	async importFile(data, mode) {
		try {
			const { added, skipped } = await MatchHistory.importData(data, mode);
			this.notice(I18N.t(mode === "replace" ? "history.importReplaced" : "history.importDone", { added, skipped }));
		} catch (e) {
			const key = e && e.message === "invalid" ? "history.importInvalid"
				: e && e.name === "QuotaExceededError" ? "history.importFull" : "history.unavailable";
			this.notice(I18N.t(key));
		}
		await this.refresh();
	},

	async clearAll() {
		try {
			await HistoryDB.clear();
			this.notice(I18N.t("history.cleared"));
		} catch (e) {
			this.notice(I18N.t("history.unavailable"));
		}
		await this.refresh();
	},
};

MatchHistory.init();
HistoryUI.init();
