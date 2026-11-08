// The game open in several tabs: a deck saved in one tab reaches the others, so no tab plays or saves back a stale copy (#16).
const { chromium } = require('playwright-core');
const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';

let failed = false;
const errors = [];
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}
// Polls fn until it returns true; storage events reach other tabs asynchronously
async function until(fn, timeout = 5000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await fn()) return true;
		await new Promise(r => setTimeout(r, 100));
	}
	return false;
}

// The deck builder's deck, and the deck a match was dealt from (hand + pile during the redraw)
const builderDeck = page => page.evaluate(() => {
	const cards = {};
	for (const x of dm.deck) if (x.count > 0) cards[card_dict[x.index].name + '/' + card_dict[x.index].filename] = x.count;
	return JSON.stringify({ leader: dm.leader.card.name, cards: Object.keys(cards).sort().map(k => k + ' x' + cards[k]) });
});
const matchDeck = (page, who = 'player_me') => page.evaluate(who => {
	const player = window[who], cards = {};
	for (const c of [...player.hand.cards, ...player.deck.cards]) cards[c.name + '/' + c.filename] = (cards[c.name + '/' + c.filename] || 0) + 1;
	return JSON.stringify({ leader: player.leader.name, cards: Object.keys(cards).sort().map(k => k + ' x' + cards[k]) });
}, who);

function watchErrors(page) {
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
}
// Opens the game in a new tab of ctx, at the vs-Computer deck builder
async function openBuilder(ctx) {
	const page = await ctx.newPage();
	watchErrors(page);
	await page.goto(URL);
	await page.waitForFunction(() => typeof lobby !== 'undefined');
	await page.click('#split-computer');
	return page;
}
// Clicks a card in the collection ("bank") or the deck
async function clickCard(page, side, name) {
	const ok = await page.evaluate(([side, name]) => {
		const x = (side === 'bank' ? dm.bank : dm.deck).find(x => x.count > 0 && card_dict[x.index].name === name);
		if (x) x.elem.click();
		return !!x;
	}, [side, name]);
	if (!ok) throw new Error(`no ${name} in the ${side}`);
}
// Picks a leader in the leader carousel
async function pickLeader(page, name) {
	await page.click('#card-leader > :nth-child(2)');
	await page.waitForFunction(() => Carousel.curr);
	await page.evaluate(name => {
		Carousel.curr.index = Carousel.curr.container.cards.findIndex(c => c.name === name);
		Carousel.curr.update();
		Carousel.curr.select({ stopPropagation() {} });
	}, name);
	await page.waitForFunction(() => !Carousel.curr);
}
// Starts a vs-Computer match and waits for the redraw
async function startMatch(page) {
	await page.click('#start-game');
	await page.waitForFunction(() => player_me && player_me.hand.cards.length === 10 && Carousel.curr, null, { timeout: 30000 });
}

