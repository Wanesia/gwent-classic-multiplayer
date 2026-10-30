// End-to-end quickmatch test: pages find each other via the Find Opponent
// button. Covers pairing into the ready-up flow, the online count and
// "no one's around" fallback on the search screen, cancelling a search,
// the match-found alerts, and that a quickmatch pairing starts an actual match.
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
	const newPage = async (tag, init) => {
		const ctx = await browser.newContext();
		if (init)
			await ctx.addInitScript(init);
		const p = await ctx.newPage();
		watch(p, tag);
		await p.goto(URL);
		await p.waitForFunction(() => typeof lobby !== 'undefined');
		return p;
	};

	// --- A searches first and waits ---
	// Fake Notification API: the test answers the prompt
	const A = await newPage('A', () => {
		window.shown = [];
		window.answer = null;
		window.Notification = class {
			static permission = 'default';
			static requestPermission() {
				return new Promise(res => window.answer = p => { if (p !== 'default') Notification.permission = p; res(p); });
			}
			constructor(title, opts) { this.title = title; this.opts = opts; this.closed = false; shown.push(this); }
			close() { this.closed = true; }
		};
	});
	await A.click('#split-player');
	assert(await A.isVisible('#lobby-quick-button'), 'Find Opponent option shown in mp menu');
	await A.evaluate(() => { lobby.searchHintDelay = 500; }); // fast-forward the fallback hint
	await A.click('#lobby-quick-button');
	await waitFor(A, () => document.getElementById('search-status').textContent.startsWith('Searching'), 'A shows searching status');
	assert(await A.evaluate(() => Net.role === 'host' && Net.code !== null), 'A parked as waiting host');
	await waitFor(A, () => document.getElementById('search-online').textContent.includes('online'), 'A shows online count');
	assert(await A.evaluate(() => document.getElementById('search-online').textContent === 'No other players online right now'), 'A alone: count says no other players');
	await waitFor(A, () => document.getElementById('search-hint').textContent.startsWith("No one's around"), 'A fallback hint after waiting');

	// Match-found alerts
	assert(await A.evaluate(() => document.querySelector('#lobby-search .lobby-alert-box').checked), 'horn checkbox on by default');
	await A.evaluate(() => {
		window.horns = 0;
		window.hornVolumes = [];
		const play = MatchAlert.playSound.bind(MatchAlert);
		MatchAlert.playSound = () => { window.horns++; play(); hornVolumes.push(MatchAlert.sound.volume); };
		window.seenTitles = new Set();
		window.titleBeats = []; // icon state at each title change
		new MutationObserver(() => {
			seenTitles.add(document.title);
			titleBeats.push(document.querySelector("link[rel~='icon']").getAttribute('href').startsWith('data:'));
		}).observe(document.querySelector('title'), { childList: true });
		window.seenIcons = new Set();
		new MutationObserver(() => seenIcons.add(document.querySelector("link[rel~='icon']").getAttribute('href').slice(0, 22)))
			.observe(document.querySelector("link[rel~='icon']"), { attributes: true });
		window.originalTitle = document.title;
	});

	const volRow = sel => A.evaluate(sel => { const r = document.querySelector(sel + ' .lobby-alert-volume-row');
		return { value: r.querySelector('input').value, label: r.querySelector('.lobby-alert-volume-value').textContent,
			disabled: r.querySelector('input').disabled && r.querySelector('button').disabled }; }, sel);
	let row = await volRow('#lobby-search');
	assert(row.value === '80' && row.label === '80%' && !row.disabled, 'volume slider at 80% by default, enabled');
	await A.evaluate(() => { const s = document.querySelector('#lobby-search .lobby-alert-volume'); s.value = 40; s.dispatchEvent(new Event('input')); });
	row = await volRow('#lobby-create');
	assert(row.value === '40' && row.label === '40%' && await A.evaluate(() => localStorage.getItem('gc-match-alert-volume') === '40'), 'volume saved and shown on the other screen');
	await A.click('#lobby-search .lobby-alert-test');
	assert(await A.evaluate(() => horns === 1 && hornVolumes[0] === 0.4 && AudioManager.source.horn.volume === 1), 'Test plays at 40%, in-game horn volume untouched');
	await A.click('#lobby-search .lobby-alert-box');
	row = await volRow('#lobby-search');
	assert(row.disabled && await A.evaluate(() => document.querySelector('#lobby-search .lobby-alert-volume-row').classList.contains('off')), 'sound off: slider and Test disabled');
	await A.click('#lobby-search .lobby-alert-box');
	await A.evaluate(() => { window.horns = 0; window.hornVolumes = []; });

	const hint = () => A.evaluate(() => { const h = document.querySelector('#lobby-search .lobby-notify-hint'); return h.classList.contains('hide') ? null : h.textContent; });
	const notifyBox = () => A.evaluate(() => document.querySelector('#lobby-search .lobby-notify-box').checked);
	assert(await A.isVisible('#lobby-search .lobby-notify') && !(await notifyBox()) && await hint() === null, 'notification checkbox shown, off, no hint');
	await A.click('#lobby-search .lobby-notify-box');
	assert(await notifyBox() && (await hint()).startsWith('Your browser will ask'), 'asking: box ticked, hint says to choose Allow');
	await A.evaluate(() => answer('default'));
	await waitFor(A, () => !document.querySelector('#lobby-search .lobby-notify-hint').textContent.startsWith('Your browser'), 'prompt dismissed: hint changes');
	assert(!(await notifyBox()) && (await hint()).startsWith('The permission prompt was closed') && await A.evaluate(() => !Settings.matchNotify.isEnabled()),
		'prompt dismissed: box off, setting off, hint says to retry');
	await A.click('#lobby-search .lobby-notify-box');
	await A.evaluate(() => answer('denied'));
	await waitFor(A, () => document.querySelector('#lobby-search .lobby-notify-hint').textContent.startsWith('Notifications are blocked'), 'denied: hint explains how to unblock');
	assert(!(await notifyBox()) && await A.evaluate(() => Settings.matchNotify.isEnabled()
		&& document.querySelector('#lobby-create .lobby-notify-hint').textContent.startsWith('Notifications are blocked')), 'denied: box off, setting kept, both screens show the hint');
	await A.evaluate(() => { Notification.permission = 'granted'; window.dispatchEvent(new Event('focus')); });
	assert(await notifyBox() && await hint() === null, 'allowed in site settings: box ticks itself on return, hint gone');

	await A.evaluate(() => { document.hasFocus = () => false; });

	// --- B searches and is paired with A ---
	const B = await newPage('B');
	await B.click('#split-player');
	await B.evaluate(() => { window.horns = 0; const play = MatchAlert.playSound.bind(MatchAlert); MatchAlert.playSound = () => { horns++; play(); }; });
	await B.click('#lobby-quick-button');
	await waitFor(B, () => lobby.inMultiplayer, 'B paired and entered deck setup');
	await waitFor(A, () => lobby.inMultiplayer, 'A notified and entered deck setup');
	assert(await A.evaluate(() => Net.role === 'host' && lobby.searchHintTimer === null), 'A is host, search timer cleared');
	assert(await B.evaluate(() => Net.role === 'guest'), 'B is guest');
	assert((await A.textContent('#start-game')).trim() === 'Ready', 'A sees Ready button');
	assert((await B.textContent('#start-game')).trim() === 'Ready', 'B sees Ready button');

	assert(await A.evaluate(() => window.horns === 1 && hornVolumes[0] === 0.4), 'A hears the horn once, at the chosen volume');
	assert(await B.evaluate(() => horns === 0 && MatchAlert.timer === null), 'B, paired at once, gets no alert');
	assert(await A.evaluate(() => shown.length === 1 && shown[0].title === 'Opponent found!'
		&& shown[0].opts.body === 'Come back to the game and press Ready.' && shown[0].opts.silent === true), 'A gets one desktop notification, silent beside the horn');
	await waitFor(A, () => seenTitles.has('Opponent found!') && seenTitles.has(originalTitle) && titleBeats.length >= 3, 'A tab title flashes');
	assert(await A.evaluate(() => titleBeats.every(red => red)), 'A title only changes when the icon turns red');
	await A.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
	assert(await A.evaluate(() => seenIcons.has('data:image/png;base64,') && seenIcons.has('/favicon.ico')), 'A tab icon blinks red');
	assert(await A.evaluate(() => MatchAlert.timer === null && document.title === originalTitle), 'A title restored on return');
	assert(await A.evaluate(() => document.querySelector("link[rel~='icon']").getAttribute('href') === '/favicon.ico'
		&& document.querySelector("meta[name='theme-color']").content === '#0d0d0d'), 'A tab icon and colour restored on return');
	assert(await A.evaluate(() => shown[0].closed), 'A notification closed on return');

	await A.evaluate(() => { const b = document.querySelector('#lobby-create .lobby-alert-box'); b.click(); });
	assert(await A.evaluate(() => !Settings.matchAlert.isEnabled() && !document.querySelector('#lobby-search .lobby-alert-box').checked
		&& localStorage.getItem('gc-match-alert') === 'false'), 'horn off: saved, both checkboxes unticked');
	await A.evaluate(() => { document.hasFocus = () => false; MatchAlert.fire(); });
	assert(await A.evaluate(() => window.horns === 1 && MatchAlert.timer !== null), 'horn off: no horn, title still flashes');
	await A.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); Settings.matchAlert.enable(); });

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
