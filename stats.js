"use strict"

// Anonymous player counts. No ID ever leaves the browser: it only remembers
// the UTC day, ISO week and month it last reported, and tells the server
// whether this visit is its first of each. The server adds those flags up
// into players per day, week and month (server/server.js).
//
// While the game is open (visible, or in an online lobby or match) it also
// sends a heartbeat every 5 minutes, which the server counts as players
// online at once.
const Stats = {
	HEARTBEAT_MS: 5 * 60 * 1000, // must match ONLINE_WINDOW_MS on the server
	KEY: "gc-seen",

	init() {
		if (!Net.trackingEnabled())
			return;
		this.reportVisit();
		setInterval(() => {
			if (!document.hidden || Net.connected)
				Net.trackEvent("here");
		}, this.HEARTBEAT_MS);
	},

	reportVisit(now = new Date()) {
		const day = now.toISOString().slice(0, 10);
		const seenNow = { d: day, w: isoWeek(now), m: day.slice(0, 7) };
		let seen = null;
		try { seen = JSON.parse(safeStorage.get(this.KEY)); } catch (e) {}
		const hadData = storageCount() > 0;
		safeStorage.set(this.KEY, JSON.stringify(seenNow));
		// Storage that's blocked can't tell a first visit from the hundredth:
		// count the page load only
		if (safeStorage.get(this.KEY) !== JSON.stringify(seenNow))
			return Net.trackEvent("visit");
		Net.trackEvent("visit", {
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
