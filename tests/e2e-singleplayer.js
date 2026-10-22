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
		if (/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(m.text())) return;
		errors.push(m.text());
	});

	await page.goto(URL);
	await page.waitForFunction(() => typeof lobby !== 'undefined');
	await page.click('#split-computer');
	assert(await page.isHidden('#lobby'), 'lobby hidden after Vs Computer');
	assert(await page.isVisible('#deck-customization'), 'deck builder visible');
	assert((await page.textContent('#start-game')).trim() === 'Start game', 'start button label unchanged');
	assert(await page.isVisible('#mp-status'), 'status strip shown in single player');
	assert((await page.textContent('#mp-opponent-state')).trim() === 'vs Computer', 'status strip labels the mode "vs Computer"');
	assert(await page.isVisible('#opponent-preview'), 'opponent preview visible in single player');

	// Pin the RNG so the dealt hand is deterministic — otherwise the random deck
	// shuffle occasionally deals an opening hand with no plain unit to play below.
	await page.evaluate(() => { GameRNG.randomSeed = () => 1; });
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

		// The last round's board is left on the table under the results
		assert(await page.evaluate(() => {
			const last = game.roundHistory[game.roundHistory.length - 1];
			const sum = p => board.playerRows(p).reduce((a, r) => a + r.total, 0);
			return sum(player_me) === last.score_me && sum(player_op) === last.score_op;
		}), 'final board kept: row totals match the last round scores');
		assert(await page.evaluate(() => board.row.some(r => r.cards.length > 0)), 'final board still has cards on it');

		// Closing the results shows the board; Escape brings them back
		await page.click('#end-close');
		assert(await page.isHidden('#end-screen') && await page.evaluate(() => game.viewingBoard), 'X closes the results');
		assert(await page.getAttribute('#exit-game', 'data-title') === 'Back to results', 'exit button reads "Back to results" while viewing');
		const row = await page.evaluateHandle(() => board.row.find(r => r.cards.length > 0).elem);
		await row.click();
		await waitFor(page, () => Carousel.curr, 'clicking a row opens its cards');
		await page.keyboard.press('Escape');
		await waitFor(page, () => !Carousel.curr, 'Escape closes the card viewer');
		assert(await page.isHidden('#end-screen'), 'that Escape only closed the card viewer');
		await page.keyboard.press('Escape');
		assert(await page.isVisible('#end-screen') && await page.evaluate(() => !game.viewingBoard), 'second Escape brings the results back');
		assert(await page.getAttribute('#exit-game', 'data-title') === 'Exit game', 'exit button label restored');

		// A hand card can only be looked at, and the exit button also returns
		await page.click('#end-close');
		const handCard = await page.evaluateHandle(() => player_me.hand.cards[0]?.elem || null);
		if (await handCard.evaluate(e => !!e)) {
			const before = await page.evaluate(() => board.row.map(r => r.cards.length).join());
			await handCard.click();
			await waitFor(page, () => Carousel.curr, 'clicking a hand card opens it in the card viewer');
			assert(await page.evaluate(() => ui.previewCard === null), 'no placing preview after the match');
			await page.evaluate(() => Carousel.curr.select(new Event('click')));
			await page.waitForTimeout(300);
			assert(await page.evaluate(() => board.row.map(r => r.cards.length).join()) === before, 'the hand card cannot be played');
			await page.evaluate(() => Carousel.curr?.cancel());
		}
		await page.click('#exit-game');
		assert(await page.isVisible('#end-screen'), 'exit button brings the results back');

		// A new match started while the board is shown (an online rematch does
		// this) starts from a clean table
		await page.click('#end-close');
		await page.evaluate(() => game.rematchGame());
		await waitFor(page, () => game.state.val === 10 && game.roundCount === 0, 'rematch started');
		assert(await page.evaluate(() => !game.viewingBoard && board.row.every(r => r.cards.length === 0 && !r.special) && weather.cards.length === 0), 'rematch clears the kept board');
		assert(await page.getAttribute('#exit-game', 'data-title') === 'Exit game', 'rematch restores the exit button label');
		await waitFor(page, () => Carousel.curr, 'rematch redraw opened');
	}

	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
