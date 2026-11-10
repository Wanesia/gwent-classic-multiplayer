// Restart notice (`make maintenance`): starts its own relay on a spare port
// with a temporary notice file, writes and removes the file like the Makefile
// does, and checks what players see: the relay frame for everyone connected,
// /presence for the lobby, the countdown at the top of the screen, cancelling,
// "restarting" once due, and the file gone (or ignored) after the restart.
// Off the lobby (deck builder vs computer) the banner asks every 30 seconds,
// so this takes about a minute.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');

const PORT = 8767;
const ROOT = path.join(__dirname, '..');
const URL = `http://localhost:8077/index.html?server=ws://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwent-maintenance-'));
const FILE = path.join(dir, 'maintenance.json');
const SHOTS = process.env.SHOTS; // folder for screenshots, if set
const errors = [];

let failed = false;
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}

async function waitFor(page, fn, label, timeout = 15000) {
	try {
		await page.waitForFunction(fn, null, { timeout });
		return true;
	} catch (e) {
		console.log('FAIL (timeout) ' + label);
		failed = true;
		return false;
	}
}

function watch(page) {
	page.on('pageerror', e => {
		if (/play\(\)|NotAllowedError|the user didn't interact/i.test(String(e))) return; // headless audio
		errors.push(String(e));
	});
}

function startRelay() {
	const relay = spawn('node', [path.join(ROOT, 'server', 'server.js')], {
		env: { ...process.env, PORT, STATS_FILE: path.join(dir, 'stats.json'), MAINTENANCE_FILE: FILE },
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	relay.log = '';
	relay.stdout.on('data', d => relay.log += d);
	relay.ready = new Promise(res => relay.stdout.on('data', d => { if (String(d).includes('server-start')) res(); }));
	return relay;
}

const stopRelay = relay => new Promise(res => { relay.on('exit', res); relay.kill('SIGINT'); });
const announce = ms => fs.writeFileSync(FILE, JSON.stringify({ at: Date.now() + ms }) + '\n');
const presence = () => fetch(`http://localhost:${PORT}/presence`).then(r => r.json());
const banner = page => page.evaluate(() => {
	const el = document.getElementById('maintenance');
	return el.classList.contains('hide') ? null : el.textContent;
});

// Connects and keeps every message, so none is missed between awaits
async function wsClient() {
	const ws = new WebSocket(`ws://localhost:${PORT}`);
	ws.inbox = [];
	ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
	ws.next = (type, timeout = 8000) => new Promise((res, rej) => {
		const until = Date.now() + timeout;
		const look = () => {
			const i = ws.inbox.findIndex(m => m.type === type);
			if (i >= 0) return res(ws.inbox.splice(i, 1)[0]);
			if (Date.now() > until) return rej(new Error('no ' + type));
			setTimeout(look, 20);
		};
		look();
	});
	await new Promise(res => ws.on('open', res));
	return ws;
}

