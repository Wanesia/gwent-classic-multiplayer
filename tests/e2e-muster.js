// Muster animation: called cards are highlighted where they are, then fly one at a
// time from their own hand slot or the deck, and the deck counter ticks down per card.
// Records the board on every animation frame while a muster plays.
const { chromium } = require('playwright-core');
const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765'; // local relay, so test games stay out of the real server's stats

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
// Collapses consecutive repeats: [3,3,2,2,1] -> [3,2,1]
const steps = arr => arr.filter((v, i) => i === 0 || v !== arr[i - 1]);

async function newGame(browser) {
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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
	await page.evaluate(() => { GameRNG.randomSeed = () => 1; });
	await page.evaluate(() => document.getElementById('start-game').click());
	await waitFor(page, () => typeof Carousel !== 'undefined' && Carousel.curr, 'redraw carousel open');
	await page.evaluate(() => Carousel.curr && Carousel.curr.cancel());
	await waitFor(page, () => game.currPlayer === player_me && !player_me.passed &&
		!document.getElementsByTagName('main')[0].classList.contains('noclick'), 'my turn', 90000);
	await page.waitForTimeout(500);
	// Helpers: build cards by name and record every frame while a muster plays
	await page.evaluate(() => {
		window.mk = (name, player) => new Card(card_dict.find(c => c.name === name), player);
		// The starter decks may already hold muster cards: take them out so counts are exact
		window.purge = (player, prefix) => [player.hand, player.deck].forEach(con =>
			con.cards.filter(c => c.name.startsWith(prefix)).forEach(c => con.removeCard(c)));
		window.startRecording = (tracked, row, holder) => {
			const log = [];
			const t0 = performance.now();
			const deck = holder.deck, hand = holder.hand;
			const where = c => {
				const p = c.elem.parentElement;
				if (!p) return 'none';
				if (hand.elem && p === hand.elem) return 'hand';
				if (p === row.elem) return 'row';
				if (deck.elem.contains(c.elem)) return 'deck';
				if (hand.hidden_elem && p === hand.hidden_elem) return 'hand';
				return 'other';
			};
			window.recording = true;
			(function tick() {
				log.push({
					t: performance.now() - t0,
					deckShown: Number(deck.counter.textContent),
					deckGlow: deck.elem.classList.contains('muster-source'),
					handShown: Number(hand.counter.textContent),
					rowCount: row.cards.length,
					cards: tracked.map(c => ({
						where: where(c),
						called: c.elem.classList.contains('muster-called'),
						flying: c.elem.style.transform !== '',
						left: c.elem.offsetLeft,
						handIndex: hand.elem ? [...hand.elem.children].indexOf(c.elem) : -1,
					})),
				});
				if (window.recording) requestAnimationFrame(tick);
			})();
			return log;
		};
	});
	return page;
}

