// Player counts: starts its own relay on a spare port with a temporary stats
// file, sends visits and heartbeats like the game does, checks what players
// are shown (GET /presence), stops the relay and
// checks the daily totals it saved, then runs the report on them.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8766;
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwent-stats-'));
const FILE = path.join(dir, 'stats.json');

function assert(cond, label) {
	console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
	if (!cond) process.exitCode = 1;
}

const presence = () => fetch(`http://localhost:${PORT}/presence`).then(r => r.json());
// Connects and keeps every message, so none is missed between awaits
async function wsClient() {
	const ws = new WebSocket(`ws://localhost:${PORT}`);
	ws.inbox = [];
	ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
	ws.next = type => new Promise(res => {
		const look = () => {
			const i = ws.inbox.findIndex(m => m.type === type);
			if (i >= 0) return res(ws.inbox.splice(i, 1)[0]);
			setTimeout(look, 20);
		};
		look();
	});
	await new Promise(res => ws.on('open', res));
	return ws;
}
const post = body => fetch(`http://localhost:${PORT}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
	const relay = spawn('node', [path.join(ROOT, 'server', 'server.js')], { env: { ...process.env, PORT, STATS_FILE: FILE }, stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise(res => relay.stdout.on('data', d => { if (String(d).includes('server-start')) res(); }));

	await post({ type: 'visit', day: true, week: true, month: true, first: true });   // brand new player
	await post({ type: 'visit', day: true, week: false, month: false, first: false }); // back from last week
	await post({ type: 'visit', day: false, week: false, month: false, first: false }); // second visit today
	await post({ type: 'visit' });                                                     // storage blocked
	await post({ type: 'here' });
	await post({ type: 'sp-game-started' });
	await post({ type: 'visit', id: 'abc', day: 'yes' });                              // junk fields ignored
	await post({ type: 'here' });
	await post({ type: 'here' });
	await post({ type: 'here' });

	let p = await presence();
	assert(p.online === 9 && p.waiting === false && Object.keys(p).join() === 'online,waiting', 'presence counts the last 5 minutes of heartbeats: ' + JSON.stringify(p));

	// Closing or reloading a page takes its heartbeat back, matched by its age
	await post({ type: 'here' });
	await post({ type: 'bye', ago: 0 });
	p = await presence();
	assert(p.online === 9, 'a closed page stops counting at once: ' + JSON.stringify(p));
	await post({ type: 'bye', ago: 60000 });       // no heartbeat a minute old
	await post({ type: 'bye', ago: 'x' });
	await post({ type: 'bye', ago: 10 * 60000 });  // older than the window
	p = await presence();
	assert(p.online === 9, 'a bye matching no heartbeat changes nothing');

	const a = await wsClient();
	a.send(JSON.stringify({ type: 'quickmatch' }));
	await a.next('created');
	p = await presence();
	assert(p.waiting === true, 'presence: someone is waiting in Quick Match');

	const b = await wsClient();
	b.send(JSON.stringify({ type: 'quickmatch' }));
	await b.next('joined');
	p = await presence();
	assert(p.waiting === false, 'presence: paired, so nobody waiting');

	// A private room waiting for a friend isn't "waiting" for strangers
	const c = await wsClient();
	c.send(JSON.stringify({ type: 'create' }));
	await c.next('created');
	p = await presence();
	assert(p.waiting === false, 'presence: a private room does not count as waiting');

	relay.kill('SIGINT');
	await new Promise(res => relay.on('exit', res));

	const stats = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	const day = stats.days[new Date().toISOString().slice(0, 10)];
	assert(day, 'saved today\'s totals on SIGINT');
	assert(day.visits === 5, 'every page load counted: ' + day.visits);
	assert(day.players === 2 && day.weekFirsts === 1 && day.monthFirsts === 1 && day.newPlayers === 1, 'first-of-day/week/month flags added up');
	assert(day.peakOnline === 10 && day.onlineByHour[new Date().getUTCHours()] === 10 && stats.now && stats.now.online >= 8, 'peak online taken from the live count: ' + day.peakOnline);
	assert(day.noStorage === 1, 'visit without storage counted apart');
	assert(day.events['sp-game-started'] === 1 && day.events['game-started-quickmatch'] === 1, 'games counted by kind');
	assert(day.peakSockets === 3 && day.peakGames === 1, 'relay peaks sampled (3 connections, 1 match)');
	assert(!JSON.stringify(stats).includes('abc') && !/127\.0\.0\.1|::1/.test(JSON.stringify(stats)), 'no identifiers or IPs stored');

	// Restarting keeps the totals and adds to them
	const relay2 = spawn('node', [path.join(ROOT, 'server', 'server.js')], { env: { ...process.env, PORT, STATS_FILE: FILE }, stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise(res => relay2.stdout.on('data', d => { if (String(d).includes('server-start')) res(); }));
	await post({ type: 'visit', day: true, week: true, month: true, first: true });
	relay2.kill('SIGINT');
	await new Promise(res => relay2.on('exit', res));
	const after = JSON.parse(fs.readFileSync(FILE, 'utf8')).days[new Date().toISOString().slice(0, 10)];
	assert(after.visits === 6 && after.players === 3, 'totals survive a restart');

	const report = execFileSync('node', [path.join(ROOT, 'scripts', 'player-stats.js')], { env: { ...process.env, STATS_FILE: FILE } }).toString();
	assert(report.includes('Last 14 days') && report.includes('Weeks') && report.includes('Months'), 'report prints');

	fs.rmSync(dir, { recursive: true, force: true });
	a.terminate();
	b.terminate();
	c.terminate();
})();
