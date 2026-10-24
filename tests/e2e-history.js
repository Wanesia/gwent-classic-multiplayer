// Match history: results for every way a match can end, the history window,
// export/import (merge and replace, hostile files) and running out of storage.
const { chromium } = require('playwright-core');
const fs = require('fs');
const BASE = 'http://localhost:8077/index.html';
const URL = BASE + '?server=ws://localhost:8765';

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
const latest = page => page.evaluate(async () => {
	await new Promise(r => setTimeout(r, 300));
	await MatchHistory.ready;
	return (await MatchHistory.list())[0];
});

// Two fresh browsers in one online match, both past the redraw
async function onlinePair(browser, quick) {
	const A = await (await browser.newContext()).newPage();
	const B = await (await browser.newContext()).newPage();
	watch(A, 'A'); watch(B, 'B');
	await A.goto(URL); await B.goto(URL);
	await A.click('#split-player'); await B.click('#split-player');
	if (quick) {
		await A.click('#lobby-quick-button');
		await A.waitForTimeout(500);
		await B.click('#lobby-quick-button');
	} else {
		await A.click('#lobby-create-button');
		await A.waitForFunction(() => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent));
		const code = await A.textContent('#room-code');
		await B.click('#lobby-join-button');
		await B.fill('#join-code', code);
	}
	await waitFor(A, () => lobby.inMultiplayer, 'A in deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'B in deck setup');
	await A.evaluate(() => document.getElementById('start-game').click());
	await B.waitForFunction(() => lobby.remoteReady);
	await B.evaluate(() => document.getElementById('start-game').click());
	for (const p of [A, B]) {
		await waitFor(p, () => typeof Carousel !== 'undefined' && Carousel.curr, 'redraw open');
		await p.evaluate(() => Carousel.curr.cancel());
	}
	await waitFor(A, () => game.roundCount === 1 && game.currPlayer, 'A in round 1');
	await waitFor(B, () => game.roundCount === 1 && game.currPlayer, 'B in round 1');
	return { A, B };
}
const popup = page => page.evaluate(() => ({
	open: !document.getElementById('popup').classList.contains('hide'),
	title: document.querySelector('#popup h3').textContent,
	body: document.querySelector('#popup p').textContent,
	closable: !document.getElementById('popup-close').classList.contains('hide'),
}));