// Checks a muster of the player's own cards; `fromHand` / `fromDeck` count the called cards.
function checkOwnMuster(label, log, fromHand, fromDeck, deckBefore) {
	// from the moment the muster starts (the summoner itself may land on the same row)
	log = log.slice(Math.max(0, log.findIndex(f => f.deckGlow || f.cards.some(c => c.called))));
	const handIdx = [...Array(fromHand).keys()];
	const total = fromHand + fromDeck;

	// 1. Telegraph: before anything moves, hand cards are lifted in place and the deck glows
	const calledFrames = log.filter(f => handIdx.every(i => f.cards[i].called && !f.cards[i].flying));
	if (fromHand) {
		assert(calledFrames.length > 0, label + ': called hand cards are highlighted before flying');
		const span = calledFrames.length ? calledFrames[calledFrames.length - 1].t - calledFrames[0].t : 0;
		assert(span >= 400 && span <= 1000, label + ': highlight shows for ~' + Math.round(span) + 'ms before the first flight');
		assert(calledFrames.every(f => handIdx.every(i => f.cards[i].where === 'hand')),
			label + ': highlighted cards stay in the hand while highlighted');
		assert(calledFrames.every(f => f.deckShown === deckBefore), label + ': deck counter unchanged while highlighted');
	}
	const glowFrames = log.filter(f => f.deckGlow);
	if (fromDeck)
		assert(glowFrames.length > 0 && glowFrames[0].deckShown === deckBefore, label + ': deck glows before its cards leave');
	else
		assert(glowFrames.length === 0, label + ': deck does not glow when nothing comes from it');

	// 2. Hand cards fly from their own slot: never detached, never moved to the end of the hand
	for (const i of handIdx) {
		const wheres = steps(log.map(f => f.cards[i].where));
		assert(JSON.stringify(wheres) === '["hand","row"]', label + ': hand card ' + i + ' goes hand -> row directly (' + wheres.join(' -> ') + ')');
		// (translate() itself clears the inline margin at launch, so compare slots, not offsets)
		const held = log.filter(f => f.cards[i].called && !f.cards[i].flying);
		const launch = log.find(f => f.cards[i].flying && f.cards[i].where === 'hand');
		// the hand first closes the summoner's gap (a .25s margin transition), so the card
		// may glide a little, but never jumps, and is still once the hand has settled
		const settled = held.filter(f => f.t - held[0].t >= 350);
		assert(held.length && held.every((f, k) => k === 0 || Math.abs(f.cards[i].left - held[k - 1].cards[i].left) <= 5) &&
			held.every(f => f.cards[i].handIndex === held[0].cards[i].handIndex) &&
			settled.length && settled.every(f => f.cards[i].left === settled[0].cards[i].left),
			label + ': hand card ' + i + ' holds its place while highlighted');
		assert(held.length && launch && held[0].cards[i].handIndex === launch.cards[i].handIndex,
			label + ': hand card ' + i + ' launches from its own slot (index ' + (held.length && held[0].cards[i].handIndex) +
			' -> ' + (launch && launch.cards[i].handIndex) + ')');
	}

	// 3. One at a time: deck counter ticks per card, row grows by one, hand cards go first
	const deckSteps = steps(log.map(f => f.deckShown));
	const expectDeck = [...Array(fromDeck + 1).keys()].map(k => deckBefore - k);
	assert(JSON.stringify(deckSteps) === JSON.stringify(expectDeck), label + ': deck counter ticks one card at a time ' + JSON.stringify(deckSteps));
	const rowSteps = steps(log.map(f => f.rowCount));
	const rowStart = rowSteps[0];
	assert(JSON.stringify(rowSteps) === JSON.stringify([...Array(total + 1).keys()].map(k => rowStart + k)),
		label + ': row gains the called cards one at a time ' + JSON.stringify(rowSteps));
	if (fromHand && fromDeck) {
		const handLanded = log.findIndex(f => handIdx.every(i => f.cards[i].where === 'row'));
		const deckLeft = log.findIndex(f => f.deckShown < deckBefore);
		assert(handLanded !== -1 && handLanded <= deckLeft, label + ': hand cards land before deck cards leave');
	}
	// each card sets off only once the previous one is on the row
	for (let k = 1; k < total; k++) {
		const kth = log.findIndex(f => f.cards[k].flying);
		const prevLanded = log.findIndex(f => f.cards[k - 1].where === 'row');
		assert(kth !== -1 && prevLanded !== -1 && prevLanded <= kth, label + ': card ' + k + ' sets off after card ' + (k - 1) + ' has landed');
	}
}

