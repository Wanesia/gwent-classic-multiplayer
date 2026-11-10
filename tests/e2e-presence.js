// Who is around, as players see it: the online count on every lobby screen,
// "someone is looking for an opponent" on the main menu and Vs Player screen
// only (clicking it pairs at once), and reloads not adding players.
const { chromium } = require('playwright-core');
const WebSocket = require('ws');

const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';
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

// A player waiting in Quick Match, without a browser: a heartbeat like the
// game's, then a search
async function waitingPlayer() {
	await fetch('http://localhost:8765/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'here' }) });
	const ws = new WebSocket('ws://localhost:8765');
	ws.inbox = [];
	ws.on('message', raw => ws.inbox.push(JSON.parse(raw)));
	await new Promise(res => ws.on('open', res));
	ws.send(JSON.stringify({ type: 'quickmatch' }));
	while (!ws.inbox.some(m => m.type === 'created'))
		await new Promise(res => setTimeout(res, 20));
	return ws;
}

(async () => {
	const browser = await chromium.launch();

	// ---------- nobody waiting ----------
	const A = await (await browser.newContext()).newPage();
	watch(A);
	const beats = [];
	A.on('request', r => { if (r.url().endsWith('/event')) beats.push(JSON.parse(r.postData())); });
	await A.goto(URL);
	await waitFor(A, () => Presence.counts !== null, 'A: menu got the counts');
	assert(await A.evaluate(() => document.querySelector('#menu-presence .presence-waiting').offsetParent === null), 'nobody waiting: no "looking for an opponent"');
	assert(await A.evaluate(() => {
		const el = document.getElementById('menu-presence');
		return Presence.counts.online < 2 ? el.classList.contains('hide') : /^Online: \d+$/.test(el.querySelector('.presence-count').textContent);
	}), 'online count hidden when alone, "Online: n" otherwise');
	assert(beats.length && beats[0].type === 'visit' && !('state' in beats[0]) && !('id' in beats[0]), 'visit sends no ID or screen');

	// Reloading doesn't add players: the old page takes its heartbeat back
	const before = (await (await fetch('http://localhost:8765/presence')).json()).online;
	for (let i = 0; i < 3; i++) {
		await A.reload();
		await A.waitForFunction(() => Presence.counts !== null);
	}
	const after = (await (await fetch('http://localhost:8765/presence')).json()).online;
	assert(after <= before, `three reloads don't add players (${before} before, ${after} after)`);

	// Heartbeats: just "here", about every 5 minutes
	beats.length = 0;
	await A.evaluate(() => { Stats.lastBeat = 0; Stats.heartbeat(); });
	await new Promise(res => setTimeout(res, 300));
	assert(beats.length === 1 && JSON.stringify(beats[0]) === '{"type":"here"}', 'heartbeat carries nothing but its type');
	await A.evaluate(() => { Stats.heartbeat(); });
	await new Promise(res => setTimeout(res, 300));
	assert(beats.length === 1, 'no second heartbeat right after');

	// ---------- someone waiting ----------
	const X = await waitingPlayer();
	const B = await (await browser.newContext()).newPage();
	watch(B);
	await B.goto(URL);
	await waitFor(B, () => !document.getElementById('menu-presence').classList.contains('hide')
		&& !document.querySelector('#menu-presence .presence-waiting').classList.contains('hide'), 'B: menu says someone is looking for an opponent');
	assert(await B.evaluate(() => /^Online: \d+$/.test(document.querySelector('#menu-presence .presence-count').textContent) && Presence.counts.online >= 2), 'menu shows the online count, B and the waiting player included');
	assert(await B.evaluate(() => document.querySelector('#menu-presence .presence-waiting').textContent.includes('Someone is looking for an opponent')), 'text of the waiting line');
	assert(await B.evaluate(() => [...document.querySelectorAll('#menu-presence .presence-waiting, #menu-presence .presence-waiting *')]
		.every(e => getComputedStyle(e).cursor === 'pointer')), 'the whole button shows the pointer cursor, text and "Play Now" included');

	await B.click('#split-player');
	await waitFor(B, () => Presence.view === 'lobby-mp', 'B: on the Vs Player screen');
	assert(await B.isVisible('#menu-presence .presence-waiting') && await B.isVisible('#menu-presence .presence-count'), 'Vs Player screen: online count and "looking for an opponent" too');
	assert((await B.textContent('#lobby-quick-button')).includes('vs Random Player'), 'the Quick Match option itself stays as usual');

	// Waiting for a friend: the count stays, the offer goes
	await B.click('#lobby-create-button');
	await waitFor(B, () => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent), 'B: room created');
	await waitFor(B, () => Presence.view === 'lobby-create' && Presence.counts !== null, 'B: counts asked on the room screen');
	assert(await B.isVisible('#menu-presence .presence-count') && await B.isHidden('#menu-presence .presence-waiting'), 'room screen: online count shown, no "looking for an opponent"');
	await B.click('#lobby-create .lobby-back');
	await waitFor(B, () => !document.querySelector('#menu-presence .presence-waiting').classList.contains('hide'), 'B: back on Vs Player, the offer is back');

	// Back on the menu the stale answer isn't shown while the fresh one loads
	await B.click('#lobby-mp .lobby-back');
	await waitFor(B, () => Presence.counts !== null && Presence.counts.waiting, 'B: menu asked again on coming back');

	// Clicking it pairs at once
	await B.click('#menu-presence .presence-waiting-cta');
	await waitFor(B, () => lobby.inMultiplayer && Net.role === 'guest', 'B: clicking "looking for an opponent" pairs with the waiting player');
	await new Promise(res => setTimeout(res, 300));
	assert(X.inbox.some(m => m.type === 'peer-joined'), 'the waiting player got their opponent');
	assert(await B.isHidden('#menu-presence'), 'in the deck setup of an online match: no lobby count');

	// Searching yourself: the count stays, the offer (which would be you) doesn't show
	const C = await (await browser.newContext()).newPage();
	watch(C);
	await C.goto(URL);
	await C.click('#split-player');
	await C.click('#lobby-quick-button');
	await waitFor(C, () => document.getElementById('search-status').textContent.startsWith('Searching'), 'C: searching');
	await C.evaluate(() => Presence.refresh());
	assert(await C.evaluate(() => Presence.counts.waiting === true && Presence.counts.online >= 2), 'C is the one waiting now');
	assert(await C.isVisible('#menu-presence .presence-count') && await C.isHidden('#menu-presence .presence-waiting'), 'search screen: online count shown, no "looking for an opponent"');

	X.terminate();
	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
