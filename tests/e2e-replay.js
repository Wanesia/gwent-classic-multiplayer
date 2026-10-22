// Replays: every recorded match must play back to exactly the same state.
// A bot plays real matches through the UI code paths (units, specials, decoys,
// scorch, weather, medics, agile row choices, leaders, redraws), the recording
// is then replayed and the state checksum compared after every turn.
const { chromium } = require('playwright-core');
const { installBot } = require('./bot');
const BASE = 'http://localhost:8077/index.html';
const URL = BASE + '?server=ws://localhost:8765';

let failed = false;
const errors = [];
function assert(cond, label) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failed = true; }
async function waitFor(page, fn, label, timeout = 120000, arg) {
	try { await page.waitForFunction(fn, arg, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}
function watch(page, tag) {
	page.on('pageerror', e => { const m = String(e); if (!/play\(\)|NotAllowedError|user didn't interact/i.test(m)) errors.push(tag + ': ' + (e.stack || m)); });
	page.on('console', m => { if (m.type() === 'error' && !/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(m.text())) errors.push(tag + ': ' + m.text()); });
}

// The newest recorded match with its replay
async function lastRecord(page) {
	return page.evaluate(async () => {
		await new Promise(r => setTimeout(r, 300)); // let the final write land
		const list = await MatchHistory.list();
		const summary = list[0];
		const replay = await HistoryDB.get('replays', summary.id);
		return { summary, replay };
	});
}

async function replayAndCompare(page, rec, label, expectChecksum) {
	const out = await page.evaluate(async rec => {
		const r = await Replay.run(rec, { speed: 0.02 });
		const sum = mp.checksum();
		const rounds = game.roundHistory.map(x => [x.score_me, x.score_op]);
		Replay.stop();
		return { ...r, sum, rounds };
	}, rec.replay);
	assert(out.result === 'done', label + ': replay played to the end (' + out.result + ' after ' + out.turns + ' turns)');
	assert(out.turns === rec.replay.sums.length, label + ': every turn checked (' + out.turns + '/' + rec.replay.sums.length + ')');
	if (expectChecksum)
		assert(out.sum === expectChecksum, label + ': final state identical (' + out.sum + ')');
	const recorded = rec.summary.rounds.map(r => [r.me, r.op]);
	assert(JSON.stringify(out.rounds) === JSON.stringify(recorded), label + ': same round scores ' + JSON.stringify(recorded));
	// Skipping to the end (no delays, no card flights) must end the same way
	const skipped = await page.evaluate(rec => new Promise(resolve => {
		Replay.listener = () => { if (Replay.result) { const out = { result: Replay.result, sum: mp.checksum() }; Replay.listener = () => ReplayUI.render(); Replay.stop(); resolve(out); } };
		Replay.start(rec, { roundEnd: 99 });
	}), rec.replay);
	assert(skipped.result === 'done' && (!expectChecksum || skipped.sum === expectChecksum), label + ': skipping to the end gives the same final state');
	return out;
}

async function playVsAI(page, faction, seed) {
	await page.evaluate(({ faction, seed }) => {
		GameRNG.randomSeed = () => seed;
		GameSpeed.factor = 0.15; // recording fast also proves timing doesn't matter
		dm.loadFactionDeck(faction, true);
		document.getElementById('start-game').click();
	}, { faction, seed });
	await installBot(page, seed);
	const ok = await waitFor(page, () => game.state.val === 100, faction + ' vs AI finished', 240000);
	if (!ok) console.log('     bot state: ' + await page.evaluate(() => window.botState()));
	await page.evaluate(() => { window.botStop = true; GameSpeed.factor = 1; });
	if (!ok) return null;
	const finalSum = await page.evaluate(() => mp.checksum());
	const rec = await lastRecord(page);
	await page.evaluate(() => game.returnToCustomization());
	return { rec, finalSum };
}

(async () => {
	const browser = await chromium.launch();

	// ---------- single player: several factions and seeds ----------
	const page = await browser.newPage();
	watch(page, 'SP');
	await page.goto(BASE);
	await page.waitForFunction(() => typeof lobby !== 'undefined' && typeof Replay !== 'undefined');
	await page.click('#split-computer');

	const games = [['realms', 11], ['scoiatael', 22], ['skellige', 33], ['monsters', 44], ['nilfgaard', 55], ['scoiatael', 66]];
	for (const [faction, seed] of games) {
		const g = await playVsAI(page, faction, seed);
		if (!g) continue;
		const { rec } = g;
		assert(rec.summary.status === 'done' && ['win', 'lose', 'draw'].includes(rec.summary.result), faction + ': recorded as finished (' + rec.summary.result + ')');
		assert(rec.summary.mode === 'ai' && rec.replay.aiRole === 'guest' && rec.replay.seed === seed, faction + ': recorded mode, AI role and seed');
		assert(rec.replay.log.length > 0 && rec.replay.sums.length > 0, faction + ': ' + rec.replay.log.length + ' choices and ' + rec.replay.sums.length + ' checksums recorded');
		await replayAndCompare(page, rec, faction + ' #' + seed, g.finalSum);
	}

	// A recording that stops mid-match (left the game) replays up to there
	await page.evaluate(() => { GameRNG.randomSeed = () => 77; GameSpeed.factor = 0.15; document.getElementById('start-game').click(); });
	await installBot(page, 77);
	if (!await waitFor(page, () => game.roundCount === 2 || game.state.val === 100, 'abandoned game reached round 2'))
		console.log('     bot state: ' + await page.evaluate(() => window.botState()));
	await page.evaluate(() => { window.botStop = true; GameSpeed.factor = 1; game.returnToCustomization(); });
	const left = await lastRecord(page);
	assert(left.summary.result === 'left', 'leaving mid-match is recorded as "left"');
	const partial = await page.evaluate(async rec => { const r = await Replay.run(rec, { speed: 0.02 }); Replay.stop(); return r; }, left.replay);
	assert(partial.result === 'ended', 'an abandoned recording replays until it runs out (' + partial.result + ')');

	// A tampered recording stops with "diverged" instead of hanging
	const tampered = JSON.parse(JSON.stringify(left.replay));
	const play = tampered.log.find(e => e[1].t === 'play');
	if (play) {
		play[1].i = 99;
		const r = await page.evaluate(async rec => { const r = await Replay.run(rec, { speed: 0.02 }); Replay.stop(); return r; }, tampered);
		assert(r.result === 'diverged', 'a tampered recording is detected (' + r.result + ')');
	}
	const badSums = JSON.parse(JSON.stringify(left.replay));
	badSums.sums = badSums.sums.map(() => 'deadbeef');
	const r2 = await page.evaluate(async rec => { const r = await Replay.run(rec, { speed: 0.02 }); Replay.stop(); return r; }, badSums);
	assert(r2.result === 'diverged' && r2.turns === 1, 'a checksum mismatch stops the replay at the first turn');

	// After a replay the next real match is recorded normally
	assert(await page.evaluate(() => !mp.replay && GameSpeed.factor === 1 && player_me.controller.constructor === Controller), 'replay fully detached');

	// ---------- online: both clients' recordings replay ----------
	const A = await (await browser.newContext()).newPage();
	const B = await (await browser.newContext()).newPage();
	watch(A, 'A'); watch(B, 'B');
	await A.goto(URL); await B.goto(URL);
	await A.click('#split-player'); await A.click('#lobby-create-button');
	await A.waitForFunction(() => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent));
	const code = await A.textContent('#room-code');
	await B.click('#split-player'); await B.click('#lobby-join-button');
	await B.fill('#join-code', code);
	await waitFor(A, () => lobby.inMultiplayer, 'host in deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'guest in deck setup');
	await A.evaluate(() => dm.loadFactionDeck('scoiatael', true));
	await B.evaluate(() => dm.loadFactionDeck('skellige', true));
	// Not much faster: on a busy machine the relay handles buffered messages in
	// a burst and drops the client for flooding (close code 1008)
	await A.evaluate(() => { GameSpeed.factor = 0.5; document.getElementById('start-game').click(); });
	await B.waitForFunction(() => lobby.remoteReady);
	await B.evaluate(() => { GameSpeed.factor = 0.5; document.getElementById('start-game').click(); });
	await waitFor(A, () => game.state.val === 10, 'online match started');
	for (const p of [A, B])
		await p.evaluate(() => Net.socket.addEventListener('close', e => window.botClose = e.code + ' ' + e.reason));
	await installBot(A, 101); await installBot(B, 202);
	const aEnd = await waitFor(A, () => game.state.val === 100, 'online match finished (host)', 300000);
	const bEnd = await waitFor(B, () => game.state.val === 100, 'online match finished (guest)', 300000);
	if (!aEnd || !bEnd)
		for (const [tag, p] of [['A', A], ['B', B]])
			console.log('     bot ' + tag + ': ' + await p.evaluate(() => window.botState() + ' popups ' + JSON.stringify(window.botPopups || []) + ' socket ' + (window.botClose || 'open')));
	await A.evaluate(() => { window.botStop = true; GameSpeed.factor = 1; });
	await B.evaluate(() => { window.botStop = true; GameSpeed.factor = 1; });
	if (aEnd && bEnd) {
		const sumA = await A.evaluate(() => mp.checksum());
		const sumB = await B.evaluate(() => mp.checksum());
		const recA = await lastRecord(A);
		const recB = await lastRecord(B);
		const opposite = { win: 'lose', lose: 'win', draw: 'draw' };
		assert(recA.summary.mode === 'friend' && recB.summary.mode === 'friend', 'online matches recorded as "friend"');
		assert(opposite[recA.summary.result] === recB.summary.result, 'opposite results on both clients (' + recA.summary.result + ' / ' + recB.summary.result + ')');
		assert(recA.replay.seed === recB.replay.seed && recA.replay.localRole === 'host' && recB.replay.localRole === 'guest', 'same seed, own roles');
		// The two players' choices interleave differently on each client (e.g.
		// simultaneous redraws); each player's own sequence must match
		const byRole = log => JSON.stringify(['host', 'guest'].map(role => log.filter(e => e[0] === role).map(e => e[1])));
		assert(byRole(recA.replay.log) === byRole(recB.replay.log), 'both clients recorded the same choices per player (' + recA.replay.log.length + ')');
		assert(JSON.stringify(recA.replay.sums) === JSON.stringify(recB.replay.sums), 'both clients recorded the same checksums');
		// Each client's recording replays on its own page, and on a fresh one
		await A.evaluate(() => game.returnToCustomization());
		await replayAndCompare(A, recA, 'online (host)', sumA);
		await replayAndCompare(page, recB, 'online (guest, another browser)', sumB);
	}

	assert(errors.length === 0, 'no js errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