(async () => {
	const browser = await chromium.launch();

	// --- Gaunter O'Dimm: 1 Darkness in hand, 2 in the deck -------------------------
	{
		const page = await newGame(browser);
		const setup = await page.evaluate(() => {
			// keep the hand Darkness off the end of the hand, so "flies from its own slot"
			// is distinguishable from the old re-append to the end of the hand
			const big = card_dict.find(c => c.ability === '' && Number(c.strength) >= 8 && c.row === 'close');
			purge(player_me, 'Gaunter');
			player_me.hand.addCard(new Card(big, player_me));
			window.g = mk("Gaunter O'Dimm", player_me);
			window.darks = [mk("Gaunter O'Dimm - Darkness", player_me), mk("Gaunter O'Dimm - Darkness", player_me), mk("Gaunter O'Dimm - Darkness", player_me)];
			player_me.hand.addCard(g);
			player_me.hand.addCard(darks[0]);
			player_me.deck.addCard(darks[1]);
			player_me.deck.addCard(darks[2]);
			const idx = [...player_me.hand.elem.children].indexOf(darks[0].elem);
			return { deck: player_me.deck.cards.length, hand: player_me.hand.cards.length, idx, last: player_me.hand.elem.children.length - 1 };
		});
		assert(setup.idx !== -1 && setup.idx < setup.last, 'setup: hand Darkness is not the last hand card (index ' + setup.idx + ' of ' + setup.last + ')');
		const result = await page.evaluate(async () => {
			const row = board.getRow(g, 'ranged', player_me);
			// track in flight order: the hand card, then the deck cards in deck order
			const deckOrder = player_me.deck.cards.filter(c => darks.includes(c));
			const log = startRecording([darks[0], ...deckOrder], row, player_me);
			const t0 = performance.now();
			ui.selectCard(g);
			ui.selectRow(board.getRow(g, 'siege', player_me)); // ends the turn and waits on the AI: not awaited
			await sleepUntil(() => row.cards.length === 3, 50);
			const done = performance.now() - t0;
			await sleep(300);
			window.recording = false;
			return { log, done };
		});
		const log = result.log;
		checkOwnMuster('Gaunter', log, 1, 2, setup.deck);
		console.log('     (Gaunter played -> all 3 Darkness on the board: ' + Math.round(result.done) + 'ms)');

		const end = await page.evaluate(() => {
			const ranged = board.getRow(g, 'ranged', player_me), siege = board.getRow(g, 'siege', player_me);
			const isDark = c => c.name === "Gaunter O'Dimm - Darkness";
			return {
				siegeHasG: siege.cards.includes(g),
				rangedDarks: ranged.cards.filter(isDark).length,
				handDarks: player_me.hand.cards.filter(isDark).length,
				deckDarks: player_me.deck.cards.filter(isDark).length,
				deck: player_me.deck.cards.length,
				deckShown: Number(player_me.deck.counter.textContent),
				deckDivs: player_me.deck.elem.getElementsByClassName('deck-card').length,
				hand: player_me.hand.cards.length,
				handShown: Number(player_me.hand.counter.textContent),
				handDom: player_me.hand.elem.children.length,
				flags: darks.some(c => c.mustering),
				classes: document.querySelectorAll('.muster-called, .muster-source').length,
			};
		});
		assert(end.siegeHasG && end.rangedDarks === 3, 'Gaunter: Gaunter on siege, all 3 Darkness on ranged (no double pull)');
		assert(end.handDarks === 0 && end.deckDarks === 0, 'Gaunter: no Darkness left in hand or deck');
		assert(end.deck === setup.deck - 2 && end.deckShown === end.deck && end.deckDivs === end.deck, 'Gaunter: deck state, counter and pile agree (' + end.deck + ')');
		assert(end.hand === setup.hand - 2 && end.handShown === end.hand && end.handDom === end.hand, 'Gaunter: hand state, counter and DOM agree (' + end.hand + ')');
		assert(!end.flags && end.classes === 0, 'Gaunter: no muster flags or highlight classes left behind');
		await page.close();
	}

	// --- Cirilla: Roach only in the hand ---------------------------------------------
	{
		const page = await newGame(browser);
		const setup = await page.evaluate(() => {
			const big = card_dict.find(c => c.ability === '' && Number(c.strength) >= 8 && c.row === 'close');
			purge(player_me, 'Roach');
			player_me.hand.addCard(new Card(big, player_me));
			window.ciri = mk('Cirilla Fiona Elen Riannon', player_me);
			window.roach = mk('Roach', player_me);
			player_me.hand.addCard(ciri);
			player_me.hand.addCard(roach);
			return { deck: player_me.deck.cards.length, roachInDeck: player_me.deck.cards.some(c => c.name === 'Roach') };
		});
		assert(!setup.roachInDeck, 'setup: no Roach in the deck');
		const log = await page.evaluate(async () => {
			const row = board.getRow(ciri, 'close', player_me);
			const log = startRecording([roach], row, player_me);
			ui.selectCard(ciri);
			ui.selectRow(row);
			await sleepUntil(() => row.cards.includes(roach), 50);
			await sleep(300);
			window.recording = false;
			return log;
		});
		checkOwnMuster('Ciri', log, 1, 0, setup.deck);
		const end = await page.evaluate(() => ({
			onRow: board.getRow(ciri, 'close', player_me).cards.includes(roach) && board.getRow(ciri, 'close', player_me).cards.includes(ciri),
			inHand: player_me.hand.cards.includes(roach),
			classes: document.querySelectorAll('.muster-called, .muster-source').length,
		}));
		assert(end.onRow && !end.inHand && end.classes === 0, 'Ciri: Ciri and Roach on close, Roach out of the hand, no classes left');
		await page.close();
	}

	// --- Opponent muster (hidden hand), played on the player's turn so the AI is idle --
	{
		const page = await newGame(browser);
		const op = await page.evaluate(async () => {
			purge(player_op, 'Gaunter');
			window.og = mk("Gaunter O'Dimm", player_op);
			window.odarks = [mk("Gaunter O'Dimm - Darkness", player_op), mk("Gaunter O'Dimm - Darkness", player_op)];
			player_op.hand.addCard(og);
			player_op.hand.addCard(odarks[0]);
			player_op.deck.addCard(odarks[1]);
			const before = { hand: player_op.hand.cards.length, deck: player_op.deck.cards.length };
			const ranged = board.getRow(og, 'ranged', player_op);
			const log = startRecording(odarks, ranged, player_op);
			await board.moveTo(og, 'siege', player_op.hand);
			window.recording = false;
			return {
				before, log,
				hand: player_op.hand.cards.length, handShown: Number(player_op.hand.counter.textContent),
				deck: player_op.deck.cards.length, deckShown: Number(player_op.deck.counter.textContent),
				onRows: board.getRow(og, 'siege', player_op).cards.includes(og) && odarks.every(c => ranged.cards.includes(c)),
				classes: document.querySelectorAll('.muster-called, .muster-source').length,
			};
		});
		assert(op.onRows, 'opponent: Gaunter and both Darkness on the opponent rows');
		assert(op.hand === op.before.hand - 2 && op.handShown === op.hand, 'opponent: hand count and counter drop by 2');
		assert(op.deck === op.before.deck - 1 && op.deckShown === op.deck, 'opponent: deck count and counter drop by 1');
		assert(op.log.some(f => f.deckGlow) && op.classes === 0, 'opponent: opponent deck glows during the muster, then clears');
		const opRow = steps(op.log.map(f => f.rowCount));
		assert(JSON.stringify(opRow) === JSON.stringify([opRow[0], opRow[0] + 1, opRow[0] + 2]), 'opponent: called cards land one at a time ' + JSON.stringify(opRow));
		await page.close();
	}

	// --- Leaving mid-muster: the reused deck pile must not keep glowing next game ----
	{
		const page = await newGame(browser);
		await page.evaluate(() => {
			purge(player_me, 'Gaunter');
			window.g = mk("Gaunter O'Dimm", player_me);
			player_me.hand.addCard(g);
			player_me.deck.addCard(mk("Gaunter O'Dimm - Darkness"));
			ui.selectCard(g);
			ui.selectRow(board.getRow(g, 'siege', player_me));
		});
		await waitFor(page, () => document.getElementById('deck-me').classList.contains('muster-source'), 'abandon: deck glows mid-muster');
		await page.evaluate(() => { game.exitGame(); Popup.curr.selectNo(); }); // popup: Resume=yes, Exit=no
		await waitFor(page, () => !document.getElementById('deck-customization').classList.contains('hide'), 'abandon: back at deck setup');
		await page.waitForTimeout(1500); // let the abandoned muster's timers run out
		await page.evaluate(() => document.getElementById('start-game').click());
		await waitFor(page, () => game.state.val === 10 && player_me.deck.cards.length > 0, 'abandon: next game started');
		await page.waitForTimeout(500);
		const left = await page.evaluate(() => ({
			glow: document.querySelectorAll('.muster-source, .muster-called').length,
			rows: board.row.every(r => r.cards.length === 0),
		}));
		assert(left.glow === 0, 'abandon: no muster highlight carried into the next game');
		assert(left.rows, 'abandon: abandoned muster put nothing on the next game\'s board');
		await page.close();
	}

	assert(errors.length === 0, 'no page errors' + (errors.length ? ':\n  ' + errors.join('\n  ') : ''));
	await browser.close();
	console.log(failed ? '\nMUSTER TEST FAILED' : '\nMUSTER TEST PASSED');
	process.exit(failed ? 1 : 0);
})();