(async () => {
	const browser = await chromium.launch();

	// ---------- a single-player match abandoned by reloading ----------
	const page = await browser.newPage({ acceptDownloads: true });
	watch(page, 'SP');
	await page.goto(BASE);
	await page.waitForFunction(() => typeof MatchHistory !== 'undefined');
	await page.click('#split-computer');
	await page.evaluate(() => document.getElementById('start-game').click());
	await waitFor(page, () => Carousel.curr, 'redraw open');
	const playing = await latest(page);
	assert(playing && playing.status === 'playing' && playing.mode === 'ai', 'a match is saved as soon as it starts');
	await page.reload();
	await page.waitForFunction(() => typeof MatchHistory !== 'undefined');
	const reloaded = await latest(page);
	assert(reloaded.id === playing.id && reloaded.status === 'done' && reloaded.result === 'left', 'reloading mid-match records a defeat ("left")');

	// ---------- online endings ----------
	{
		const { A, B } = await onlinePair(browser, false);
		await B.close();
		await waitFor(A, () => !document.getElementById('popup').classList.contains('hide'), 'host sees the disconnect popup');
		const p = await popup(A);
		assert(/Disconnected/.test(p.title) && /counts as your victory/.test(p.body), 'opponent leaving: popup says it counts as a win ("' + p.body + '")');
		assert(!p.closable, 'opponent leaving mid-match: the notice has no X, the match is gone');
		const rec = await latest(A);
		assert(rec.result === 'walkover' && rec.mode === 'friend', 'opponent leaving mid-match is a walkover for the one who stayed');
		await A.close();
	}
	{
		const { A, B } = await onlinePair(browser, false);
		await A.evaluate(() => Net.socket.close());
		await waitFor(A, () => !document.getElementById('popup').classList.contains('hide'), 'own connection lost: popup');
		const p = await popup(A);
		assert(/Connection Lost/.test(p.title) && /counts as a defeat/.test(p.body), 'own connection lost: popup says so and that it is a defeat');
		assert((await latest(A)).result === 'left', 'own connection lost: recorded as "left"');
		await waitFor(B, () => !document.getElementById('popup').classList.contains('hide'), 'peer of the dropped player sees a popup');
		assert((await latest(B)).result === 'walkover', 'the other player gets the walkover');
		await A.close(); await B.close();
	}
	{
		const { A, B } = await onlinePair(browser, true);
		await A.evaluate(() => mp.desync());
		await waitFor(B, () => !document.getElementById('popup').classList.contains('hide'), 'desync reaches the other player');
		const ra = await latest(A), rb = await latest(B);
		assert(ra.result === 'desync' && rb.result === 'desync', 'a desync is recorded as such on both sides (' + ra.result + ' / ' + rb.result + ')');
		assert(ra.mode === 'quick' && rb.mode === 'quick', 'quick match recorded as "quick"');
		assert(/doesn't count/.test((await popup(B)).body), 'desync popup says the match does not count');
		await A.close(); await B.close();
	}

	// ---------- the history window ----------
	const leader = await page.evaluate(() => card_dict.find(c => c.row === 'leader' && c.deck === 'realms').name);
	const opLeader = await page.evaluate(() => card_dict.find(c => c.row === 'leader' && c.deck === 'monsters').name);
	const mk = (id, ts, mode, result, fav = false) => ({ id, ts, ver: '1.2.0', mode, status: 'done', result,
		me: { faction: 'realms', leader }, op: { faction: 'monsters', leader: opLeader },
		rounds: [{ me: 50, op: 40, w: 'me' }, { me: 30, op: 60, w: 'op' }], fav });
	const day = 86400000, now = Date.now();
	const seeded = [mk('t-1', now - 5 * day, 'ai', 'win'), mk('t-2', now - 4 * day, 'friend', 'lose'), mk('t-3', now - 3 * day, 'quick', 'walkover', true),
		mk('t-4', now - 2 * day, 'ai', 'left'), mk('t-5', now - day, 'friend', 'desync')];
	await page.evaluate(async ms => { await HistoryDB.clear(); for (const m of ms) await HistoryDB.put(m); }, seeded);
	await page.click('#lobby-history-toggle');
	await waitFor(page, () => document.querySelectorAll('#history-modal .hist-row').length === 5, 'history window lists the matches');
	const stats = () => page.evaluate(() => [...document.querySelectorAll('#history-modal .hist-stats b')].map(b => b.textContent).join(' '));
	assert(await stats() === '4 2 2 0 50%', 'stats: walkover is a win, leaving a defeat, desync not counted (' + await stats() + ')');
	await page.click('#history-modal .hist-filter [data-filter="ai"]');
	assert(await stats() === '2 1 1 0 50%' && await page.locator('#history-modal .hist-row').count() === 2, 'filter vs Computer');
	await page.click('#history-modal .hist-filter [data-filter="online"]');
	assert(await page.locator('#history-modal .hist-row').count() === 3, 'filter online');
	await page.click('#history-modal .hist-filter [data-filter="all"]');
	const firstRow = await page.evaluate(() => document.querySelector('#history-modal .hist-row .hist-result').textContent);
	assert(firstRow === 'Desync', 'newest first');
	await page.click('#history-modal .hist-row:nth-child(2) .hist-star');
	await page.waitForTimeout(200);
	assert(await page.evaluate(async () => (await HistoryDB.get('matches', 't-4')).fav === true), 'star is saved');

	// export
	const [download] = await Promise.all([page.waitForEvent('download'), page.click('#history-modal .hist-export')]);
	const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
	assert(exported.format === 'gwent-classic-history' && exported.matches.length === 5 && /^gwent-history-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), 'export downloads the whole history');

	// merge: new, duplicate, hostile and broken records
	const hostile = mk('t-evil', now - day, 'ai', 'win');
	hostile.me.leader = '<img src=x onerror="window.pwned=1">';
	const sneaky = mk('t-ver', now - 6 * day, 'ai', 'lose');
	sneaky.ver = '<b>1</b>';
	const unfinished = { ...mk('t-open', now - 7 * day, 'ai', null), status: 'playing' };
	const file = { format: 'gwent-classic-history', v: 1, matches: [mk('t-new', now - 10 * day, 'quick', 'win'), seeded[0], hostile, sneaky, unfinished, 'junk', { id: '../x' }], replays: [{ id: 't-new', v: 1, bogus: true }] };
	const importFile = async (obj, ...buttons) => {
		await page.setInputFiles('#history-modal .hist-file', { name: 'h.json', mimeType: 'application/json', buffer: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)) });
		for (const b of buttons) {
			await waitFor(page, () => !document.querySelector('#history-modal .hist-ask').classList.contains('hide'), 'import asks');
			await page.click(`#history-modal .hist-ask-buttons button:text-is("${b}")`);
		}
		await page.waitForTimeout(400);
		return page.evaluate(() => document.querySelector('#history-modal .hist-notice').textContent);
	};
	const merged = await importFile(file, 'Merge with my history');
	assert(merged === 'Matches added: 3, skipped: 4.', 'merge adds only new valid matches (' + merged + ')');
	assert(await page.locator('#history-modal .hist-row').count() === 8, 'merged list');
	assert(await page.evaluate(async () => (await HistoryDB.get('matches', 't-ver')).ver === '' && (await HistoryDB.get('matches', 't-open')).result === 'left'), 'imported fields are rebuilt from safe values');
	assert(await page.evaluate(async () => !(await HistoryDB.get('replays', 't-new'))), 'a broken replay is not imported');
	assert(await page.evaluate(() => !window.pwned && !document.querySelector('#history-modal img, #history-modal [onerror]')), 'nothing from the file becomes markup');
	assert(await importFile('not json') === "This file isn't a Gwent Classic match history.", 'a non-history file is refused');

	// replace (asks twice)
	const replaced = await importFile({ format: 'gwent-classic-history', v: 1, matches: [mk('t-only', now, 'ai', 'draw')] }, 'Replace my history', 'Replace my history');
	assert(replaced === 'History replaced. Matches: 1, skipped: 0.' && await page.locator('#history-modal .hist-row').count() === 1, 'replace swaps the whole history');

	// clear
	await page.click('#history-modal .hist-clear');
	await page.click('#history-modal .hist-ask-buttons button:text-is("Delete")');
	await waitFor(page, () => document.querySelector('#history-modal .hist-empty'), 'cleared history shows the empty text');
	await page.keyboard.press('Escape');
	assert(await page.isHidden('#history-modal'), 'Escape closes the window');

	// ---------- running out of storage ----------
	const pruned = await page.evaluate(async () => {
		await HistoryDB.clear();
		const base = { ver: '', mode: 'ai', status: 'done', result: 'win', me: { faction: 'realms', leader: card_dict.find(c => c.row === 'leader').name }, op: { faction: 'realms', leader: card_dict.find(c => c.row === 'leader').name }, rounds: [] };
		const rep = id => ({ id, v: 1, seed: 1, online: false, localRole: 'host', aiRole: 'guest', decks: {}, log: [], sums: [] });
		for (let i = 0; i < 30; i++)
			await HistoryDB.put({ ...base, id: 'q-' + i, ts: 1700000000000 + i, fav: i === 0 }, rep('q-' + i));
		HistoryDB.failWrites = 1;
		await MatchHistory.save({ ...base, id: 'q-new', ts: Date.now(), fav: false }, rep('q-new'));
		const ids = await HistoryDB.replayIds();
		const matches = await HistoryDB.getAll('matches');
		return { ids, matches: matches.length };
	});
	assert(pruned.matches === 31, 'all match summaries kept when storage runs out');
	assert(pruned.ids.includes('q-0') && pruned.ids.includes('q-new') && !pruned.ids.includes('q-1') && pruned.ids.length === 11, 'oldest unstarred replays deleted, starred and new kept (' + pruned.ids.length + ' left)');
	await page.click('#lobby-history-toggle');
	await page.waitForTimeout(300);
	assert(/20 oldest replays were deleted/.test(await page.evaluate(() => document.querySelector('#history-modal .hist-notice').textContent)), 'the player is told replays were deleted');

	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
