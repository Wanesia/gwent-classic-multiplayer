"use strict"

// Anonymous player counts. No ID ever leaves the browser: it only remembers
// the UTC day, ISO week and month it last reported, and tells the server
// whether this visit is its first of each. The server adds those flags up
// into players per day, week and month (server/server.js).
//
// While the game is open (visible, or in an online lobby or match) it also
// sends a heartbeat about every 5 minutes, which the server counts as players
// online at once (and shows on the lobby screens).
const Stats = {
	// Just under the server's 5-minute window, so an open game is never missing from it
	HEARTBEAT_MS: 4.75 * 60 * 1000,
	KEY: "gc-seen",
	lastBeat: 0,
	visited: Promise.resolve(),

	init() {
		if (!Net.trackingEnabled())
			return;
		this.visited = this.reportVisit(); // the online count waits for it, to include this player
		// Checked often, so coming back to the tab counts right away
		setInterval(() => this.heartbeat(), 5000);
		document.addEventListener("visibilitychange", () => this.heartbeat());
		// Closing or reloading takes the heartbeat back, so a reload doesn't count twice
		window.addEventListener("pagehide", () => this.leave());
		window.addEventListener("pageshow", e => {
			if (e.persisted) {
				this.lastBeat = 0;
				this.heartbeat();
			}
		});
	},

	leave() {
		if (!this.lastBeat)
			return;
		Net.trackEvent("bye", { ago: Date.now() - this.lastBeat });
		this.lastBeat = 0;
	},

	heartbeat() {
		if ((document.hidden && !Net.connected) || Date.now() - this.lastBeat < this.HEARTBEAT_MS)
			return;
		this.lastBeat = Date.now();
		Net.trackEvent("here");
	},

	reportVisit(now = new Date()) {
		const day = now.toISOString().slice(0, 10);
		const seenNow = { d: day, w: isoWeek(now), m: day.slice(0, 7) };
		let seen = null;
		try { seen = JSON.parse(safeStorage.get(this.KEY)); } catch (e) {}
		const hadData = storageCount() > 0;
		safeStorage.set(this.KEY, JSON.stringify(seenNow));
		this.lastBeat = Date.now(); // a visit counts as a heartbeat
		// Storage that's blocked can't tell a first visit from the hundredth:
		// count the page load only
		if (safeStorage.get(this.KEY) !== JSON.stringify(seenNow))
			return Net.trackEvent("visit");
		return Net.trackEvent("visit", {
			day: !seen || seen.d !== seenNow.d,
			week: !seen || seen.w !== seenNow.w,
			month: !seen || seen.m !== seenNow.m,
			// Players from before this counter existed have other things stored
			first: !seen && !hadData,
		});
	},
};

// ISO 8601 week of a date, in UTC: "2026-W45"
function isoWeek(date) {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // the week's Thursday decides its year
	const year = d.getUTCFullYear();
	const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
	return year + "-W" + String(week).padStart(2, "0");
}

function storageCount() {
	try { return localStorage.length; } catch (e) { return 0; }
}

Stats.init();
