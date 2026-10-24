// Deck builder filter tabs: all / close / ranged / siege / hero / weather / special, separately for the collection and the deck.
const { chromium } = require('playwright-core');
const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';

let failed = false;
const errors = [];
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}

// What each tab should show, worked out here from the card data rather than taken from DeckMaker
const EXPECTED = {
	all:     c => true,
	close:   c => c.row === 'close' || c.row === 'agile',
	ranged:  c => c.row === 'ranged' || c.row === 'agile',
	siege:   c => c.row === 'siege',
	hero:    c => c.ability.split(' ').includes('hero'),
	weather: c => c.deck === 'weather',
	special: c => c.deck === 'special',
};

// Names of the cards a panel shows, and of the cards it holds (count > 0) that the tab should show
async function panel(page, side) {
	return page.evaluate(side => {
		const cards = side === 'bank' ? dm.bank : dm.deck;
		const shown = cards.filter(x => getComputedStyle(x.elem).display !== 'none').map(x => card_dict[x.index]);
		const held = cards.filter(x => x.count > 0).map(x => card_dict[x.index]);
		return { shown, held };
	}, side);
}

async function checkTab(page, side, filter) {
	await page.click(`#card-${side}-filters [data-filter=${filter}]`);
	const { shown, held } = await panel(page, side);
	const want = held.filter(EXPECTED[filter]);
	const names = l => l.map(c => c.name + '/' + c.filename).sort().join('|');
	assert(names(shown) === names(want), `${side} "${filter}" tab shows exactly the matching cards (${shown.length})`);
	const active = await page.$$eval(`#card-${side}-filters button.active`, b => b.map(x => x.dataset.filter));
	assert(active.length === 1 && active[0] === filter, `${side} "${filter}" tab is the only active one`);
	return shown;
}

(async () => {
	const browser = await chromium.launch();
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

	for (const side of ['bank', 'deck']) {
		const tabs = await page.$$eval(`#card-${side}-filters button`, b => b.map(x => x.dataset.filter));
		assert(tabs.join() === 'all,close,ranged,siege,hero,weather,special', `${side}: seven tabs in Witcher 3 order`);
		assert((await page.textContent(`#card-${side}-filter-name`)).trim() === 'All Cards', `${side}: starts on "All Cards"`);
	}
	assert(await page.$eval('#card-bank-filters [data-filter=hero]', b => b.getAttribute('data-title')) === 'Hero Cards', 'tab tooltip names the filter');

	// Scoia'tael has agile units: they belong under both close and ranged
	await page.evaluate(() => dm.loadFactionDeck('scoiatael'));
	for (const f of Object.keys(EXPECTED)) await checkTab(page, 'bank', f);
	const close = await checkTab(page, 'bank', 'close');
	const ranged = await checkTab(page, 'bank', 'ranged');
	const siege = await checkTab(page, 'bank', 'siege');
	const agile = close.filter(c => c.row === 'agile').map(c => c.filename);
	assert(agile.length > 0 && agile.every(f => ranged.some(c => c.filename === f)), 'agile units show under close and ranged');
	assert(!siege.some(c => c.row === 'agile'), 'agile units stay out of siege');
	assert((await page.textContent('#card-bank-filter-name')).trim() === 'Siege', 'the collection subtitle names the active tab');

	// Filling the deck: heroes under their row and under "hero", unit-ability cards like Villentretenmerth's scorch are not "special"
	await page.evaluate(() => {
		for (let i = 0; i < dm.bank.length; i++)
			while (dm.bank[i].count > 0) dm.select(i, true);
	});
	for (const f of Object.keys(EXPECTED)) await checkTab(page, 'deck', f);
	const heroes = await checkTab(page, 'deck', 'hero');
	const deckClose = await checkTab(page, 'deck', 'close');
	assert(heroes.some(c => c.name === 'Geralt of Rivia') && deckClose.some(c => c.name === 'Geralt of Rivia'), 'Geralt shows under hero and close');
	const special = await checkTab(page, 'deck', 'special');
	assert(!special.some(c => c.name === 'Villentretenmerth'), 'Villentretenmerth is a unit, not a special card');
	assert(await page.evaluate(() => dm.filter.bank === 'siege'), 'the collection keeps its own tab while the deck changes');

	// Stats count the whole deck whatever the tab
	const stats = await page.evaluate(() => ({ ...dm.stats }));
	assert(stats.total === await page.evaluate(() => dm.deck.reduce((a, x) => a + x.count, 0)), 'stats count every card, not just the shown ones');

	// The invisible spacer keeps the last row left-aligned when two cards are shown in it
	const badSpacer = [];
	for (const side of ['bank', 'deck']) {
		for (const f of Object.keys(EXPECTED)) {
			await page.click(`#card-${side}-filters [data-filter=${f}]`);
			const ok = await page.evaluate(side => {
				const el = document.getElementById('card-' + side);
				const shown = el.querySelectorAll('.card-lg:not(.hide):not(.filtered-out):not(.empty)').length;
				return (shown % 3 === 2) === !!el.querySelector('.card-lg.empty');
			}, side);
			if (!ok) badSpacer.push(side + ' ' + f);
		}
	}
	assert(badSpacer.length === 0, 'spacer card matches the shown count on every tab' + (badSpacer.length ? ': ' + badSpacer.join(', ') : ''));

	// Moving a card while a tab is on: it leaves the collection view and the deck updates
	await page.click('#card-deck-filters [data-filter=all]');
	await page.evaluate(() => { const i = dm.deck.findIndex(x => x.count > 0 && card_dict[x.index].row === 'siege'); dm.select(i, false); });
	await page.click('#card-bank-filters [data-filter=siege]');
	const bankSiege = await panel(page, 'bank');
	assert(bankSiege.shown.length === 1 && bankSiege.shown[0].row === 'siege', 'a card taken out of the deck shows under the collection\'s siege tab');

	// A new faction starts on "All Cards" again
	await page.evaluate(() => dm.loadFactionDeck('monsters'));
	assert(await page.evaluate(() => dm.filter.bank === 'all' && dm.filter.deck === 'all'), 'changing faction resets both tabs');
	assert((await page.textContent('#card-deck-filter-name')).trim() === 'All Cards', 'and their subtitles');

	// Polish labels
	await page.evaluate(() => localStorage.setItem('lang', 'pl'));
	await page.reload();
	await page.waitForFunction(() => typeof lobby !== 'undefined');
	await page.click('#split-computer');
	await page.click('#card-bank-filters [data-filter=ranged]');
	assert((await page.textContent('#card-bank-filter-name')).trim() === 'Walka na dystans', 'Polish subtitle for the ranged tab');
	await page.evaluate(() => localStorage.removeItem('lang'));

	assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('\n') : ''));
	await browser.close();
	process.exit(failed ? 1 : 0);
})();
