// The redraw before the first round: a card sent back can't come straight back
// and goes under the deck, for the player and the computer alike.
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:8077/index.html';

let failed = false;
const errors = [];
function assert(cond, label) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed = true; }
async function waitFor(page, fn, label, timeout = 30000, arg) {
	try { await page.waitForFunction(fn, arg, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}

// Starts a match against the computer and waits for the redraw
async function start(page, faction, seed) {
	await page.evaluate(({ faction, seed }) => {
		GameRNG.randomSeed = () => seed;
		GameSpeed.factor = 0.05;
		dm.loadFactionDeck(faction, true);
		// Scoia'tael choose who goes first before the redraw
		window.firstPicker = setInterval(() => Popup.curr?.selectYes(), 50);
		document.getElementById('start-game').click();
	}, { faction, seed });
	await waitFor(page, () => Carousel.curr, faction + ' redraw open');
	await page.evaluate(() => clearInterval(window.firstPicker));
}

// Sends back the card at this position of the carousel
async function pick(page, index) {
	const name = await page.evaluate(index => {
		const c = Carousel.curr;
		c.index = index;
		c.update();
		window.picked = c.container.cards[c.indices[c.index]];
		c.select(new Event('click'));
		return window.picked.name;
	}, index);
	await waitFor(page, () => player_me.deck.cards.at(-1) === window.picked, name + ' under the deck');
}

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	page.on('pageerror', e => { const m = String(e); if (!/play\(\)|NotAllowedError|user didn't interact/i.test(m)) errors.push(e.stack || m); });
	await page.goto(BASE);
	await page.waitForFunction(() => typeof lobby !== 'undefined' && typeof Replay !== 'undefined');
	await page.click('#split-computer');

	await page.evaluate(() => {
		window.swaps = [];
		const swap = Deck.prototype.swap;
		Deck.prototype.swap = function (container, card) {
			const before = this.cards.slice();
			swap.call(this, container, card);
			window.swaps.push({
				who: this === player_me.deck ? 'me' : 'op',
				topDrawn: container.cards.includes(before[0]),
				sentBack: !container.cards.includes(card),
				underDeck: this.cards.at(-1) === card,
				restInOrder: this.cards.slice(0, -1).every((c, i) => c === before[i + 1]),
				sameSize: this.cards.length === before.length,
			});
		};
	});

	// ---------- two redraws, step by step ----------
	await start(page, 'realms', 3);
	await page.evaluate(() => { window.deck0 = player_me.deck.cards.slice(); window.hand0 = player_me.hand.cards.slice(); });
	await pick(page, 0);
	assert(await page.evaluate(() => player_me.hand.cards.includes(window.deck0[0])), 'first redraw takes the top card');
	assert(await page.evaluate(() => !player_me.hand.cards.includes(window.picked)), 'the card sent back left the hand');
	assert(await page.evaluate(() => player_me.deck.cards.slice(0, -1).every((c, i) => c === window.deck0[i + 1])), 'the rest of the deck kept its order');
	await page.evaluate(() => { window.first = window.picked; });
	await waitFor(page, () => Carousel.curr && !Carousel.curr.selecting, 'second redraw open');
	await pick(page, 1);
	assert(await page.evaluate(() => player_me.hand.cards.includes(window.deck0[1])), 'second redraw takes the next card');
	assert(await page.evaluate(() => !player_me.hand.cards.includes(window.first) && !player_me.hand.cards.includes(window.picked)), 'neither card came back');
	assert(await page.evaluate(() => player_me.deck.cards.at(-2) === window.first), 'the first card sent back stays above the second');
	const sizes = await page.evaluate(() => ({
		hand: player_me.hand.cards.length, deck: player_me.deck.cards.length, start: window.deck0.length,
		shown: player_me.deck.elem.querySelectorAll('.deck-card').length, counter: player_me.deck.counter.textContent,
	}));
	assert(sizes.hand === 10 && sizes.deck === sizes.start, 'hand and deck keep their size (' + sizes.hand + ', ' + sizes.deck + ')');
	assert(sizes.shown === sizes.deck && sizes.counter === String(sizes.deck), 'the pile on the table matches the deck');
	await waitFor(page, () => !Carousel.curr, 'redraw closed');

	// What a spy draws: everything else comes first
	const order = await page.evaluate(() => {
		const deck = player_me.deck;
		const last = [window.first, window.picked];
		const rest = [];
		while (deck.cards.length)
			rest.push(deck.removeCard(0));
		return { lastTwo: rest.slice(-2).every((c, i) => c === last[i]), early: rest.slice(0, -2).some(c => last.includes(c)) };
	});
	assert(order.lastTwo && !order.early, 'cards sent back are the last ones drawn');

	// ---------- an empty deck has nothing to swap with ----------
	const empty = await page.evaluate(() => {
		const hand = player_me.hand, card = hand.cards[0];
		try { player_me.deck.swap(hand, card); }
		catch (e) { return 'threw ' + e; }
		return hand.cards.includes(card) && hand.cards.length === 10 ? 'kept' : 'lost';
	});
	assert(empty === 'kept', 'with an empty deck the card stays in the hand (' + empty + ')');
	await page.evaluate(() => { window.swaps = []; game.returnToCustomization(); });

	// ---------- every faction, the computer's redraws too ----------
	for (const [faction, seed] of [['realms', 11], ['nilfgaard', 22], ['monsters', 33], ['scoiatael', 44], ['skellige', 55], ['realms', 66]]) {
		await start(page, faction, seed);
		await pick(page, 2);
		await waitFor(page, () => Carousel.curr && !Carousel.curr.selecting, 'second redraw open');
		await pick(page, 3);
		await waitFor(page, () => !Carousel.curr, 'redraw closed');
		await page.evaluate(() => game.returnToCustomization());
	}
	const swaps = await page.evaluate(() => window.swaps);
	const me = swaps.filter(s => s.who === 'me').length, op = swaps.filter(s => s.who === 'op').length;
	assert(me === 12 && op > 0, 'swaps seen: ' + me + ' by the player, ' + op + ' by the computer');
	for (const key of ['topDrawn', 'sentBack', 'underDeck', 'restInOrder', 'sameSize'])
		assert(swaps.every(s => s[key]), 'every swap: ' + key);

	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
