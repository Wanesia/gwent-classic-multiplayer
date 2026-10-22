// The replay player: watching a match from the history, the controls and
// keys, seeking (which must land on the same state however it gets there),
// leaving, and downloading one match to watch on another device.
const { chromium } = require('playwright-core');
const fs = require('fs');
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
// Stopped at a gate (Replay.resume is set only while one waits): nothing moves
const settled = page => waitFor(page, () => Replay.resume && !Replay.target && !Replay.result, 'replay paused at a stop', 60000);
const state = page => page.evaluate(() => ({ turn: Replay.turn(), round: game.roundCount, at: Replay.at && Replay.at.kind, sum: mp.checksum(),
	me: player_me.total, op: player_op.total, label: document.querySelector('#replay-bar .rp-label').textContent }));

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage({ acceptDownloads: true });
	watch(page, 'A');
	await page.goto(BASE);
	await page.waitForFunction(() => typeof ReplayUI !== 'undefined');

	// a real match to watch
	await page.click('#split-computer');
	await page.evaluate(() => { GameRNG.randomSeed = () => 4242; GameSpeed.factor = 0.15; dm.loadFactionDeck('monsters', true); document.getElementById('start-game').click(); });
	await installBot(page, 4242);
	await waitFor(page, () => game.state.val === 100, 'recorded match finished', 240000);
	await page.evaluate(() => { window.botStop = true; GameSpeed.factor = 1; });
	await page.waitForTimeout(400);
	await page.reload();
	await page.waitForFunction(() => typeof ReplayUI !== 'undefined');
	const rec = await page.evaluate(async () => { await MatchHistory.ready; const m = (await MatchHistory.list())[0]; return { summary: m, replay: await HistoryDB.get('replays', m.id) }; });
	const turns = rec.replay.sums.length;

	// ---- watching from the history ----
	await page.click('#lobby-history-toggle');
	await waitFor(page, () => document.querySelector('#history-modal .hist-watch') && !document.querySelector('#history-modal .hist-watch').disabled, 'watch button enabled');
	await page.click('#history-modal .hist-row:first-child .hist-watch');
	await waitFor(page, () => mp.replay && game.state.val === 10, 'replay started');
	assert(await page.isHidden('#lobby') && await page.isHidden('#history-modal') && await page.isVisible('#replay-bar'), 'menu and history hidden, controls shown');
	assert((await state(page)).label.endsWith('/' + turns), 'label counts the recorded moves (' + (await state(page)).label + ')');

	await page.click('#replay-bar .rp-speed:text-is("4×")');
	assert(await page.evaluate(() => GameSpeed.factor === 0.25), '4× speed');

	// fold the controls, move them around, keep them on the board
	const box = () => page.locator('#replay-bar').boundingBox();
	const full = await box();
	await page.click('#replay-bar .rp-size');
	const mini = await box();
	assert(await page.evaluate(() => document.getElementById('replay-bar').classList.contains('rp-mini')), 'minimize folds the controls');
	assert(await page.isVisible('#replay-bar .rp-toggle') && await page.isVisible('#replay-bar .rp-label') && await page.isHidden('#replay-bar .rp-nextTurn') && await page.isHidden('#replay-bar .rp-exit'), 'folded: play/pause and the move counter only');
	assert(mini.width < full.width && mini.height < full.height * 0.5, 'folded controls are small (' + Math.round(mini.width) + 'x' + Math.round(mini.height) + ')');
	const drag = async (dx, dy) => {
		const g = await page.locator('#replay-bar .rp-grip').boundingBox();
		await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
		await page.mouse.down();
		await page.mouse.move(g.x + g.width / 2 + dx / 2, g.y + g.height / 2 + dy / 2, { steps: 4 });
		await page.mouse.move(g.x + g.width / 2 + dx, g.y + g.height / 2 + dy, { steps: 4 });
		await page.mouse.up();
	};
	const before = await box();
	await drag(-600, 250);
	const after = await box();
	assert(Math.abs(after.x - (before.x - 600)) < 3 && Math.abs(after.y - (before.y + 250)) < 3, 'folded controls follow the mouse');
	await drag(-5000, 5000);
	const corner = await box();
	const board = await page.locator('main').boundingBox();
	assert(Math.abs(corner.x - board.x) < 2 && Math.abs(corner.y + corner.height - (board.y + board.height)) < 2, 'dragged too far: they stop at the board\'s edge');
	await page.keyboard.press('m');
	const unfolded = await box();
	assert(await page.evaluate(() => !document.getElementById('replay-bar').classList.contains('rp-mini')), 'M unfolds them');
	assert(unfolded.y + unfolded.height <= board.y + board.height + 1 && unfolded.x >= board.x - 1, 'unfolded in a corner, still on the board');
	await drag(700, -300);
	const moved = await box();
	assert(moved.x > unfolded.x + 600, 'the full controls can be dragged too');
	assert(await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('gc-replay-bar')); return s.mini === false && s.x > 0 && s.y > 0; }), 'position remembered');
	// pressing a button doesn't start a drag
	await page.click('#replay-bar .rp-toggle');
	assert((await box()).x === moved.x, 'clicking a button leaves the controls in place');
	await page.click('#replay-bar .rp-toggle');

	// while it plays, the move counter steps one move at a time
	const seen = await page.evaluate(() => new Promise(resolve => {
		const label = document.querySelector('#replay-bar .rp-label'), moves = [];
		const take = () => { const m = label.textContent.match(/(\d+)\/\d+/); if (m && Number(m[1]) !== moves[moves.length - 1]) moves.push(Number(m[1])); };
		take();
		const watcher = new MutationObserver(take);
		watcher.observe(label, { childList: true, characterData: true, subtree: true });
		setTimeout(() => { watcher.disconnect(); resolve(moves); }, 6000);
	}));
	assert(seen.length > 2 && seen.every((m, i) => i === 0 || m === seen[i - 1] + 1), 'the move counter never skips a move (' + seen.join(' ') + ')');
	assert(await page.evaluate(() => /^Round \d+$/.test(document.querySelector('#replay-bar .rp-round').textContent) && /^Move \d+\/\d+$/.test(document.querySelector('#replay-bar .rp-move').textContent)), 'label shows the round and the move side by side');

	// pause with Space: it stops before the next move and stays there
	await waitFor(page, () => Replay.turn() >= 2, 'a few moves played');
	await page.keyboard.press(' ');
	await settled(page);
	const p1 = await state(page);
	await page.waitForTimeout(1500);
	const p2 = await state(page);
	assert(p1.turn === p2.turn && p1.sum === p2.sum, 'paused: nothing changes (move ' + p1.turn + ')');
	assert(await page.evaluate(() => document.querySelector('#replay-bar .rp-toggle').dataset.title) === 'Play', 'the main button offers Play');

	// one move forward, one back: back must give exactly the same state
	await page.click('#replay-bar .rp-nextTurn');
	await waitFor(page, t => Replay.resume && Replay.at.kind === 'turn' && Replay.turn() === t, 'next move', 60000, p1.turn + 1);
	const fwd = await state(page);
	await page.click('#replay-bar .rp-nextTurn');
	await waitFor(page, t => Replay.resume && Replay.at.kind === 'turn' && Replay.turn() === t, 'another move', 60000, p1.turn + 2);
	await page.evaluate(() => {
		window.stillShown = false;
		new MutationObserver(() => { if (document.querySelector('main.replay-still')) window.stillShown = true; })
			.observe(document.body, { childList: true, subtree: true });
	});
	const t0 = Date.now();
	await page.keyboard.press('ArrowLeft');
	await waitFor(page, t => Replay.resume && !Replay.target && Replay.at.kind === 'turn' && Replay.turn() === t, 'previous move (replayed from the start)', 60000, p1.turn + 1);
	console.log('     going back one move took ' + (Date.now() - t0) + 'ms');
	assert(await page.evaluate(() => !document.body.classList.contains('replay-seeking')), 'transitions are back on once there');
	assert(await page.evaluate(() => window.stillShown), 'the board stood still while going back');
	await waitFor(page, () => !document.querySelector('main.replay-still') && document.querySelectorAll('main').length === 1, 'the still board fades out');
	const back = await state(page);
	assert(back.sum === fwd.sum && back.me === fwd.me && back.op === fwd.op, 'going back lands on the same state as going forward (' + back.sum + ')');

	// round ends: the board as it was scored
	for (let r = 1; r <= rec.summary.rounds.length; r++) {
		await page.click('#replay-bar .rp-nextRound');
		const ok = await waitFor(page, r => (Replay.resume && !Replay.target && Replay.at.kind === 'roundEnd' && game.roundCount === r) || Replay.result, 'end of round ' + r, 60000, r);
		const s = await state(page);
		if (!ok || s.at !== 'roundEnd') break;
		const want = rec.summary.rounds[r - 1];
		assert(s.me === want.me && s.op === want.op, 'end of round ' + r + ' shows its score ' + s.me + ':' + s.op);
		if (r === 1 && rec.summary.rounds.length > 1) {
			// forward to round 2's end, then back to round 1's end
			await page.click('#replay-bar .rp-nextRound');
			await waitFor(page, () => Replay.resume && !Replay.target && Replay.at.kind === 'roundEnd' && game.roundCount === 2, 'end of round 2');
			await page.click('#replay-bar .rp-prevRound');
			await waitFor(page, () => Replay.resume && !Replay.target && Replay.at.kind === 'roundEnd' && game.roundCount === 1, 'back to the end of round 1');
			const b = await state(page);
			assert(b.me === want.me && b.op === want.op, 'previous round: back on round 1\'s final board');
		}
	}

	// play to the end
	await page.click('#replay-bar .rp-toggle');
	await waitFor(page, () => Replay.result === 'done' && game.state.val === 100, 'replay played to the end', 120000);
	assert(await page.isVisible('#end-replay-exit') && await page.isHidden('#end-customize') && await page.isHidden('#end-rematch'), 'results offer only "Exit replay"');
	assert(await page.isVisible('#replay-bar') && /End of the match/.test(await page.textContent('#replay-bar .rp-status')), 'controls stay above the results');
	assert(await page.evaluate(() => document.querySelector('#replay-bar .rp-nextTurn').disabled), 'no moving forward past the end');
	await page.keyboard.press('ArrowLeft');
	await waitFor(page, t => Replay.resume && !Replay.target && !Replay.result && Replay.turn() === t, 'rewinding from the end', 60000, turns - 1);
	assert(await page.isHidden('#end-screen'), 'rewinding hides the results');

	// from the start: lands on the first move and plays on
	await page.click('#replay-bar .rp-restart');
	await waitFor(page, () => !Replay.target && !Replay.paused && !Replay.result && Replay.turn() >= 1, 'from the start: playing again from the first move');
	await waitFor(page, () => !document.querySelector('main.replay-still'), 'from the start: the still board fades out');

	// leave: back to the menu with the history open, nothing left behind
	await page.keyboard.press('Escape');
	await waitFor(page, () => !document.getElementById('lobby').classList.contains('hide'), 'back at the main menu');
	assert(await page.evaluate(() => !mp.replay && GameSpeed.factor === 1 && !ReplayUI.isOpen() && player_me.controller.constructor === Controller), 'replay fully left');
	assert(await page.evaluate(() => !document.body.classList.contains('replay-seeking') && document.querySelectorAll('main').length === 1), 'nothing left behind');
	assert(await page.isVisible('#history-modal'), 'the history is open again');
	const lastPos = await page.evaluate(() => localStorage.getItem('gc-replay-bar'));
	await page.click('#history-modal .hist-row:first-child .hist-watch');
	await waitFor(page, () => mp.replay && ReplayUI.isOpen(), 'watching again');
	assert(await page.evaluate(p => { const s = JSON.parse(p), b = document.getElementById('replay-bar'); return b.style.left === (s.x * 100) + 'vw' && b.classList.contains('rp-mini') === s.mini; }, lastPos), 'watching again: the controls are where they were left');
	await page.keyboard.press('Escape');
	await waitFor(page, () => !mp.replay && !document.getElementById('history-modal').classList.contains('hide'), 'left again');

	// a normal match afterwards deals and redraws as usual
	await page.click('#history-modal .fb-close');
	await page.click('#split-computer');
	await page.evaluate(() => document.getElementById('start-game').click());
	await waitFor(page, () => Carousel.curr && player_me.hand.cards.length === 10, 'a normal match after a replay deals 10 cards and opens the redraw');
	assert(await page.evaluate(async () => { await new Promise(r => setTimeout(r, 300)); const m = (await MatchHistory.list())[0]; return m.status === 'playing' && m.id !== undefined; }), 'and it is recorded');
	await page.evaluate(() => { Carousel.curr.cancel(); game.returnToCustomization(); lobby.returnToMenu(); });

	// a match without its replay can't be watched
	await page.evaluate(async () => { const m = (await MatchHistory.list())[1]; await HistoryDB.put({ ...m, id: 'no-replay', ts: Date.now() + 1000, hasReplay: undefined }); });
	await page.click('#lobby-history-toggle');
	await waitFor(page, () => document.querySelectorAll('#history-modal .hist-row').length >= 3, 'history listed');
	assert(await page.evaluate(() => document.querySelector('#history-modal .hist-row:first-child .hist-watch').disabled), 'no replay: watch is disabled');

	// download one match and watch it in another browser
	const [download] = await Promise.all([page.waitForEvent('download'), page.click('#history-modal .hist-row:nth-child(3) .hist-download')]);
	const file = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
	assert(file.matches.length === 1 && file.replays.length === 1 && file.matches[0].id === rec.summary.id && /^gwent-match-/.test(download.suggestedFilename()), 'download gives one match with its replay');
	const B = await (await browser.newContext()).newPage();
	watch(B, 'B');
	await B.goto(BASE);
	await B.waitForFunction(() => typeof ReplayUI !== 'undefined');
	await B.click('#lobby-history-toggle');
	await B.setInputFiles('#history-modal .hist-file', { name: 'm.json', mimeType: 'application/json', buffer: fs.readFileSync(await download.path()) });
	await B.click('#history-modal .hist-ask-buttons button:text-is("Merge with my history")');
	await waitFor(B, () => document.querySelector('#history-modal .hist-watch:not(:disabled)'), 'imported match can be watched');
	await B.click('#history-modal .hist-row:first-child .hist-watch');
	await waitFor(B, () => mp.replay, 'imported replay started');
	await B.evaluate(() => Replay.seek({ roundEnd: 9 }));
	await waitFor(B, () => Replay.result, 'imported replay runs to the end', 120000);
	assert(await B.evaluate(() => Replay.result === 'done' && JSON.stringify(game.roundHistory.map(r => [r.score_me, r.score_op]))) === JSON.stringify(rec.summary.rounds.map(r => [r.me, r.op])), 'the imported replay plays out to the same scores');

	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
