// End-to-end quickmatch test: pages find each other via the Find Opponent
// button. Covers pairing into the ready-up flow, the online count and
// "no one's around" fallback on the search screen, cancelling a search,
// and that a quickmatch pairing starts an actual match.
const { chromium } = require('playwright-core');

const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';
const errors = { A: [], B: [], C: [] };

function watch(page, tag) {
	page.on('pageerror', e => {
		const msg = String(e);
		if (/play\(\)|NotAllowedError|the user didn't interact/i.test(msg)) return; // headless audio
		errors[tag].push(e.stack || msg);
	});
	page.on('console', m => {
		if (m.type() !== 'error') return;
		const txt = m.text();
		if (/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(txt)) return;
		errors[tag].push(txt);
	});
}

let failed = false;
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}

async function waitFor(page, fn, label, timeout = 30000) {
	try {
		await page.waitForFunction(fn, null, { timeout });
		return true;
	} catch (e) {
		console.log('FAIL (timeout) ' + label);
		failed = true;
		return false;
	}
}

(async () => {
	const browser = await chromium.launch();
	const newPage = async tag => {
		const p = await (await browser.newContext()).newPage();
		watch(p, tag);
		await p.goto(URL);
		await p.waitForFunction(() => typeof lobby !== 'undefined');
		return p;
	};

	// --- A searches first and waits ---
	const A = await newPage('A');
	await A.click('#split-player');
	assert(await A.isVisible('#lobby-quick-button'), 'Find Opponent option shown in mp menu');
	await A.evaluate(() => { lobby.searchHintDelay = 500; }); // fast-forward the fallback hint
	await A.click('#lobby-quick-button');
	await waitFor(A, () => document.getElementById('search-status').textContent.startsWith('Searching'), 'A shows searching status');
	assert(await A.evaluate(() => Net.role === 'host' && Net.code !== null), 'A parked as waiting host');
	await waitFor(A, () => document.getElementById('search-online').textContent.includes('online'), 'A shows online count');
	assert(await A.evaluate(() => document.getElementById('search-online').textContent === 'No other players online right now'), 'A alone: count says no other players');
	await waitFor(A, () => document.getElementById('search-hint').textContent.startsWith("No one's around"), 'A fallback hint after waiting');

	// --- B searches and is paired with A ---
	const B = await newPage('B');
	await B.click('#split-player');
	await B.click('#lobby-quick-button');
	await waitFor(B, () => lobby.inMultiplayer, 'B paired and entered deck setup');
	await waitFor(A, () => lobby.inMultiplayer, 'A notified and entered deck setup');
	assert(await A.evaluate(() => Net.role === 'host' && lobby.searchHintTimer === null), 'A is host, search timer cleared');
	assert(await B.evaluate(() => Net.role === 'guest'), 'B is guest');
	assert((await A.textContent('#start-game')).trim() === 'Ready', 'A sees Ready button');
	assert((await B.textContent('#start-game')).trim() === 'Ready', 'B sees Ready button');

	// --- C searches (A+B are matched, so C waits), then cancels ---
	const C = await newPage('C');
	await C.click('#split-player');
	await C.click('#lobby-quick-button');
	await waitFor(C, () => document.getElementById('search-status').textContent.startsWith('Searching'), 'C waits, matched pair not re-paired');
	await C.click('#lobby-search .lobby-back');
	assert(await C.isVisible('#lobby-mp'), 'C back at mp menu after cancel');
	assert(await C.evaluate(() => Net.code === null && lobby.searchHintTimer === null), 'C left the room and cleared the search timer');

	// C searches again after cancelling: waits fresh, not trapped by the old room
	await C.click('#lobby-quick-button');
	await waitFor(C, () => document.getElementById('search-status').textContent.startsWith('Searching'), 'C searches again after cancel');
	await C.click('#lobby-search .lobby-back');

	// --- A + B ready up: a quickmatch pairing starts a real match ---
	await A.evaluate(() => { GameRNG.randomSeed = () => 1; });
	await A.evaluate(() => document.getElementById('start-game').click());
	await B.evaluate(() => document.getElementById('start-game').click());
	await waitFor(A, () => typeof game !== 'undefined' && game.state.val === 10, 'A match started');
	await waitFor(B, () => game.state.val === 10, 'B match started');

	assert(errors.A.length === 0, 'no js errors on A' + (errors.A.length ? ':\n' + errors.A.join('\n') : ''));
	assert(errors.B.length === 0, 'no js errors on B' + (errors.B.length ? ':\n' + errors.B.join('\n') : ''));
	assert(errors.C.length === 0, 'no js errors on C' + (errors.C.length ? ':\n' + errors.C.join('\n') : ''));

	await browser.close();
	console.log('RESULT: ' + (failed ? 'FAILURES' : 'ALL PASS'));
	process.exit(failed ? 1 : 0);
})();
