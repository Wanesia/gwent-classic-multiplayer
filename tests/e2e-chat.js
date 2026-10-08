// End-to-end quick chat test: chat is on by default and can be switched off and on
// mid-match, arrives translated into the receiver's language, is rate-limited
// and filtered on both ends, shows whether the opponent has it switched on,
// keeps the picker open on slow/diagonal mouse paths and when pinned by a
// click, and never disturbs the lockstep game (the match is played out to the
// end screen with matching checksums).
const { chromium } = require('playwright-core');

const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';
const errors = { A: [], B: [] };

function watch(page, tag) {
	page.on('pageerror', e => {
		const msg = String(e);
		if (/play\(\)|NotAllowedError|the user didn't interact/i.test(msg)) return; // headless audio
		errors[tag].push(e.stack || msg);
	});
	page.on('console', m => {
		if (m.type() !== 'error') return;
		const txt = m.text();
		if (/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(txt)) return;
		errors[tag].push(txt);
	});
}

let failed = false;
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}

async function waitFor(page, fn, label, timeout = 30000, arg = null) {
	try {
		await page.waitForFunction(fn, arg, { timeout });
		return true;
	} catch (e) {
		console.log('FAIL (timeout) ' + label);
		failed = true;
		return false;
	}
}

const picking = page => page.evaluate(() => document.getElementById('chat-picker').classList.contains('open'));
const opState = page => page.evaluate(() => {
	const el = document.getElementById('chat-op-state');
	return { on: !el.classList.contains('off'), title: el.getAttribute('data-title') };
});
const center = (page, sel) => page.evaluate(s => {
	const r = document.querySelector(s).getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, sel);
const EN_ON = 'Opponent: quick chat on, text chat off (click to mute)';
const EN_OFF = 'Opponent: quick chat off, text chat off (click to mute)';
const PL_ON = 'Przeciwnik: szybki czat włączony, czat tekstowy wyłączony (kliknij, aby wyciszyć)';
const PL_OFF = 'Przeciwnik: szybki czat wyłączony, czat tekstowy wyłączony (kliknij, aby wyciszyć)';

// Flips a switch in the chat settings popover on the cog, then closes it
async function toggleSetting(page, setting) {
	await page.click('#toggle-chat-settings');
	await page.click('#chat-settings [data-setting="' + setting + '"]');
	await page.keyboard.press('Escape');
}

const layerShown = page => page.evaluate(() => !document.getElementById('chat-layer').classList.contains('hide'));
const bubble = (page, who) => page.evaluate(w => {
	const b = document.getElementById('chat-bubble-' + w);
	return b.classList.contains('show') ? b.textContent : null;
}, who);

// The flows below opt in from chat off; seeded only when unset so reloads keep toggles
const startChatOff = () => {
	if (localStorage.getItem('gc-quick-chat') === null) {
		localStorage.setItem('gc-quick-chat', 'false');
		localStorage.setItem('gc-text-chat', 'false');
	}
};

(async () => {
	const browser = await chromium.launch();
	// --- a new player starts with quick and text chat on ---
	const fresh0 = await (await browser.newContext()).newPage();
	await fresh0.goto(URL);
	await fresh0.waitForFunction(() => typeof lobby !== 'undefined');
	assert(await fresh0.evaluate(() => Settings.quickChat.isEnabled() && Settings.textChat.isEnabled()), 'quick and text chat are on by default');
	await fresh0.close();

	const aCtx = await browser.newContext();
	await aCtx.addInitScript(startChatOff);
	const A = await aCtx.newPage(); // host, English
	const bCtx = await browser.newContext();
	await bCtx.addInitScript(startChatOff);
	await bCtx.addInitScript(() => localStorage.setItem('lang', 'pl'));
	const B = await bCtx.newPage(); // guest, Polish
	watch(A, 'A'); watch(B, 'B');

	await A.goto(URL); await B.goto(URL);
	await A.waitForFunction(() => typeof lobby !== 'undefined');
	await B.waitForFunction(() => typeof lobby !== 'undefined');

	await A.click('#split-player');
	await A.click('#lobby-create-button');
	await waitFor(A, () => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent), 'host got room code');
	const code = await A.textContent('#room-code');
	await B.click('#split-player');
	await B.click('#lobby-join-button');
	await B.fill('#join-code', code);
	await waitFor(A, () => lobby.inMultiplayer, 'host entered deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'guest entered deck setup');

	// record what the host hears in the lobby
	await A.evaluate(() => {
		window.lobbyMsgs = [];
		const route = lobby.routeLobby.bind(lobby);
		lobby.routeLobby = m => { window.lobbyMsgs.push(m); route(m); };
	});

	// the guest's setting travels with its lobby-ready
	await toggleSetting(B, 'quickChat');
	await B.evaluate(() => document.getElementById('start-game').click());
	await waitFor(A, () => lobby.remoteReady, 'host sees guest ready');
	assert(await A.evaluate(() => lobby.peerChatQuick === true && lobby.peerChatText === false && window.lobbyMsgs.some(m => m.t === 'lobby-ready' && m.chatQuick === true && m.chatText === false)), 'initial opponent chat state arrives with lobby-ready');

	// a toggle after readying waits until the host has advertised chat support
	await toggleSetting(B, 'quickChat');
	await A.waitForTimeout(300);
	assert(await A.evaluate(() => lobby.peerChatQuick === true && !window.lobbyMsgs.some(m => m.t === 'chat-state')), 'no chat-state sent before the peer advertised chat support');

	await A.evaluate(() => { GameRNG.randomSeed = () => 1; });
	await A.evaluate(() => document.getElementById('start-game').click());
	await waitFor(A, () => mp.active && game.state.val === 10, 'host game started');
	await waitFor(B, () => mp.active && game.state.val === 10, 'guest game started');

	assert(await A.evaluate(() => lobby.peerChat) && await B.evaluate(() => lobby.peerChat), 'both clients advertised chat support');

	// --- the deferred toggle reached the host before the match started ---
	assert(await A.evaluate(() => window.lobbyMsgs.some(m => m.t === 'chat-state' && m.quick === false && m.text === false) && lobby.peerChatQuick === false), 'deck-builder toggle arrives through the lobby once both are ready');
	let st = await opState(A);
	assert(!st.on && st.title === EN_OFF, 'host indicator shows the guest chat off: ' + st.title);
	st = await opState(B);
	assert(!st.on && st.title === PL_OFF, 'guest indicator shows the host chat off: ' + st.title);

	// --- starting from chat off ---
	assert(await A.evaluate(() => !Settings.quickChat.isEnabled()), 'quick chat is off');
	assert(!(await layerShown(A)) && !(await layerShown(B)), 'chat button hidden while chat is off');
	assert(await A.evaluate(() => document.querySelector('#chat-settings [data-setting="quickChat"]').getAttribute('aria-checked') === 'false'), 'settings switch shows quick chat off');

	// --- opt in mid-match (during the redraw) via the settings toggle ---
	await waitFor(A, () => Carousel.curr, 'host redraw open');
	await toggleSetting(A, 'quickChat');
	assert(await A.evaluate(() => Carousel.curr !== null), 'Escape closing the settings popover leaves the redraw open');
	await waitFor(B, () => lobby.peerChatQuick === true, 'mid-match toggle reaches the guest');
	await toggleSetting(B, 'quickChat');
	assert(await layerShown(A) && await layerShown(B), 'chat button appears after opting in');
	st = await opState(B);
	assert(st.on && st.title === PL_ON, 'guest indicator lights up with the toggle: ' + st.title);
	await waitFor(A, () => !document.getElementById('chat-op-state').classList.contains('off'), 'host indicator lights up with the toggle');
	st = await opState(A);
	assert(st.on && st.title === EN_ON, 'host indicator tooltip follows the toggle: ' + st.title);

	// --- sending through the real picker: hover opens it, click sends ---
	await A.hover('#chat-button');
	await waitFor(A, () => document.getElementById('chat-picker').classList.contains('open'), 'hover opens the picker');
	await A.click('#chat-picker [data-chat="goodLuck"]');
	assert(await A.evaluate(() => !document.getElementById('chat-picker').classList.contains('open')), 'picker closes after sending');
	assert(await bubble(A, 'me') === 'Good luck!', 'sender sees own bubble');
	await waitFor(B, () => document.getElementById('chat-bubble-op').classList.contains('show'), 'receiver gets a bubble');
	assert(await bubble(B, 'op') === 'Powodzenia!', 'receiver reads it in their own language: ' + await bubble(B, 'op'));

	await B.evaluate(() => QuickChat.send('wave'));
	await waitFor(A, () => document.getElementById('chat-bubble-op').textContent === '👋', 'emote arrives');

	// finish the redraw so the match proceeds
	await A.evaluate(() => Carousel.curr && Carousel.curr.cancel());
	await waitFor(B, () => Carousel.curr, 'guest redraw open');
	await B.evaluate(() => Carousel.curr.cancel());
	await waitFor(A, () => game.roundCount === 1 && game.currPlayer, 'round 1 started');

	// --- slow diagonal path from the button up-right to the far-right phrase ---
	await A.evaluate(() => { QuickChat.closePicker(); QuickChat.sendBucket.reset(); });
	const from = await center(A, '#chat-button');
	await A.mouse.move(from.x, from.y);
	await waitFor(A, () => document.getElementById('chat-picker').classList.contains('open'), 'hover opens the picker');
	await A.waitForTimeout(250);
	const to = await center(A, '#chat-picker [data-chat="bye"]');
	let stayedOpen = true;
	for (let i = 1; i <= 30; i++) {
		await A.mouse.move(from.x + (to.x - from.x) * i / 30, from.y + (to.y - from.y) * i / 30);
		await A.waitForTimeout(40);
		if (!(await picking(A))) stayedOpen = false;
	}
	assert(stayedOpen, 'picker stays open along a slow diagonal path');
	await A.mouse.down(); await A.mouse.up();
	await waitFor(B, () => document.getElementById('chat-bubble-op').textContent === 'Na razie!', 'phrase reached by the diagonal path is sent');

	// --- a click pins the picker open until Escape or a click outside ---
	await A.evaluate(() => QuickChat.sendBucket.reset());
	await A.click('#chat-button');
	await A.mouse.move(A.viewportSize().width * 0.6, A.viewportSize().height * 0.5);
	await A.waitForTimeout(1200);
	assert(await picking(A), 'clicked picker survives the mouse leaving');
	await A.keyboard.press('Escape');
	assert(!(await picking(A)), 'Escape closes the pinned picker');
	await A.click('#chat-button');
	const vw = A.viewportSize().width / 100;
	await A.mouse.click(18 * vw, 11 * vw);
	assert(!(await picking(A)), 'a click outside closes the pinned picker');
	await A.mouse.move(A.viewportSize().width * 0.6, A.viewportSize().height * 0.5);

	// --- sender rate limit: a burst of 3, the rest dropped ---
	await B.evaluate(() => { window.chatSeen = 0; const show = QuickChat.show.bind(QuickChat); QuickChat.show = (w, id) => { if (w === 'op') window.chatSeen++; show(w, id); }; });
	await A.evaluate(() => { QuickChat.sendBucket.reset(); for (let i = 0; i < 6; i++) QuickChat.send('oops'); });
	await A.waitForTimeout(800);
	assert(await B.evaluate(() => window.chatSeen) === 3, 'only 3 of 6 rapid messages sent (got ' + await B.evaluate(() => window.chatSeen) + ')');
	assert(await A.evaluate(() => document.getElementById('chat-layer').classList.contains('chat-cooldown')), 'sender picker greyed out during cooldown');

	// --- the cooldown is explained with a live countdown ---
	await A.evaluate(() => QuickChat.openPicker());
	const note = () => A.evaluate(() => {
		const n = document.getElementById('chat-cooldown-note');
		return getComputedStyle(n).display === 'none' ? null : { text: n.textContent, badge: document.getElementById('chat-button').dataset.cooldown };
	});
	const n1 = await note();
	const secs = n1 && +(n1.text.match(/\d+/) || [])[0];
	assert(n1 && /^Chat unlocks in \d+s \(prevents spam\)$/.test(n1.text) && secs >= 1 && secs <= 4, 'cooldown banner shows the seconds left: ' + (n1 && n1.text));
	assert(n1 && +n1.badge === secs, 'chat button badge shows the same countdown');
	await A.waitForTimeout(1100);
	const n2 = await note();
	assert(!n2 || +(n2.text.match(/\d+/) || [])[0] < secs, 'countdown ticks down: ' + (n2 && n2.text));
	await waitFor(A, () => !document.getElementById('chat-layer').classList.contains('chat-cooldown'), 'chat unlocks again', 6000);
	assert(await note() === null && await A.evaluate(() => !('cooldown' in document.getElementById('chat-button').dataset)), 'banner and badge disappear once unlocked');
	await A.evaluate(() => QuickChat.closePicker());

	// --- receiver filtering: unknown ids and floods from a modified client ---
	await B.evaluate(() => { window.chatSeen = 0; QuickChat.recvBucket.reset(); });
	await A.evaluate(() => { mp.send({ t: 'chat', q: 'toString' }); mp.send({ t: 'chat', q: '<img src=x>' }); mp.send({ t: 'chat' }); });
	for (let i = 0; i < 8; i++) await A.evaluate(() => mp.send({ t: 'chat', q: 'bye' }));
	await A.waitForTimeout(800);
	assert(await B.evaluate(() => window.chatSeen) === 4, 'receiver ignores unknown ids and caps a flood at 4 (got ' + await B.evaluate(() => window.chatSeen) + ')');
	assert(await B.evaluate(() => mp.active), 'bad chat messages did not desync the match');

	// --- opting out: nothing shown, nothing sent ---
	await toggleSetting(B, 'quickChat');
	assert(!(await layerShown(B)), 'chat button hidden after opting out');
	await waitFor(A, () => document.getElementById('chat-op-state').classList.contains('off'), 'opponent indicator dims when they opt out');
	st = await opState(A);
	assert(!st.on && st.title === EN_OFF, 'opponent indicator tooltip says they won\'t see messages: ' + st.title);
	await B.evaluate(() => { window.chatSeen = 0; QuickChat.recvBucket.reset(); });
	await A.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.send('hello'); });
	await A.waitForTimeout(500);
	assert(await B.evaluate(() => window.chatSeen) === 0, 'opted-out player receives nothing');
	await toggleSetting(B, 'quickChat');
	await waitFor(A, () => !document.getElementById('chat-op-state').classList.contains('off'), 'opponent indicator lights up when they opt back in');

	// --- an opponent on an older client: no chat UI ---
	await A.evaluate(() => { lobby.peerChat = false; QuickChat.refresh(); });
	assert(!(await layerShown(A)), 'no chat button against a client without chat support');
	await A.evaluate(() => { lobby.peerChat = true; QuickChat.refresh(); });

	// --- chat mid-turn, then play the match out: checksums must still agree ---
	const pages = { A, B };
	for (const [tag, page] of Object.entries(pages)) {
		(async () => {
			for (let i = 0; i < 8; i++) {
				try {
					await page.waitForFunction(
						() => game.state.val === 100 || (game.currPlayer === player_me && !player_me.passed && !document.getElementsByTagName('main')[0].classList.contains('noclick')),
						null, { timeout: 60000 });
					if (await page.evaluate(() => game.state.val === 100)) return;
					// the other player chats while this one is mid-turn
					const other = page === A ? B : A;
					await other.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.send('watchThis'); });
					await page.waitForTimeout(200);
					await page.evaluate(() => document.getElementById('pass-button').click());
					await page.waitForTimeout(500);
				} catch (e) { return; }
			}
		})();
	}
	const aEnd = await waitFor(A, () => game.state.val === 100, 'host reached end screen', 90000);
	const bEnd = await waitFor(B, () => game.state.val === 100, 'guest reached end screen', 90000);
	if (aEnd && bEnd) {
		assert(await A.evaluate(() => mp.checksum()) === await B.evaluate(() => mp.checksum()), 'final checksums match after chatting');

		// --- "gg" from the end screen ---
		assert(await layerShown(A), 'chat still available on the end screen');
		await A.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.send('goodGame'); });
		await waitFor(B, () => document.getElementById('chat-bubble-op').textContent === 'Dobra gra!', 'end-screen message arrives');
	}

	assert(errors.A.length === 0, 'no js errors on host' + (errors.A.length ? ': ' + errors.A.join(' | ') : ''));
	assert(errors.B.length === 0, 'no js errors on guest' + (errors.B.length ? ': ' + errors.B.join(' | ') : ''));

	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
