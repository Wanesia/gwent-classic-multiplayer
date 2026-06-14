// End-to-end multiplayer test: two headless browser pages connect through the
// relay server, ready up, and play a full online match (one real card play +
// passes) to the end screen. Lockstep checksums run after every turn, so any
// state divergence fails the test via the desync popup.
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
		if (/ERR_|favicon|youtube|Audio|media/i.test(txt)) return; // offline iframe api, audio
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
	const A = await (await browser.newContext()).newPage(); // host
	const B = await (await browser.newContext()).newPage(); // guest
	watch(A, 'A'); watch(B, 'B');

	await A.goto(URL); await B.goto(URL);
	await A.waitForFunction(() => typeof lobby !== 'undefined');
	await B.waitForFunction(() => typeof lobby !== 'undefined');

	assert(await A.isVisible('#lobby-mode'), 'lobby menu shown on load');

	// --- lobby: create + join ---
	await A.click('#split-player');
	await A.click('#lobby-create-button');
	await waitFor(A, () => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent), 'host got room code');
	const code = await A.textContent('#room-code');
	console.log('     room code: ' + code);

	await B.click('#split-player');
	await B.click('#lobby-join-button');
	await B.fill('#join-code', code); // a full 5-char code auto-submits via the input handler

	await waitFor(A, () => lobby.inMultiplayer, 'host entered deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'guest entered deck setup');
	assert(await A.isVisible('#mp-status'), 'host sees mp status strip');
	assert((await B.textContent('#start-game')).trim() === 'Ready', 'start button relabeled Ready');

	// --- ready up (host first, then guest) ---
	await A.evaluate(() => document.getElementById('start-game').click());
	await waitFor(B, () => lobby.remoteReady, 'guest sees host ready');
	await B.evaluate(() => document.getElementById('start-game').click());

	// --- match starts on both ---
	await waitFor(A, () => typeof game !== 'undefined' && game.state.val === 10, 'host game started');
	await waitFor(B, () => game.state.val === 10, 'guest game started');
	assert(await A.evaluate(() => mp.active && mp.role === 'host'), 'host mp session active');
	assert(await B.evaluate(() => mp.active && mp.role === 'guest'), 'guest mp session active');

	// decks were exchanged: both clients agree on each side's deck sizes
	await waitFor(A, () => player_me.hand.cards.length === 10 && player_op.hand.cards.length === 10, 'host: both hands dealt');
	await waitFor(B, () => player_me.hand.cards.length === 10 && player_op.hand.cards.length === 10, 'guest: both hands dealt');

	// --- redraw: swap one card on the host, none on the guest ---
	await waitFor(A, () => Carousel.curr, 'host redraw carousel open');
	await waitFor(B, () => Carousel.curr, 'guest redraw carousel open');
	await A.evaluate(() => Carousel.curr.select(new Event('click')));
	await A.evaluate(() => Carousel.curr && Carousel.curr.cancel());
	await B.evaluate(() => Carousel.curr.cancel());

	// barrier: both proceed to round 1
	await waitFor(A, () => game.roundCount === 1 && game.currPlayer, 'host round 1 started');
	await waitFor(B, () => game.roundCount === 1 && game.currPlayer, 'guest round 1 started');

	// host's redraw swap must be mirrored in the guest's replica of the host hand
	const handsMatch = async () => {
		const aHand = await A.evaluate(() => player_me.hand.cards.map(c => c.name));
		const bView = await B.evaluate(() => player_op.hand.cards.map(c => c.name));
		return JSON.stringify(aHand) === JSON.stringify(bView);
	};
	assert(await handsMatch(), 'host hand identical on both clients after redraw');

	// coin toss agrees (host-first on A must equal op-first... i.e. same logical player)
	const firstA = await A.evaluate(() => mp.roleOf(game.firstPlayer));
	const firstB = await B.evaluate(() => mp.roleOf(game.firstPlayer));
	assert(firstA === firstB, 'both clients agree who goes first (' + firstA + ')');

	// --- play one real unit card from whoever goes first, then pass out the game ---
	const pages = { A, B };
	const firstPage = pages[firstA === 'host' ? 'A' : 'B'];
	const otherPage = firstPage === A ? B : A;

	// wait until the turn has actually started (player input enabled) — acting
	// during the round-start notifications is impossible for a real user
	await waitFor(firstPage, () => game.currPlayer === player_me
		&& !document.getElementsByTagName('main')[0].classList.contains('noclick'), 'first player has the turn');
	const played = await firstPage.evaluate(async () => {
		const card = player_me.hand.cards.find(c =>
			c.isUnit() && !c.hero && c.abilities.length === 0 &&
			["close", "ranged", "siege"].includes(c.row));
		if (!card) return null;
		ui.selectCard(card);
		await ui.selectRow(board.getRow(card, card.row, player_me));
		return card.name;
	});
	assert(played !== null, 'first player played a unit card: ' + played);

	// the play must replicate to the other client's board
	await waitFor(otherPage, () =>
		board.row.slice(0, 3).some(r => r.cards.length > 0), 'card appeared on opponent side of other client');

	// now both players pass until the game ends (checksums run every turn)
	for (const [tag, page] of Object.entries(pages)) {
		(async () => {
			for (let i = 0; i < 8; i++) {
				try {
					await page.waitForFunction(
						() => game.state.val === 100 || (game.currPlayer === player_me && !player_me.passed && !document.getElementsByTagName('main')[0].classList.contains('noclick')),
						null, { timeout: 60000 });
					if (await page.evaluate(() => game.state.val === 100)) return;
					await page.evaluate(() => document.getElementById('pass-button').click());
					await page.waitForTimeout(500);
				} catch (e) { return; }
			}
		})();
	}

	const aEnd = await waitFor(A, () => game.state.val === 100, 'host reached end screen', 90000);
	const bEnd = await waitFor(B, () => game.state.val === 100, 'guest reached end screen', 90000);

	if (aEnd && bEnd) {
		// final cross-check: explicit state checksums identical
		const sumA = await A.evaluate(() => mp.checksum());
		const sumB = await B.evaluate(() => mp.checksum());
		assert(sumA === sumB, 'final state checksums match (' + sumA + ')');
		// winner agreement: host's view of winner role == guest's view
		const winA = await A.evaluate(() => player_me.health > 0 ? mp.roleOf(player_me) : (player_op.health > 0 ? mp.roleOf(player_op) : 'draw'));
		const winB = await B.evaluate(() => player_me.health > 0 ? mp.roleOf(player_me) : (player_op.health > 0 ? mp.roleOf(player_op) : 'draw'));
		assert(winA === winB, 'both clients agree on the outcome: ' + winA);
		assert(await A.evaluate(() => game.rematch_elem.classList.contains('hide')), 'rematch button hidden online');
	}

	// --- disconnect handling: guest closes, host gets notified ---
	await B.close();
	await waitFor(A, () => !document.getElementById('popup').classList.contains('hide'), 'host sees disconnect popup');
	const popupTitle = await A.evaluate(() => document.querySelector('#popup h3').textContent);
	assert(/Disconnected/i.test(popupTitle), 'popup says opponent disconnected: "' + popupTitle + '"');
	await A.evaluate(() => Popup.curr.selectYes());
	await waitFor(A, () => !document.getElementById('lobby').classList.contains('hide'), 'host returned to main menu');

	assert(errors.A.length === 0, 'no js errors on host' + (errors.A.length ? ': ' + errors.A.join(' | ') : ''));
	assert(errors.B.length === 0, 'no js errors on guest' + (errors.B.length ? ': ' + errors.B.join(' | ') : ''));

	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
