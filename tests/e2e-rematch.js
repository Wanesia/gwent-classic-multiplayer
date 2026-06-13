// Post-match flow: after an online game ends, both players return to the deck builder (still connected) and ready up again for a second match.
const { chromium } = require('playwright-core');
const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';

let failed = false;
const errors = { A: [], B: [] };
function assert(cond, label) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed = true; }
async function waitFor(page, fn, label, timeout = 60000) {
	try { await page.waitForFunction(fn, null, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}

async function passOutGame(pages) {
	for (const page of pages) {
		(async () => {
			for (let i = 0; i < 8; i++) {
				try {
					await page.waitForFunction(() => game.state.val === 100 || (game.currPlayer === player_me && !player_me.passed && !document.getElementsByTagName('main')[0].classList.contains('noclick')), null, { timeout: 60000 });
					if (await page.evaluate(() => game.state.val === 100)) return;
					await page.evaluate(() => document.getElementById('pass-button').click());
					await page.waitForTimeout(400);
				} catch (e) { return; }
			}
		})();
	}
	for (const page of pages)
		await page.waitForFunction(() => game.state.val === 100, null, { timeout: 90000 });
}

(async () => {
	const browser = await chromium.launch();
	const A = await (await browser.newContext()).newPage();
	const B = await (await browser.newContext()).newPage();
	for (const [tag, page] of [['A', A], ['B', B]]) {
		page.on('pageerror', e => { const m = String(e); if (!/play\(\)|NotAllowedError|user didn't interact/i.test(m)) errors[tag].push(m); });
		page.on('console', m => { if (m.type() === 'error' && !/ERR_|favicon|youtube|Audio|media/i.test(m.text())) errors[tag].push(m.text()); });
	}
	await A.goto(URL); await B.goto(URL);
	await A.click('#lobby-vs-player'); await A.click('#lobby-create-button');
	await A.waitForFunction(() => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent));
	const code = await A.textContent('#room-code');
	await B.click('#lobby-vs-player'); await B.click('#lobby-join-button');
	await B.fill('#join-code', code); await B.click('#join-button');
	await waitFor(A, () => lobby.inMultiplayer, 'host in deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'guest in deck setup');

	// quick match 1: ready, cancel redraws, pass out
	await A.evaluate(() => document.getElementById('start-game').click());
	await B.waitForFunction(() => lobby.remoteReady);
	await B.evaluate(() => document.getElementById('start-game').click());
	await waitFor(A, () => game.state.val === 10, 'match 1 started (host)');
	await waitFor(B, () => game.state.val === 10, 'match 1 started (guest)');
	await waitFor(A, () => Carousel.curr, 'host redraw'); await waitFor(B, () => Carousel.curr, 'guest redraw');
	await A.evaluate(() => Carousel.curr.cancel()); await B.evaluate(() => Carousel.curr.cancel());
	await passOutGame([A, B]);
	console.log('     match 1 finished');

	// host returns to the builder and re-readies WHILE guest is still on the
	// end screen — this lobby-ready must survive the guest's stale mp routing
	await A.evaluate(() => game.customize_elem.click());
	await waitFor(A, () => game.state.val === 0 && lobby.inMultiplayer && !mp.active, 'host back in builder, still connected');
	assert((await A.textContent('#start-game')).trim() === 'Ready', 'host button is Ready again');
	await A.evaluate(() => document.getElementById('start-game').click());
	await A.waitForTimeout(800); // ready lands while guest is on the end screen

	await B.evaluate(() => game.customize_elem.click());
	await waitFor(B, () => game.state.val === 0 && lobby.inMultiplayer, 'guest back in builder');
	assert(await B.evaluate(() => lobby.remoteReady), 'guest sees host ready (sent during end screen)');
	await B.evaluate(() => document.getElementById('start-game').click());

	// match 2 must start on both clients
	await waitFor(A, () => game.state.val === 10 && mp.active, 'match 2 started (host)');
	await waitFor(B, () => game.state.val === 10 && mp.active, 'match 2 started (guest)');
	await waitFor(A, () => Carousel.curr, 'match 2 redraw (host)');
	await waitFor(B, () => Carousel.curr, 'match 2 redraw (guest)');
	await A.evaluate(() => Carousel.curr.cancel()); await B.evaluate(() => Carousel.curr.cancel());
	await waitFor(A, () => game.roundCount === 1, 'match 2 round 1 (host)');
	await waitFor(B, () => game.roundCount === 1, 'match 2 round 1 (guest)');
	const sA = await A.evaluate(() => mp.checksum());
	const sB = await B.evaluate(() => mp.checksum());
	assert(sA === sB, 'match 2 state in sync (' + sA + ')');

	// voluntary mid-game exit: host leaves, guest gets notified, both reach the menu
	await A.evaluate(() => { game.exitGame(); Popup.curr.selectNo(); }); // popup: Resume=yes, Exit=no
	await waitFor(A, () => !document.getElementById('lobby').classList.contains('hide'), 'host back at main menu after exit');
	assert(await A.evaluate(() => !lobby.inMultiplayer && !mp.active), 'host fully out of multiplayer');
	await waitFor(B, () => !document.getElementById('popup').classList.contains('hide'), 'guest sees opponent-left popup');
	await B.evaluate(() => Popup.curr.selectYes());
	await waitFor(B, () => !document.getElementById('lobby').classList.contains('hide'), 'guest back at main menu');

	assert(errors.A.length === 0, 'no js errors on host' + (errors.A.length ? ': ' + errors.A.join(' | ') : ''));
	assert(errors.B.length === 0, 'no js errors on guest' + (errors.B.length ? ': ' + errors.B.join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