(async () => {
	const browser = await chromium.launch();
	// Tabs of one context share localStorage, like tabs of one browser
	const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
	const A = await openBuilder(ctx);
	const B = await openBuilder(ctx);
	assert(await builderDeck(A) === await builderDeck(B), 'both tabs start on the same Northern Realms deck');
	// Another context has its own storage, like an incognito window next to normal ones
	const incognito = await openBuilder(await browser.newContext({ viewport: { width: 1600, height: 900 } }));
	const incognitoDeck = await builderDeck(incognito);

	// The report: cards edited in one tab, leader picked in another that still had the old cards
	for (let i = 0; i < 3; i++) await clickCard(B, 'deck', 'Decoy');
	for (let i = 0; i < 3; i++) await clickCard(B, 'bank', 'Skellige Storm');
	const editedB = await builderDeck(B);
	assert(await until(async () => await builderDeck(A) === editedB), 'cards changed in tab B show up in tab A');

	await pickLeader(A, 'Foltest - Son of Medell');
	const expected = JSON.stringify({ ...JSON.parse(editedB), leader: 'Foltest - Son of Medell' });
	assert(await builderDeck(A) === expected, 'tab A: the leader picked there, tab B\'s cards');
	assert(await until(async () => await builderDeck(B) === expected), 'tab B gets the leader picked in tab A and keeps its cards');
	const C = await openBuilder(ctx);
	assert(await builderDeck(C) === expected, 'a newly opened tab loads tab B\'s cards with tab A\'s leader');
	await C.close();
	assert(await builderDeck(incognito) === incognitoDeck, 'an incognito tab keeps its own deck');
	await clickCard(incognito, 'deck', 'Decoy');
	await A.waitForTimeout(500);
	assert(await builderDeck(A) === expected && await builderDeck(B) === expected, 'and its changes stay out of the normal tabs');
	await incognito.context().close();

	await startMatch(A);
	assert(await matchDeck(A) === expected, 'tab A\'s match is dealt from that deck');

	// Tab B edits while tab A plays
	await clickCard(B, 'deck', 'Skellige Storm');
	await clickCard(B, 'bank', 'Biting Frost');
	const editedAgain = await builderDeck(B);
	await A.waitForTimeout(500);
	assert(await matchDeck(A) === expected, 'a deck saved in tab B mid-match leaves tab A\'s match alone');
	await A.evaluate(() => { Carousel.curr.cancel(); game.returnToCustomization(); });
	assert(await builderDeck(A) === editedAgain, 'tab A\'s deck builder has tab B\'s latest deck after the match');

	// Another faction's deck
	await B.evaluate(() => dm.loadFactionDeck('nilfgaard'));
	await clickCard(B, 'deck', 'Decoy');
	const nilfgaardB = await builderDeck(B);
	await A.waitForTimeout(500);
	assert(await A.evaluate(() => dm.faction) === 'realms' && await builderDeck(A) === editedAgain, 'tab B editing Nilfgaard leaves tab A on its Northern Realms deck');
	await A.evaluate(() => dm.loadFactionDeck('nilfgaard'));
	assert(await builderDeck(A) === nilfgaardB, 'switching tab A to Nilfgaard shows the deck tab B saved');
	await A.evaluate(() => dm.loadFactionDeck('realms'));
	await B.evaluate(() => dm.loadFactionDeck('realms'));

	// The custom opponent, set and cleared in tab B
	const monstersLeader = await B.evaluate(() => { dm.loadOpponentDeck(JSON.parse(premade_deck[4])); return dm.opponentData.leader; });
	assert(await until(() => A.evaluate(l => dm.opponentData.leader === l, monstersLeader)), 'a custom opponent uploaded in tab B is tab A\'s opponent too');
	await B.evaluate(() => dm.clearOpponentDeck());
	assert(await until(() => A.evaluate(() => isEmpty(dm.opponentData))), 'clearing it in tab B clears it in tab A');
	await ctx.close();

	// Back/forward cache: no storage events reach a cached page. Needs full Chromium, the headless shell never caches.
	{
		const bfBrowser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
		const bfCtx = await bfBrowser.newContext({ viewport: { width: 1600, height: 900 } });
		const A = await openBuilder(bfCtx);
		const B = await openBuilder(bfCtx);
		await A.evaluate(() => window.beforeLeaving = true);
		await A.goto(URL.replace('index.html', 'favicon.ico'));
		for (let i = 0; i < 3; i++) await clickCard(B, 'deck', 'Decoy');
		await clickCard(B, 'bank', 'Torrential Rain');
		const editedB = await builderDeck(B);
		await A.goBack({ waitUntil: 'commit' });
		await A.waitForFunction(() => typeof dm !== 'undefined');
		assert(await A.evaluate(() => window.beforeLeaving === true), 'tab A came back from the back/forward cache');
		assert(await until(async () => await builderDeck(A) === editedB), 'tab A back from the cache shows the deck tab B saved meanwhile');

		// Blocked storage reads as empty: that must not reset the deck on show
		const before = await builderDeck(A);
		await A.evaluate(() => {
			localStorage.removeItem('gc-deck-realms'); // this tab's own change: no storage event here
			dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
		});
		assert(await builderDeck(A) === before, 'a deck missing from storage keeps the tab\'s own copy');
		await bfBrowser.close();
	}

	// Online: a readied player plays the deck the opponent got, whatever another tab saves meanwhile
	{
		const hostCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
		const guestCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
		const H = await hostCtx.newPage(), G = await guestCtx.newPage();
		watchErrors(H); watchErrors(G);
		await H.goto(URL); await G.goto(URL);
		await H.click('#split-player'); await H.click('#lobby-create-button');
		await H.waitForFunction(() => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent));
		const code = await H.textContent('#room-code');
		await G.click('#split-player'); await G.click('#lobby-join-button');
		await G.fill('#join-code', code);
		await H.waitForFunction(() => lobby.inMultiplayer);
		await G.waitForFunction(() => lobby.inMultiplayer);

		const sent = await builderDeck(H);
		await H.click('#start-game');
		await G.waitForFunction(() => lobby.remoteReady);
		const H2 = await openBuilder(hostCtx);
		for (let i = 0; i < 3; i++) await clickCard(H2, 'deck', 'Decoy');
		const changed = await builderDeck(H2);
		assert(await until(async () => await builderDeck(H) === changed), 'the readied host\'s deck builder shows the deck saved in its other tab');

		await G.click('#start-game');
		await H.waitForFunction(() => game.state.val === 10 && Carousel.curr, null, { timeout: 30000 });
		await G.waitForFunction(() => game.state.val === 10 && Carousel.curr, null, { timeout: 30000 });
		assert(await matchDeck(H) === sent, 'the host plays the deck it readied with');
		assert(await matchDeck(G, 'player_op') === sent, 'the guest\'s opponent has that same deck');
		await H.evaluate(() => Carousel.curr.cancel()); await G.evaluate(() => Carousel.curr.cancel());
		await H.waitForFunction(() => game.roundCount === 1);
		await G.waitForFunction(() => game.roundCount === 1);
		assert(await H.evaluate(() => mp.checksum()) === await G.evaluate(() => mp.checksum()), 'both clients in sync');
	}

	assert(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
