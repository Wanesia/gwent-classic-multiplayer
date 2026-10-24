// AFK turns online: once a turn runs too long both players are told, the waiting
// one can pass the round for the AFK one, and the pass is the AFK client's own move.
const { chromium } = require('playwright-core');
const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';

let failed = false;
const errors = { A: [], B: [] };
function assert(cond, label) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed = true; }
async function waitFor(page, fn, label, timeout = 60000) {
	try { await page.waitForFunction(fn, null, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}
const myTurn = () => game.currPlayer === player_me && player_me.awaitingAction;

(async () => {
	const browser = await chromium.launch();
	const A = await (await browser.newContext()).newPage();
	const B = await (await browser.newContext()).newPage();
	for (const [tag, page] of [['A', A], ['B', B]]) {
		page.on('pageerror', e => { const m = String(e); if (!/play\(\)|NotAllowedError|user didn't interact/i.test(m)) errors[tag].push(m); });
		page.on('console', m => { if (m.type() === 'error' && !/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(m.text())) errors[tag].push(m.text()); });
	}
	for (const page of [A, B])
		await page.addInitScript(() => { window.shown = id => !document.getElementById(id).classList.contains('hide'); });
	await A.goto(URL); await B.goto(URL);
	await A.click('#split-player'); await A.click('#lobby-create-button');
	await A.waitForFunction(() => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent));
	const code = await A.textContent('#room-code');
	await B.click('#split-player'); await B.click('#lobby-join-button');
	await B.fill('#join-code', code);
	await waitFor(A, () => lobby.inMultiplayer, 'host in deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'guest in deck setup');

	await A.evaluate(() => document.getElementById('start-game').click());
	await B.waitForFunction(() => lobby.remoteReady);
	await B.evaluate(() => document.getElementById('start-game').click());
	await waitFor(A, () => game.state.val === 10, 'match started (host)');
	await waitFor(B, () => game.state.val === 10, 'match started (guest)');
	assert(await A.evaluate(() => lobby.peerAfk) && await B.evaluate(() => lobby.peerAfk), 'both clients announce AFK pass support');
	await waitFor(A, () => Carousel.curr, 'host redraw'); await waitFor(B, () => Carousel.curr, 'guest redraw');

	// Whoever moves first (decided by the coin toss, before the redraw) goes AFK.
	// The waiter's clock runs out well before the AFK player's own, so the
	// request must wait for the AFK client's clock.
	const afkIsA = await A.evaluate(() => game.firstPlayer === player_me);
	const [afk, waiter] = afkIsA ? [A, B] : [B, A];
	await afk.evaluate(() => AfkClock.TURN_MS = 8000);
	await waiter.evaluate(() => AfkClock.TURN_MS = 1500);
	await A.evaluate(() => Carousel.curr.cancel()); await B.evaluate(() => Carousel.curr.cancel());
	await waitFor(afk, myTurn, 'AFK player is on turn');

	await waitFor(waiter, () => shown('afk-op'), 'waiter sees the opponent is AFK', 15000);
	await waitFor(waiter, () => document.querySelector('#notification-bar > div').id === 'notif-op-afk', 'waiter gets the AFK banner too');
	assert(await waiter.evaluate(() => document.querySelector('#notification-bar > div').dataset.text === 'Your opponent has been AFK for too long'), 'waiter banner text');
	assert(!await waiter.evaluate(() => shown('afk-me')), 'waiter gets no AFK notice of their own');
	assert(!await afk.evaluate(() => shown('afk-me')), 'AFK player not told yet: their own clock is still running');
	await waiter.click('#afk-pass-op'); // a real click, while the board ignores clicks on the opponent's turn
	assert(!await waiter.evaluate(() => shown('afk-op')), 'the notice goes once the waiter asked');
	await afk.waitForTimeout(1500);
	assert(await afk.evaluate(() => !player_me.passed && player_me.awaitingAction), 'an early request does not pass before the AFK clock runs out');

	await waitFor(afk, () => player_me.passed, 'AFK player passed once their clock ran out', 15000);
	await waitFor(waiter, () => player_op.passed, 'waiter sees the AFK player pass');
	assert(await afk.evaluate(() => !shown('afk-me')) && await waiter.evaluate(() => !shown('afk-op')), 'notices gone after the pass');
	await waitFor(waiter, myTurn, 'waiter plays on');
	assert(await A.evaluate(() => mp.checksum()) === await B.evaluate(() => mp.checksum()), 'both boards agree after the AFK pass');

	// Waiter passes too: the round ends and the next one starts on someone's turn
	for (const page of [A, B])
		await page.evaluate(() => AfkClock.TURN_MS = 1000);
	await waiter.evaluate(() => document.getElementById('pass-button').click());
	await waitFor(A, () => game.roundCount === 2 && game.currPlayer && !player_me.passed && !player_op.passed, 'round 2 (host)');
	await waitFor(B, () => game.roundCount === 2 && game.currPlayer && !player_me.passed && !player_op.passed, 'round 2 (guest)');

	// Coming back in time: the AFK player sees the warning and banner, then acts,
	// and both notices go
	const p2 = (await A.evaluate(() => game.currPlayer === player_me)) ? A : B;
	const w2 = p2 === A ? B : A;
	await waitFor(p2, myTurn, 'round 2 turn');
	await waitFor(p2, () => shown('afk-me') && document.querySelector('#notification-bar > div').id === 'notif-me-afk', 'AFK player sees the notice and banner', 15000);
	await waitFor(w2, () => shown('afk-op'), 'waiter sees the round 2 notice', 15000);
	assert(await p2.evaluate(() => document.querySelector('#afk-me').textContent.includes("You've been AFK for too long.")), 'AFK notice text');
	await p2.click('#pass-button');
	await waitFor(p2, () => !shown('afk-me'), 'AFK notice gone once they act');
	await waitFor(w2, () => !shown('afk-op'), 'waiter notice gone once they act');
	await waitFor(w2, () => player_op.passed, 'their own pass arrives');
	assert(await A.evaluate(() => mp.checksum()) === await B.evaluate(() => mp.checksum()), 'both boards agree after the round 2 pass');

	// An opponent whose client predates pass requests never gets the warning
	assert(await A.evaluate(() => { lobby.peerAfk = false; AfkClock.start(player_op); const timed = AfkClock.side !== null; lobby.peerAfk = true; AfkClock.stop(); return !timed; }), 'no clock against an older client');

	assert(errors.A.length === 0, 'no js errors on host' + (errors.A.length ? ': ' + errors.A.join(' | ') : ''));
	assert(errors.B.length === 0, 'no js errors on guest' + (errors.B.length ? ': ' + errors.B.join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
