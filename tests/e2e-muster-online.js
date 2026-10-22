// Online muster: the called cards stay in the hand/deck until they fly, so check that
// both clients still resolve a muster identically (same rows, hands, deck order and
// checksums) and play the match out without a desync.
const { chromium } = require('playwright-core');

const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';
const errors = { A: [], B: [] };

function watch(page, tag) {
	page.on('pageerror', e => {
		const msg = String(e);
		if (/play\(\)|NotAllowedError|the user didn't interact/i.test(msg)) return;
		errors[tag].push(e.stack || msg);
	});
	page.on('console', m => {
		if (m.type() !== 'error') return;
		if (/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(m.text())) return;
		errors[tag].push(m.text());
	});
}

let failed = false;
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}
async function waitFor(page, fn, label, timeout = 30000, arg) {
	try { await page.waitForFunction(fn, arg, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}

(async () => {
	const browser = await chromium.launch();
	const A = await (await browser.newContext()).newPage(); // host
	const B = await (await browser.newContext()).newPage(); // guest
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
	await waitFor(A, () => typeof game !== 'undefined' && game.state.val === 10, 'host game started');
	await waitFor(B, () => game.state.val === 10, 'guest game started');
	await waitFor(A, () => Carousel.curr, 'host redraw carousel open');
	await waitFor(B, () => Carousel.curr, 'guest redraw carousel open');
	await A.evaluate(() => Carousel.curr.cancel());
	await B.evaluate(() => Carousel.curr.cancel());
	await waitFor(A, () => game.roundCount === 1 && game.currPlayer, 'host round 1 started');
	await waitFor(B, () => game.roundCount === 1 && game.currPlayer, 'guest round 1 started');

	const firstRole = await A.evaluate(() => mp.roleOf(game.firstPlayer));
	const P = firstRole === 'host' ? A : B; // plays Gaunter
	const O = P === A ? B : A;              // watches it on the opponent side
	await waitFor(P, () => game.currPlayer === player_me &&
		!document.getElementsByTagName('main')[0].classList.contains('noclick'), 'first player has the turn');

	// Give the first player Gaunter + 1 Darkness in hand and 2 in the deck, on both
	// clients: P adds them to its own side, O mirrors them onto its replica of P
	const handNames = await P.evaluate(() => {
		const pred = c => c.name.startsWith("Gaunter");
		const mk = n => new Card(card_dict.find(c => c.name === n), player_me);
		[player_me.hand, player_me.deck].forEach(con => con.cards.filter(pred).forEach(c => con.removeCard(c)));
		player_me.hand.addCard(mk("Gaunter O'Dimm"));
		player_me.hand.addCard(mk("Gaunter O'Dimm - Darkness"));
		player_me.deck.addCard(mk("Gaunter O'Dimm - Darkness"));
		player_me.deck.addCard(mk("Gaunter O'Dimm - Darkness"));
		return player_me.hand.cards.map(c => c.name);
	});
	await O.evaluate(handNames => {
		const pred = c => c.name.startsWith("Gaunter");
		const mk = n => new Card(card_dict.find(c => c.name === n), player_op);
		[player_op.hand, player_op.deck].forEach(con => con.cards.filter(pred).forEach(c => con.removeCard(c)));
		// same hand order as the owner's sorted hand, since plays are sent as hand indices
		const pool = player_op.hand.cards.concat([mk("Gaunter O'Dimm"), mk("Gaunter O'Dimm - Darkness")]);
		player_op.hand.cards = handNames.map(n => pool.splice(pool.findIndex(c => c.name === n), 1)[0]);
		player_op.hand.resize();
		player_op.deck.addCard(mk("Gaunter O'Dimm - Darkness"));
		player_op.deck.addCard(mk("Gaunter O'Dimm - Darkness"));
	}, handNames);

	const sideOfP = (page, mine) => page.evaluate(mine => {
		const p = mine ? player_me : player_op;
		return {
			hand: p.hand.cards.map(c => c.name).join('|'),
			deck: p.deck.cards.map(c => c.name).join('|'),
			rows: board.playerRows(p).map(r => r.cards.map(c => c.name).join('|')).join('/'),
		};
	}, mine);
	const before = [await sideOfP(P, true), await sideOfP(O, false)];
	assert(before[0].hand === before[1].hand && before[0].deck === before[1].deck, 'setup: both clients hold the same hand and deck order for the first player');

	// play Gaunter (selectRow ends the turn and waits on the opponent, so not awaited)
	await P.evaluate(() => {
		const g = player_me.hand.cards.find(c => c.name === "Gaunter O'Dimm");
		ui.selectCard(g);
		ui.selectRow(board.getRow(g, 'siege', player_me));
	});
	const mustered = mine => {
		const p = mine ? player_me : player_op;
		return board.playerRows(p).flatMap(r => r.cards).filter(c => c.name === "Gaunter O'Dimm - Darkness").length === 3;
	};
	await waitFor(P, mustered, 'first player: all 3 Darkness on the board', 30000, true);
	await waitFor(O, mustered, 'opponent client: all 3 Darkness on the board', 30000, false);
	// once the turn has passed, both clients have finished resolving it
	await waitFor(O, () => game.currPlayer === player_me, 'turn passed to the other player', 30000);
	await O.waitForTimeout(500);
	const after = [await sideOfP(P, true), await sideOfP(O, false)];
	assert(after[0].rows === after[1].rows, 'both clients show the same rows: ' + after[0].rows);
	assert(after[0].hand === after[1].hand && after[0].deck === after[1].deck, 'both clients agree on hand and deck order after the muster');
	assert(!/Darkness/.test(after[0].hand + after[0].deck), 'no Darkness left in hand or deck');
	const sums = [await P.evaluate(() => mp.checksum()), await O.evaluate(() => mp.checksum())];
	assert(sums[0] === sums[1], 'checksums match after the muster (' + sums[0] + ')');

	// pass out the match; a desync would end the game with a popup instead
	for (const page of [A, B]) {
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
	if (aEnd && bEnd)
		assert(await A.evaluate(() => mp.checksum()) === await B.evaluate(() => mp.checksum()), 'final checksums match');

	assert(errors.A.length === 0 && errors.B.length === 0, 'no page errors' +
		(errors.A.length + errors.B.length ? ':\n  ' + errors.A.concat(errors.B).join('\n  ') : ''));
	await browser.close();
	console.log(failed ? '\nONLINE MUSTER TEST FAILED' : '\nONLINE MUSTER TEST PASSED');
	process.exit(failed ? 1 : 0);
})();
