// What a replay can reveal: the opponent's hand (beside the controls) and
// every card choice (a carousel-like view of the redraw, revives...). Both only
// look: the match must play out the same with them on, paused, skipped or off.
const { chromium } = require('playwright-core');
const { installBot } = require('./bot');
const BASE = 'http://localhost:8077/index.html';

let failed = false;
const errors = [];
function assert(cond, label) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed = true; }
async function waitFor(page, fn, label, timeout = 60000, arg) {
	try { await page.waitForFunction(fn, arg, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}
function watch(page, tag) {
	page.on('pageerror', e => { const m = String(e); if (!/play\(\)|NotAllowedError|user didn't interact/i.test(m)) errors.push(tag + ': ' + (e.stack || m)); });
	page.on('console', m => { if (m.type() === 'error' && !/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(m.text())) errors.push(tag + ': ' + m.text()); });
}
const pickShown = page => page.evaluate(() => !document.getElementById('replay-pick').classList.contains('hide'));
// The opponent's hand as the panel shows it, and as the game has it (image
// urls as the browser writes them back)
const hands = page => page.evaluate(() => {
	const css = url => { const e = document.createElement('div'); e.style.backgroundImage = url; return e.style.backgroundImage; };
	return {
		shown: [...document.querySelectorAll('#replay-bar .rp-hand-card .card')].map(c => c.style.backgroundImage),
		real: [...player_op.hand.cards].sort(Card.compare).map(c => css(smallURL(c.faction + '_' + c.filename))),
		count: document.querySelector('#replay-bar .rp-hand-count').textContent,
	};
});
const same = h => h.shown.length === h.real.length && h.shown.every((s, i) => s === h.real[i]);

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	watch(page, 'A');
	await page.goto(BASE);
	await page.waitForFunction(() => typeof ReplayUI !== 'undefined');

	// a real match to watch: the player redraws two cards
	await page.click('#split-computer');
	await page.evaluate(() => { GameRNG.randomSeed = () => 4242; GameSpeed.factor = 0.1; dm.loadFactionDeck('realms', true); document.getElementById('start-game').click(); });
	await installBot(page, 4242);
	await waitFor(page, () => game.state.val === 100, 'recorded match finished', 240000);
	await page.evaluate(() => { window.botStop = true; GameSpeed.factor = 1; });
	await page.waitForTimeout(400);
	const rec = await page.evaluate(async () => { await MatchHistory.ready; const m = (await MatchHistory.list())[0]; return await HistoryDB.get('replays', m.id); });
	const picks = rec.log.filter(([, m]) => m.t === 'pick');
	assert(picks.length >= 1, 'the recording has redraw picks (' + picks.length + ')');
	// how it ends without any of this: played headless, no controls
	const plain = await page.evaluate(async rec => { const r = await Replay.run(rec, { speed: 0.02 }); const sum = mp.checksum(); Replay.detach(); return { ...r, sum }; }, rec);
	assert(plain.result === 'done', 'plain replay plays to the end');

	// ---- the redraw, shown as the carousel the player had ----
	await page.evaluate(() => localStorage.removeItem('gc-replay-bar'));
	await page.reload();
	await page.waitForFunction(() => typeof ReplayUI !== 'undefined');
	assert(await page.evaluate(() => !ReplayUI.showHand && ReplayUI.showPicks), 'defaults: hand hidden, choices shown');
	await page.evaluate(rec => ReplayUI.open(rec), rec);
	assert(await page.evaluate(() => document.querySelector('#replay-bar .rp-show-hand').getAttribute('aria-pressed') === 'false'
		&& document.querySelector('#replay-bar .rp-show-picks').getAttribute('aria-pressed') === 'true'), 'the switches say so');
	await waitFor(page, () => !document.getElementById('replay-pick').classList.contains('hide'), 'the first redraw is shown');
	const first = await page.evaluate(i => {
		const p = document.getElementById('replay-pick');
		const card = player_me.hand.cards[i];
		const css = url => { const e = document.createElement('div'); e.style.backgroundImage = url; return e.style.backgroundImage; };
		return {
			who: p.querySelector('.rpk-who').textContent, what: p.querySelector('.rpk-what').textContent,
			pips: [...p.querySelectorAll('.rpk-pips > span')].map(s => s.classList.contains('used')),
			center: p.querySelector('.rpk-center').style.backgroundImage, want: css(largeURL(card.faction + '_' + card.filename)),
			turn: Replay.turn(),
		};
	}, picks[0][1].i);
	assert(first.who === 'Player 1' && first.what === 'Redraw', 'titled with who chooses and what (' + first.who + ' / ' + first.what + ')');
	assert(JSON.stringify(first.pips) === '[true,false]', 'pips: first of two picks');
	assert(first.center === first.want, 'the recorded pick is the card in the middle');
	assert(first.turn === 0, 'before the first move');

	// paused, the choice stays on screen; the pick isn't made meanwhile
	await page.keyboard.press(' ');
	const handBefore = await page.evaluate(() => player_me.hand.cards.map(c => c.name).join());
	await page.waitForTimeout(2500);
	assert(await pickShown(page) && await page.evaluate(h => player_me.hand.cards.map(c => c.name).join() === h, handBefore), 'paused: the choice holds, the hand is unchanged');
	await page.keyboard.press(' ');
	await waitFor(page, () => document.querySelector('#replay-pick .rpk-center.rpk-drawn'), 'the card the redraw brought in is shown');
	assert(await page.evaluate(h => player_me.hand.cards.map(c => c.name).join() !== h, handBefore), 'then the card is swapped');

	// skipping ahead hides it and plays on without waiting
	await page.keyboard.press('ArrowRight');
	await waitFor(page, () => Replay.resume && !Replay.target && Replay.turn() === 1, 'next move reached');
	assert(!(await pickShown(page)), 'skipping ahead: no choice left on screen');

	// ---- the opponent's hand ----
	assert(await page.isHidden('#replay-bar .rp-hand'), 'the opponent\'s hand is hidden at first');
	await page.keyboard.press('o');
	await waitFor(page, () => !document.querySelector('#replay-bar .rp-hand').classList.contains('hide'), 'O shows it');
	let h = await hands(page);
	assert(same(h) && h.count === String(h.real.length), 'it shows the opponent\'s real hand, sorted (' + h.real.length + ' cards)');
	assert(await page.evaluate(() => JSON.parse(localStorage.getItem('gc-replay-bar')).hand === true), 'remembered');
	assert(await page.evaluate(() => document.querySelector('#replay-bar .rp-hand-card .card').closest('#replay-bar') && !document.querySelector('#hand-op .rp-hand-card')), 'pictures of its own, not the game\'s cards');
	// hovering a card enlarges it beside the controls
	await page.hover('#replay-bar .rp-hand-card:nth-child(1)');
	assert(await page.evaluate(() => { const z = document.querySelector('#replay-bar .rp-hand-zoom'), r = z.getBoundingClientRect(), b = document.getElementById('replay-bar').getBoundingClientRect();
		return !z.classList.contains('hide') && /lg/.test(z.style.backgroundImage) && r.right <= b.left; }), 'hovering a card enlarges it, left of the controls');
	await page.mouse.move(5, 5);
	assert(await page.isHidden('#replay-bar .rp-hand-zoom'), 'and hides it again');
	// it follows the match, move by move
	const sizes = new Set();
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('ArrowRight');
		await waitFor(page, t => Replay.resume && !Replay.target && Replay.turn() === t, 'move ' + (i + 2), 60000, i + 2);
		await page.waitForTimeout(100);
		h = await hands(page);
		sizes.add(h.real.length);
		if (!same(h)) break;
	}
	assert(same(h) && sizes.size > 1, 'the hand stays right as cards are played (' + [...sizes].join(' ') + ')');
	// going back: replayed from the start, the hand lands on that move's
	await page.keyboard.press('ArrowLeft');
	await waitFor(page, () => Replay.resume && !Replay.target && Replay.turn() === 6, 'back a move');
	await page.waitForTimeout(100);
	assert(same(await hands(page)), 'going back: the hand of that move');
	// folded controls hide it; O unfolds them to show it again
	await page.keyboard.press('o');
	assert(await page.isHidden('#replay-bar .rp-hand'), 'O hides it again');
	await page.keyboard.press('m');
	await page.keyboard.press('o');
	assert(await page.evaluate(() => !document.getElementById('replay-bar').classList.contains('rp-mini')) && await page.isVisible('#replay-bar .rp-hand'), 'folded: O unfolds the controls and shows it');

	// ---- the opponent's hidden choices ----
	// Shown as card backs while their hand is hidden (made up here: the
	// computer's own choices aren't recorded)
	await page.evaluate(() => Replay.pause());
	await waitFor(page, () => Replay.paused && Replay.resume, 'paused');
	const shownAs = reveal => page.evaluate(async reveal => {
		ReplayUI.setShowHand(reveal);
		Replay.paused = false; // the choice waits out its time, then lets go
		let made = false;
		const done = ReplayUI.showPick({ chooser: player_op, container: player_op.hand, index: 0, pick: 1, count: 1, redraw: false }, () => { made = true; });
		await new Promise(r => setTimeout(r, 300));
		const center = document.querySelector('#replay-pick .rpk-center').style.backgroundImage;
		const desc = !document.querySelector('#replay-pick .card-description').classList.contains('hide');
		await done;
		Replay.paused = true;
		return { back: /deck_back/.test(center), desc, made, what: document.querySelector('#replay-pick .rpk-what').textContent };
	}, reveal);
	const hidden = await shownAs(false), open = await shownAs(true);
	assert(hidden.back && !hidden.desc && hidden.made, 'opponent\'s hand hidden: their choice shows card backs, no description');
	assert(!open.back && open.made && open.what === 'Discard from hand', 'revealed: the card itself');

	// ---- choices off ----
	await page.keyboard.press('c');
	assert(await page.evaluate(() => !ReplayUI.showPicks && JSON.parse(localStorage.getItem('gc-replay-bar')).picks === false), 'C turns the choices off, remembered');
	await page.click('#replay-bar .rp-restart');
	await waitFor(page, () => !Replay.target && Replay.turn() >= 1, 'watching from the start');
	assert(!(await pickShown(page)), 'no choice shown with them off');
	await page.click('#replay-bar .rp-show-picks');
	assert(await page.evaluate(() => ReplayUI.showPicks), 'the switch turns them on again');

	// ---- it all only looks: the same match to the end ----
	await page.click('#replay-bar .rp-speed:text-is("4×")');
	await page.click('#replay-bar .rp-restart');
	await waitFor(page, () => !document.getElementById('replay-pick').classList.contains('hide'), 'from the start: the redraw shown again');
	await waitFor(page, () => Replay.result, 'watched to the end with everything shown', 240000);
	const end = await page.evaluate(() => ({ result: Replay.result, turns: Replay.turn(), sum: mp.checksum() }));
	assert(end.result === 'done' && end.turns === plain.turns && end.sum === plain.sum, 'same end as a plain replay (' + end.sum + ' / ' + plain.sum + ')');

	// leaving: nothing left on screen
	await page.keyboard.press('Escape');
	await waitFor(page, () => !mp.replay && !document.getElementById('lobby').classList.contains('hide'), 'left the replay');
	assert(!(await pickShown(page)) && await page.isHidden('#replay-bar'), 'nothing left behind');

	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
