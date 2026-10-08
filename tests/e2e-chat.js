// End-to-end quick chat test: chat is off by default, can be switched on
// mid-match, arrives translated into the receiver's language, is rate-limited
// and filtered on both ends, and never disturbs the lockstep game (the match
// is played out to the end screen with matching checksums).
const { chromium } = require('playwright-core');

const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';
const errors = { A: [], B: [] };

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

async function waitFor(page, fn, label, timeout = 30000, arg = null) {
	try {
		await page.waitForFunction(fn, arg, { timeout });
		return true;
	} catch (e) {
		console.log('FAIL (timeout) ' + label);
		failed = true;
		return false;
	}
}

const layerShown = page => page.evaluate(() => !document.getElementById('chat-layer').classList.contains('hide'));
const bubble = (page, who) => page.evaluate(w => {
	const b = document.getElementById('chat-bubble-' + w);
	return b.classList.contains('show') ? b.textContent : null;
}, who);

(async () => {
	const browser = await chromium.launch();
	const A = await (await browser.newContext()).newPage(); // host, English
	const bCtx = await browser.newContext();
	await bCtx.addInitScript(() => localStorage.setItem('lang', 'pl'));
	const B = await bCtx.newPage(); // guest, Polish
	watch(A, 'A'); watch(B, 'B');

	await A.goto(URL); await B.goto(URL);
	await A.waitForFunction(() => typeof lobby !== 'undefined');
	await B.waitForFunction(() => typeof lobby !== 'undefined');

	await A.click('#split-player');
	await A.click('#lobby-create-button');
	await waitFor(A, () => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent), 'host got room code');
	const code = await A.textContent('#room-code');
	await B.click('#split-player');
	await B.click('#lobby-join-button');
	await B.fill('#join-code', code);
	await waitFor(A, () => lobby.inMultiplayer, 'host entered deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'guest entered deck setup');

	await A.evaluate(() => { GameRNG.randomSeed = () => 1; });
	await A.evaluate(() => document.getElementById('start-game').click());
	await waitFor(B, () => lobby.remoteReady, 'guest sees host ready');
	await B.evaluate(() => document.getElementById('start-game').click());
	await waitFor(A, () => mp.active && game.state.val === 10, 'host game started');
	await waitFor(B, () => mp.active && game.state.val === 10, 'guest game started');

	assert(await A.evaluate(() => lobby.peerChat) && await B.evaluate(() => lobby.peerChat), 'both clients advertised chat support');

	// --- off by default ---
	assert(await A.evaluate(() => !Settings.quickChat.isEnabled()), 'quick chat is off by default');
	assert(!(await layerShown(A)) && !(await layerShown(B)), 'chat button hidden while chat is off');
	assert(await A.evaluate(() => document.getElementById('toggle-chat').classList.contains('fade')), 'settings toggle shows chat off');

	// --- opt in mid-match (during the redraw) via the settings toggle ---
	await waitFor(A, () => Carousel.curr, 'host redraw open');
	await A.click('#toggle-chat');
	await B.click('#toggle-chat');
	assert(await layerShown(A) && await layerShown(B), 'chat button appears after opting in');

	// --- sending through the real picker: hover opens it, click sends ---
	await A.hover('#chat-button');
	await waitFor(A, () => document.getElementById('chat-picker').classList.contains('open'), 'hover opens the picker');
	await A.click('#chat-picker [data-chat="goodLuck"]');
	assert(await A.evaluate(() => !document.getElementById('chat-picker').classList.contains('open')), 'picker closes after sending');
	assert(await bubble(A, 'me') === 'Good luck!', 'sender sees own bubble');
	await waitFor(B, () => document.getElementById('chat-bubble-op').classList.contains('show'), 'receiver gets a bubble');
	assert(await bubble(B, 'op') === 'Powodzenia!', 'receiver reads it in their own language: ' + await bubble(B, 'op'));

	await B.evaluate(() => QuickChat.send('wave'));
	await waitFor(A, () => document.getElementById('chat-bubble-op').textContent === '👋', 'emote arrives');

	// finish the redraw so the match proceeds
	await A.evaluate(() => Carousel.curr && Carousel.curr.cancel());
	await waitFor(B, () => Carousel.curr, 'guest redraw open');
	await B.evaluate(() => Carousel.curr.cancel());
	await waitFor(A, () => game.roundCount === 1 && game.currPlayer, 'round 1 started');

	// --- sender rate limit: a burst of 3, the rest dropped ---
	await B.evaluate(() => { window.chatSeen = 0; const show = QuickChat.show.bind(QuickChat); QuickChat.show = (w, id) => { if (w === 'op') window.chatSeen++; show(w, id); }; });
	await A.evaluate(() => { QuickChat.sendBucket.reset(); for (let i = 0; i < 6; i++) QuickChat.send('oops'); });
	await A.waitForTimeout(800);
	assert(await B.evaluate(() => window.chatSeen) === 3, 'only 3 of 6 rapid messages sent (got ' + await B.evaluate(() => window.chatSeen) + ')');
	assert(await A.evaluate(() => document.getElementById('chat-layer').classList.contains('chat-cooldown')), 'sender picker greyed out during cooldown');

	// --- receiver filtering: unknown ids and floods from a modified client ---
	await B.evaluate(() => { window.chatSeen = 0; QuickChat.recvBucket.reset(); });
	await A.evaluate(() => { mp.send({ t: 'chat', q: 'toString' }); mp.send({ t: 'chat', q: '<img src=x>' }); mp.send({ t: 'chat' }); });
	for (let i = 0; i < 8; i++) await A.evaluate(() => mp.send({ t: 'chat', q: 'bye' }));
	await A.waitForTimeout(800);
	assert(await B.evaluate(() => window.chatSeen) === 4, 'receiver ignores unknown ids and caps a flood at 4 (got ' + await B.evaluate(() => window.chatSeen) + ')');
	assert(await B.evaluate(() => mp.active), 'bad chat messages did not desync the match');

	// --- opting out: nothing shown, nothing sent ---
	await B.click('#toggle-chat');
	assert(!(await layerShown(B)), 'chat button hidden after opting out');
	await B.evaluate(() => { window.chatSeen = 0; QuickChat.recvBucket.reset(); });
	await A.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.send('hello'); });
	await A.waitForTimeout(500);
	assert(await B.evaluate(() => window.chatSeen) === 0, 'opted-out player receives nothing');
	await B.click('#toggle-chat');

	// --- an opponent on an older client: no chat UI ---
	await A.evaluate(() => { lobby.peerChat = false; QuickChat.refresh(); });
	assert(!(await layerShown(A)), 'no chat button against a client without chat support');
	await A.evaluate(() => { lobby.peerChat = true; QuickChat.refresh(); });

	// --- chat mid-turn, then play the match out: checksums must still agree ---
	const pages = { A, B };
	for (const [tag, page] of Object.entries(pages)) {
		(async () => {
			for (let i = 0; i < 8; i++) {
				try {
					await page.waitForFunction(
						() => game.state.val === 100 || (game.currPlayer === player_me && !player_me.passed && !document.getElementsByTagName('main')[0].classList.contains('noclick')),
						null, { timeout: 60000 });
					if (await page.evaluate(() => game.state.val === 100)) return;
					// the other player chats while this one is mid-turn
					const other = page === A ? B : A;
					await other.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.send('watchThis'); });
					await page.waitForTimeout(200);
					await page.evaluate(() => document.getElementById('pass-button').click());
					await page.waitForTimeout(500);
				} catch (e) { return; }
			}
		})();
	}
	const aEnd = await waitFor(A, () => game.state.val === 100, 'host reached end screen', 90000);
	const bEnd = await waitFor(B, () => game.state.val === 100, 'guest reached end screen', 90000);
	if (aEnd && bEnd) {
		assert(await A.evaluate(() => mp.checksum()) === await B.evaluate(() => mp.checksum()), 'final checksums match after chatting');

		// --- "gg" from the end screen ---
		assert(await layerShown(A), 'chat still available on the end screen');
		await A.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.send('goodGame'); });
		await waitFor(B, () => document.getElementById('chat-bubble-op').textContent === 'Dobra gra!', 'end-screen message arrives');
	}

	assert(errors.A.length === 0, 'no js errors on host' + (errors.A.length ? ': ' + errors.A.join(' | ') : ''));
	assert(errors.B.length === 0, 'no js errors on guest' + (errors.B.length ? ': ' + errors.B.join(' | ') : ''));

	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