let relay;
(async () => {
	relay = startRelay();
	await relay.ready;

	// ---------- nothing planned ----------
	const idle = await wsClient();
	assert(!('maintenanceIn' in await presence()), 'no notice: /presence as before');

	const browser = await chromium.launch();
	// Two players in an online room, joined through the game's own Net
	const host = await (await browser.newContext()).newPage();
	const guest = await (await browser.newContext()).newPage();
	for (const p of [host, guest]) {
		watch(p);
		await p.goto(URL);
		await p.waitForFunction(() => typeof Maintenance !== 'undefined' && Presence.counts !== null);
	}
	const code = await host.evaluate(async () => { await Net.connect(); return Net.createRoom(); });
	await guest.evaluate(async code => { await Net.connect(); await Net.joinRoom(code); }, code);
	assert(await banner(host) === null && await banner(guest) === null, 'no notice: no banner');
	// Off the lobby and not connected to the relay: only its own poll hears
	const builder = await (await browser.newContext()).newPage();
	watch(builder);
	await builder.goto(URL);
	await builder.waitForFunction(() => typeof lobby !== 'undefined');
	await builder.click('#split-computer');
	await builder.waitForFunction(() => Presence.view === null);

	// ---------- announced ----------
	announce(10 * 60 * 1000);
	const frame = await idle.next('maintenance');
	assert(frame.in > 9.5 * 60 * 1000 && frame.in <= 10 * 60 * 1000, `connected players are told within seconds (${frame.in} ms left)`);
	const p = await presence();
	assert(p.maintenanceIn > 9.5 * 60 * 1000, '/presence has the time left');
	const late = await wsClient();
	assert((await late.next('maintenance')).in > 9.5 * 60 * 1000, 'a player connecting later is told at once');

	await waitFor(host, () => !document.getElementById('maintenance').classList.contains('hide'), 'host in a room sees the banner');
	await waitFor(guest, () => !document.getElementById('maintenance').classList.contains('hide'), 'guest in a room sees the banner');
	assert(await banner(host) === 'Server restart in 10 min. Online matches will be cut off.', 'countdown text: ' + await banner(host));
	assert(await host.evaluate(() => getComputedStyle(document.getElementById('maintenance')).pointerEvents === 'none'), 'clicks go through the banner');
	await waitFor(builder, () => !document.getElementById('maintenance').classList.contains('hide'), 'deck builder vs computer sees the banner without reloading', 35000);
	assert(await builder.evaluate(() => !Net.connected), '... without connecting to the relay');

	// A player on the menu, not connected to the relay: the presence poll
	const lobby = await (await browser.newContext()).newPage();
	watch(lobby);
	await lobby.goto(URL);
	await waitFor(lobby, () => !document.getElementById('maintenance').classList.contains('hide'), 'player on the menu sees the banner (presence poll)');
	assert(await lobby.evaluate(() => !Net.connected), '... without connecting to the relay');
	if (SHOTS) await lobby.screenshot({ path: path.join(SHOTS, 'menu.png') });

	// Follows the language
	const german = await browser.newContext();
	await german.addInitScript(() => localStorage.setItem('lang', 'de'));
	const de = await german.newPage();
	watch(de);
	await de.goto(URL);
	await waitFor(de, () => !document.getElementById('maintenance').classList.contains('hide'), 'German player sees the banner');
	assert(await banner(de) === 'Serverneustart in 10 Min. Online-Partien werden abgebrochen.', 'in their language: ' + await banner(de));

	// ---------- cancelled ----------
	fs.rmSync(FILE);
	assert((await idle.next('maintenance')).in === null, 'cancelling tells connected players');
	await waitFor(host, () => document.getElementById('maintenance').classList.contains('hide'), 'cancelled: banner gone for players in a room');
	assert(!('maintenanceIn' in await presence()), 'cancelled: /presence as before');
	await lobby.evaluate(() => Presence.refresh());
	assert(await banner(lobby) === null, 'cancelled: banner gone on the menu after the next poll');
	await waitFor(builder, () => document.getElementById('maintenance').classList.contains('hide'), 'cancelled: banner gone in the deck builder without reloading', 35000);

	// ---------- due ----------
	announce(1500);
	await idle.next('maintenance');
	await waitFor(host, () => document.getElementById('maintenance').textContent.startsWith('The server is restarting'), 'once due: "restarting"', 8000);

	// In a match vs the computer: the banner over the board
	const sp = await (await browser.newContext()).newPage();
	watch(sp);
	await sp.goto(URL);
	await sp.waitForFunction(() => typeof lobby !== 'undefined');
	await sp.click('#split-computer');
	await sp.evaluate(() => document.getElementById('start-game').click());
	await waitFor(sp, () => game.state.val === 10, 'match vs computer started');
	await sp.evaluate(() => Maintenance.set(7 * 60 * 1000));
	assert(await sp.isVisible('#maintenance'), 'banner shown over the board');
	if (SHOTS) await sp.screenshot({ path: path.join(SHOTS, 'match.png') });
	await browser.close();

	// ---------- restarted ----------
	announce(10 * 60 * 1000);
	await idle.next('maintenance');
	await stopRelay(relay);
	assert(!fs.existsSync(FILE), 'stopping the server removes the notice');
	assert(/maintenance\s+at=/.test(relay.log) && /maintenance\s+cancelled=true/.test(relay.log), 'announcing and cancelling are logged');

	// A file left by a crash (time before the server started) is ignored
	fs.writeFileSync(FILE, JSON.stringify({ at: Date.now() - 1000 }));
	relay = startRelay();
	await relay.ready;
	assert(!('maintenanceIn' in await presence()), 'leftover notice from before the start is ignored');
	const fresh = await wsClient();
	await new Promise(res => setTimeout(res, 300));
	assert(!fresh.inbox.some(m => m.type === 'maintenance'), '... and not sent to players');
	await stopRelay(relay);
	const stats = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'));
	assert(!JSON.stringify(stats).includes('maintenance'), 'notices are not counted in the player stats');

	for (const ws of [idle, late, fresh]) ws.terminate();
	fs.rmSync(dir, { recursive: true, force: true });
	assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
	process.exit(failed ? 1 : 0);
})().catch(e => {
	console.error(e);
	if (relay) relay.kill('SIGINT');
	process.exit(1);
});
