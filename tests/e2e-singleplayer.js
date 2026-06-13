// Single-player test Vs Computer must work exactly as before the multiplayer changes (seeded RNG paths, atomic draw, controller gating).
const { chromium } = require('playwright-core');
const URL = 'http://localhost:8077/index.html';

let failed = false;
const errors = [];
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}
async function waitFor(page, fn, label, timeout = 30000) {
	try { await page.waitForFunction(fn, null, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	page.on('pageerror', e => {
		const msg = String(e);
		if (/play\(\)|NotAllowedError|user didn't interact/i.test(msg)) return;
		errors.push(e.stack || msg);
	});
	page.on('console', m => {
		if (m.type() !== 'error') return;
		if (/ERR_|favicon|youtube|Audio|media/i.test(m.text())) return;
		errors.push(m.text());
	});

	await page.goto(URL);
	await page.waitForFunction(() => typeof lobby !== 'undefined');
	await page.click('#lobby-vs-computer');
	assert(await page.isHidden('#lobby'), 'lobby hidden after Vs Computer');
	assert(await page.isVisible('#deck-customization'), 'deck builder visible');
	assert((await page.textContent('#start-game')).trim() === 'Start game', 'start button label unchanged');
	assert(await page.isHidden('#mp-status'), 'no mp status strip in single player');
	assert(await page.isVisible('#opponent-preview'), 'opponent preview visible in single player');

	await page.evaluate(() => document.getElementById('start-game').click());
	await waitFor(page, () => game.state.val === 10, 'game started vs AI');
	assert(await page.evaluate(() => !mp.active), 'mp session inactive');
	assert(await page.evaluate(() => player_op.controller instanceof ControllerAI), 'opponent is the AI');

	await waitFor(page, () => typeof Carousel !== 'undefined' && Carousel.curr, 'redraw carousel open');
	// swap one card, then close
	await page.evaluate(() => Carousel.curr.select(new Event('click')));
	await page.waitForTimeout(800);
	await page.evaluate(() => Carousel.curr && Carousel.curr.cancel());

	await waitFor(page, () => game.roundCount === 1 && game.currPlayer, 'round 1 started');
	assert(await page.evaluate(() => player_me.hand.cards.length === 10 && player_op.hand.cards.length === 10), 'both hands have 10 cards after redraw swap');
	assert(await page.evaluate(() => player_me.deck.cards.length === player_me.deck_data.cards.reduce((a, c) => a + Number(c.count), 0) - 10), 'player deck count consistent');

	// play one card when possible, then pass every turn until the game ends
	let playedCard = null;
	for (let i = 0; i < 12 && !playedCard; i++) {
		const myTurn = await waitFor(page, () =>
			game.state.val === 100 || (game.currPlayer === player_me && !player_me.passed &&
				!document.getElementsByTagName('main')[0].classList.contains('noclick')), 'turn or game end', 90000);
		if (!myTurn || await page.evaluate(() => game.state.val === 100)) break;
		playedCard = await page.evaluate(async () => {
			const card = player_me.hand.cards.find(c => c.isUnit() && !c.hero && c.abilities.length === 0 && ["close", "ranged", "siege"].includes(c.row));
			if (!card) return null;
			ui.selectCard(card);
			await ui.selectRow(board.getRow(card, card.row, player_me));
			return card.name;
		});
		if (!playedCard) break;
	}
	assert(playedCard !== null, 'played a unit card vs AI: ' + playedCard);

	for (let i = 0; i < 10; i++) {
		const ok = await waitFor(page, () =>
			game.state.val === 100 || (game.currPlayer === player_me && !player_me.passed &&
				!document.getElementsByTagName('main')[0].classList.contains('noclick')), 'turn or game end', 120000);
		if (!ok) break;
		if (await page.evaluate(() => game.state.val === 100)) break;
		await page.evaluate(() => document.getElementById('pass-button').click());
		await page.waitForTimeout(600);
	}

	const ended = await waitFor(page, () => game.state.val === 100, 'game vs AI reached end screen', 180000);
	if (ended) {
		assert(await page.evaluate(() => !game.rematch_elem.classList.contains('hide')), 'rematch button visible in single player');
		assert(await page.evaluate(() => !game.newGame_elem.classList.contains('hide')), 'new game button visible in single player');
		// AI actually played cards (its grave/board/hand changed)
		assert(await page.evaluate(() => game.roundHistory.some(r => r.score_op > 0)), 'AI scored points during the game');
		// rematch works (exercises GameRNG.reset + player reset path)
		await page.evaluate(() => game.rematch_elem.click());
		await waitFor(page, () => game.state.val === 10 && game.roundCount === 0, 'rematch started');
		await waitFor(page, () => Carousel.curr, 'rematch redraw opened');
	}

	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
