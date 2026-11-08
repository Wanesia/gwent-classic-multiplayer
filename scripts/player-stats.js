#!/usr/bin/env node
"use strict"

// Prints player counts from the relay server's daily totals (server/stats.json,
// or STATS_FILE). Players are counted per browser: the same person on a phone
// and a PC counts twice, and a private window counts as a new player each time.
//
//   node scripts/player-stats.js                     last 14 days, 12 weeks, 12 months
//   DAYS=60 WEEKS=26 MONTHS=all node scripts/player-stats.js
//   make players DAYS=7 WEEKS=0                       (0 leaves a section out)

const fs = require("fs");
const path = require("path");

const FILE = process.env.STATS_FILE || path.join(__dirname, "..", "server", "stats.json");
const DAYS = periods("DAYS", 14);
const WEEKS = periods("WEEKS", 12);
const MONTHS = periods("MONTHS", 12);

// How many of the latest periods to show: a whole number, "all", or unset
function periods(name, fallback) {
	const value = process.env[name];
	if (value === undefined || value === "")
		return fallback;
	if (value === "all")
		return Infinity;
	if (/^\d+$/.test(value))
		return Number(value);
	console.log(`${name} must be a whole number or "all", got "${value}".`);
	process.exit(1);
}

// The last n items; slice(-0) would be all of them
const last = (items, n) => n ? items.slice(-n) : [];

let stats;
try {
	stats = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
	console.log(`No stats yet (${FILE}: ${e.code || e.message}).`);
	process.exit(1);
}

// Same as isoWeek() in stats.js
function isoWeek(date) {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const year = d.getUTCFullYear();
	const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
	return year + "-W" + String(week).padStart(2, "0");
}

const ev = (day, name) => day.events[name] || 0;
const pad = (v, n) => String(v).padStart(n);
const days = Object.keys(stats.days).sort();

console.log("=== Gwent players (per browser, UTC) ===");
if (stats.now)
	console.log(`Online now: ${stats.now.online} (at ${stats.now.at.slice(11, 16)})`);
console.log(`Counting since ${days[0] || "-"}\n`);

if (DAYS) {
	console.log(DAYS === Infinity ? "Days" : `Last ${DAYS} days`);
	console.log("  date        players   new  peak online  visits    vs AI  online  quick  relay peak");
	for (const date of last(days, DAYS)) {
		const d = stats.days[date];
		console.log("  " + date
			+ pad(d.players, 10)
			+ pad(d.newPlayers, 6)
			+ pad(d.peakOnline, 13)
			+ pad(d.visits, 8)
			+ pad(ev(d, "sp-game-started"), 9)
			+ pad(ev(d, "game-started") + ev(d, "game-started-quickmatch"), 8)
			+ pad(ev(d, "game-started-quickmatch"), 7)
			+ pad(`${d.peakSockets}/${d.peakGames}`, 12));
	}
	console.log("  vs AI = games started against the computer; online = online matches (quick = of them, via Quick Match)");
	console.log("  relay peak = most players connected for online play / online matches at once\n");
}

function rollup(title, count, keyOf, field) {
	if (!count)
		return;
	const groups = new Map();
	for (const date of days) {
		const key = keyOf(date);
		const g = groups.get(key) || { players: 0, newPlayers: 0, peak: 0, sp: 0, mp: 0 };
		const d = stats.days[date];
		g.players += d[field];
		g.newPlayers += d.newPlayers;
		g.peak = Math.max(g.peak, d.peakOnline);
		g.sp += ev(d, "sp-game-started");
		g.mp += ev(d, "game-started") + ev(d, "game-started-quickmatch");
		groups.set(key, g);
	}
	console.log(title);
	console.log("  period     players   new  peak online    vs AI  online");
	for (const [key, g] of last([...groups], count))
		console.log("  " + key.padEnd(8) + pad(g.players, 10) + pad(g.newPlayers, 6) + pad(g.peak, 13) + pad(g.sp, 9) + pad(g.mp, 8));
	console.log();
}

rollup("Weeks (ISO, Monday to Sunday)", WEEKS, date => isoWeek(new Date(date + "T00:00:00Z")), "weekFirsts");
rollup("Months", MONTHS, date => date.slice(0, 7), "monthFirsts");

// When people play, so you know which hours Quick Match has a chance
const recent = days.slice(-7).map(date => stats.days[date]);
if (recent.length) {
	const byHour = new Array(24).fill(0).map((_, h) => Math.max(...recent.map(d => d.onlineByHour[h])));
	console.log("Peak online by UTC hour, last 7 days");
	console.log("  " + byHour.map((n, h) => `${pad(h, 2)}h ${pad(n, 3)}`).reduce((rows, cell, i) => {
		if (i % 6 === 0) rows.push([]);
		rows[rows.length - 1].push(cell);
		return rows;
	}, []).map(row => row.join("   ")).join("\n  "));
}
