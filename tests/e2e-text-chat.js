// End-to-end text chat test: the chat settings cog and its persistence, text
// and quick messages in the bubbles and the log, "what you switch off you
// neither send nor see", sanitizing of untrusted text, the disabled input when
// the opponent can't read it, muting, the T shortcut and typing that never
// reaches game shortcuts, the card preview covering the log, the unread badge,
// the cooldown shared with quick chat, and a full match with chat throughout
// that ends with matching checksums and a rematch that resets the mute.
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

// Flips a switch in the chat settings popover on the cog, then closes it
async function toggleSetting(page, setting) {
	await page.click('#toggle-chat-settings');
	await page.click('#chat-settings [data-setting="' + setting + '"]');
	await page.keyboard.press('Escape');
}
const switchOn = (page, setting) => page.evaluate(s =>
	document.querySelector('#chat-settings [data-setting="' + s + '"]').getAttribute('aria-checked') === 'true', setting);

const logShown = page => page.evaluate(() => getComputedStyle(document.getElementById('chat-log')).display !== 'none');
const logEntries = page => page.evaluate(() => [...document.querySelectorAll('#chat-log-list .chat-entry')].map(e => ({
	who: e.classList.contains('chat-entry-me') ? 'me' : 'op',
	text: e.querySelector('.chat-entry-text').textContent
})));
const lastEntry = async page => (await logEntries(page)).pop() || null;
const bubble = (page, who) => page.evaluate(w => {
	const b = document.getElementById('chat-bubble-' + w);
	return b.classList.contains('show') ? b.textContent : null;
}, who);
const fresh = (...pages) => Promise.all(pages.map(p => p.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.recvBucket.reset(); })));
const myTurn = () => game.currPlayer === player_me && !player_me.passed && !document.getElementsByTagName('main')[0].classList.contains('noclick');

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

	// --- the cog in the main menu, starting from chat off; no mute outside a match ---
	assert(await A.evaluate(() => !Settings.textChat.isEnabled() && !Settings.quickChat.isEnabled()), 'both chats start off');
	await A.click('#toggle-chat-settings');
	assert(await A.evaluate(() => document.getElementById('toggle-chat-settings').classList.contains('open')), 'cog opens the chat settings in the menu');
	assert(await A.evaluate(() => getComputedStyle(document.querySelector('#chat-settings [data-setting="mute"]')).display === 'none'), 'no mute switch outside a match');
	assert(await A.evaluate(() => document.querySelector('#chat-settings [data-setting="textChat"]').disabled), 'text chat switch is disabled until quick chat is on');
	await A.click('#chat-settings [data-setting="quickChat"]');
	await A.click('#chat-settings [data-setting="textChat"]');
	assert(await switchOn(A, 'textChat') && await A.evaluate(() => localStorage.getItem('gc-text-chat') === 'true'), 'text chat switch turns on and is saved');
	await A.mouse.click(800, 300);
	assert(await A.evaluate(() => !document.getElementById('toggle-chat-settings').classList.contains('open')), 'a click outside closes the chat settings');
	await A.click('#toggle-chat-settings');
	await A.keyboard.press('Escape');
	assert(await A.evaluate(() => !document.getElementById('toggle-chat-settings').classList.contains('open')), 'Escape closes the chat settings');
	await A.reload();
	await A.waitForFunction(() => typeof lobby !== 'undefined');
	assert(await A.evaluate(() => Settings.textChat.isEnabled() && Settings.quickChat.isEnabled()) && await switchOn(A, 'textChat') && await switchOn(A, 'quickChat'), 'both settings survive a reload');

	// --- into a match; the guest opts in from the deck builder ---
	await A.click('#split-player');
	await A.click('#lobby-create-button');
	await waitFor(A, () => /^[2-9A-Z]{5}$/.test(document.getElementById('room-code').textContent), 'host got room code');
	const code = await A.textContent('#room-code');
	await B.click('#split-player');
	await B.click('#lobby-join-button');
	await B.fill('#join-code', code);
	await waitFor(A, () => lobby.inMultiplayer, 'host entered deck setup');
	await waitFor(B, () => lobby.inMultiplayer, 'guest entered deck setup');
	await toggleSetting(B, 'quickChat');
	await toggleSetting(B, 'textChat');

	await A.evaluate(() => { GameRNG.randomSeed = () => 1; });
	await A.evaluate(() => document.getElementById('start-game').click());
	await waitFor(B, () => lobby.remoteReady, 'guest sees host ready');
	await B.evaluate(() => document.getElementById('start-game').click());
	await waitFor(A, () => mp.active && game.state.val === 10, 'host game started');
	await waitFor(B, () => mp.active && game.state.val === 10, 'guest game started');
	assert(await A.evaluate(() => lobby.peerChatQuick && lobby.peerChatText) && await B.evaluate(() => lobby.peerChatQuick && lobby.peerChatText), 'both clients know the other has quick and text chat on');

	// the log stays out of the redraw picker's way
	await waitFor(A, () => Carousel.curr, 'host redraw open');
	assert(!(await logShown(A)), 'log hidden behind the redraw');
	await A.evaluate(() => Carousel.curr.cancel());
	await waitFor(B, () => Carousel.curr, 'guest redraw open');
	await B.evaluate(() => Carousel.curr.cancel());
	await waitFor(A, () => game.roundCount === 1 && game.currPlayer && !Carousel.curr, 'round 1 started (host)');
	await waitFor(B, () => game.roundCount === 1 && game.currPlayer && !Carousel.curr, 'round 1 started (guest)');
	assert(await logShown(A) && await logShown(B), 'log shown once the board is visible');
	assert(await A.evaluate(() => {
		const el = document.getElementById('chat-op-state');
		return el.classList.contains('text') && el.getAttribute('data-title') === 'Opponent: quick chat on, text chat on (click to mute)';
	}), 'opponent indicator shows their text chat is on');
	assert(await switchOn(A, 'mute') === false && await A.evaluate(() => getComputedStyle(document.querySelector('#chat-settings [data-setting="mute"]')).display !== 'none'), 'mute switch offered during the match');

	// --- text roundtrip into the bubble and the log, typed for real ---
	await A.click('#chat-input');
	await A.keyboard.type('Hello there, good luck! 🙂');
	await A.keyboard.press('Enter');
	assert(await A.evaluate(() => document.getElementById('chat-input').value === ''), 'Enter sends and clears the input');
	assert(await bubble(A, 'me') === 'Hello there, good luck! 🙂', 'sender sees own text bubble');
	let e = await lastEntry(A);
	assert(e && e.who === 'me' && e.text === 'Hello there, good luck! 🙂', 'sender log shows the message as You');
	await waitFor(B, () => document.getElementById('chat-bubble-op').classList.contains('show'), 'receiver gets a text bubble');
	assert(await bubble(B, 'op') === 'Hello there, good luck! 🙂', 'receiver bubble shows the text');
	e = await lastEntry(B);
	assert(e && e.who === 'op' && e.text === 'Hello there, good luck! 🙂', 'receiver log shows it as Opponent');
	assert(await B.evaluate(() => document.querySelector('#chat-log-list .chat-entry-op .chat-entry-who').textContent === 'Przeciwnik'), 'log labels are translated');
	const longMs = await B.evaluate(() => { const t = 'x'.repeat(120); QuickChat.showText('op', t); return parseInt(document.getElementById('chat-bubble-op').style.getPropertyValue('--chat-ms')); });
	assert(longMs === 9000, 'long messages stay up longer, capped at 9s (got ' + longMs + 'ms)');
	await A.keyboard.press('Escape');
	assert(await A.evaluate(() => document.activeElement !== document.getElementById('chat-input') && !Popup.curr), 'Escape leaves the input without opening the quit popup');

	// --- quick messages land in the log in each reader's language ---
	await fresh(A, B);
	await A.evaluate(() => QuickChat.send('goodLuck'));
	e = await lastEntry(A);
	assert(e && e.who === 'me' && e.text === 'Good luck!', 'own quick message in the log');
	await waitFor(B, () => document.querySelector('#chat-log-list .chat-entry:last-child .chat-entry-text').textContent === 'Powodzenia!', 'quick message in the receiver log, in Polish');
	await B.evaluate(() => QuickChat.send('wave'));
	await waitFor(A, () => document.querySelector('#chat-log-list .chat-entry:last-child .chat-entry-text').textContent === '👋', 'emote in the log');

	// --- T focuses the input; typing never reaches game shortcuts ---
	let P = null;
	for (let i = 0; i < 100 && !P; i++) {
		P = (await A.evaluate(myTurn)) ? A : (await B.evaluate(myTurn)) ? B : null;
		if (!P) await A.waitForTimeout(200);
	}
	assert(P !== null, 'a player has the turn');
	P = P || A;
	const O = P === A ? B : A;
	await P.evaluate(() => document.activeElement.blur());
	await P.keyboard.press('t');
	assert(await P.evaluate(() => document.activeElement === document.getElementById('chat-input') && document.getElementById('chat-input').value === ''), 'T focuses the input without typing a t');
	await P.keyboard.down('p');
	await P.waitForTimeout(1400); // longer than the hold-to-pass delay
	await P.keyboard.up('p');
	await P.keyboard.type('ass e q');
	await P.keyboard.press('Backspace');
	await P.keyboard.type('done');
	await P.waitForTimeout(300);
	assert(await P.evaluate(() => !player_me.passed && player_me.leaderAvailable && ui.previewCard === null && game.currPlayer === player_me),
		'typing "pass", "e", "q", space and Backspace did not pass, use the leader or pick a card');
	assert(await P.evaluate(() => document.getElementById('chat-input').value) === 'pass e done', 'the typed text is all in the input');
	await fresh(P, O);
	await P.keyboard.press('Enter');
	await waitFor(O, () => document.querySelector('#chat-log-list .chat-entry:last-child .chat-entry-text').textContent === 'pass e done', 'message typed on your turn arrives');
	await P.keyboard.press('Escape');

	// --- the card preview covers the log; the log is back afterwards ---
	const covered = () => A.evaluate(() => {
		const r = document.getElementById('chat-log').getBoundingClientRect();
		const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return !document.getElementById('chat-log').contains(el);
	});
	await A.evaluate(() => ui.showPreviewVisuals(player_me.hand.cards[0]));
	assert(await covered(), 'card preview covers the log');
	await A.evaluate(() => ui.hidePreview());
	assert(!(await covered()), 'log visible again after the preview');

	// --- sanitizing on receive: a raw message from a modified client ---
	const rawText = async s => {
		await B.evaluate(() => QuickChat.recvBucket.reset());
		const before = (await logEntries(B)).length;
		await A.evaluate(s => mp.send({ t: 'chat-text', s }), s);
		await B.waitForTimeout(250);
		const list = await logEntries(B);
		return list.length > before ? list[list.length - 1].text : null;
	};
	const html = '<img src=x onerror="window.pwned=1"><b>bold</b>';
	assert(await rawText(html) === html, 'HTML is shown literally');
	assert(await B.evaluate(() => !document.querySelector('#chat-log-list img, #chat-log-list b, #chat-bubble-op img') && !window.pwned), 'no markup is created from a message');
	assert(await rawText('abc‮def⁦ghi​jk﻿l‏m') === 'abcdefghijklm', 'bidi controls and zero-width characters are stripped');
	const emoji = '😀'.repeat(200);
	const capped = await rawText(emoji);
	assert(capped !== null && Array.from(capped).length === 120, 'capped at 120 code points, emoji included (got ' + (capped && Array.from(capped).length) + ')');
	assert(await rawText('  multiple\n\n  lines\t here  ') === 'multiple lines here', 'whitespace collapsed into one line');
	assert(await rawText(' ​\n\tㅤ ') === null, 'whitespace-only message dropped');
	assert(await rawText(42) === null, 'non-string text dropped');
	await A.evaluate(() => { mp.send({ t: 'chat-text' }); mp.send({ t: 'chat-whatever', x: 1 }); });
	await B.waitForTimeout(250);
	assert(await A.evaluate(() => mp.active) && await B.evaluate(() => mp.active), 'malformed and unknown chat messages did not desync');
	assert(await A.evaluate(() => sanitizeChatText('  a\u0000b‪c  ') === 'a bc' && sanitizeChatText('e' + '́'.repeat(30)).length === 5), 'the same sanitizer runs on send');

	// --- see/send matrix: text off drops text, quick off drops quick ---
	await toggleSetting(B, 'textChat');
	assert(!(await logShown(B)), 'text chat off hides the log');
	await waitFor(A, () => document.getElementById('chat-log').classList.contains('peer-off'), 'sender sees the opponent turned text chat off');
	assert(await A.evaluate(() => document.getElementById('chat-input').disabled && getComputedStyle(document.getElementById('chat-log-off')).display !== 'none'), 'input disabled with a notice while the opponent has text chat off');
	assert(await A.evaluate(() => QuickChat.sendText('anyone?')) === false, 'nothing sent to an opponent with text chat off');
	await B.evaluate(() => { window.seen = 0; const d = QuickChat.display.bind(QuickChat); QuickChat.display = (w, ...r) => { if (w === 'op') window.seen++; d(w, ...r); }; });
	await fresh(A, B);
	await A.evaluate(() => mp.send({ t: 'chat-text', s: 'sneaky' }));
	await A.evaluate(() => QuickChat.send('oops'));
	await B.waitForTimeout(400);
	assert(await B.evaluate(() => window.seen) === 1 && await bubble(B, 'op') === 'Ups!', 'with text off only the quick message is shown');
	await toggleSetting(B, 'textChat');
	await waitFor(A, () => !document.getElementById('chat-log').classList.contains('peer-off'), 'sender sees text back on');
	assert(await B.evaluate(() => document.getElementById('chat-button').classList.contains('text')), 'own quick chat button shows the Aa tag with text on');
	await toggleSetting(B, 'quickChat');
	assert(await B.evaluate(() => !Settings.textChat.isEnabled()) && !(await logShown(B)), 'turning quick chat off turns text chat off too');
	await waitFor(A, () => document.getElementById('chat-log').classList.contains('peer-off') && lobby.peerChatQuick === false, 'sender sees both chats off');
	await waitFor(A, () => document.getElementById('chat-op-state').classList.contains('off'), 'opponent icon shows opted out');
	await fresh(A, B);
	await B.evaluate(() => { window.seen = 0; });
	await A.evaluate(() => QuickChat.send('bye'));
	await A.evaluate(() => mp.send({ t: 'chat-text', s: 'still here?' }));
	await B.waitForTimeout(400);
	assert(await B.evaluate(() => window.seen) === 0, 'with chat off nothing is shown');
	assert(await B.evaluate(() => document.getElementById('chat-layer').classList.contains('hide')), 'no chat UI with chat off');
	await toggleSetting(B, 'quickChat');
	await toggleSetting(B, 'textChat');

	// --- collapsed log counts unread messages and is remembered ---
	await A.click('#chat-log-head');
	assert(await A.evaluate(() => document.getElementById('chat-log').classList.contains('collapsed') && localStorage.getItem('gc-chat-log-collapsed') === 'true'), 'log collapses into a tab, remembered');
	await fresh(A, B);
	await B.evaluate(() => { QuickChat.sendText('ping'); QuickChat.send('hello'); });
	await waitFor(A, () => document.getElementById('chat-log-unread').textContent === '2' && !document.getElementById('chat-log-unread').classList.contains('hide'), 'unread badge counts 2');
	await A.click('#chat-log-head');
	assert(await A.evaluate(() => !document.getElementById('chat-log').classList.contains('collapsed') && document.getElementById('chat-log-unread').classList.contains('hide') && localStorage.getItem('gc-chat-log-collapsed') === 'false'), 'expanding clears the badge');
	await A.click('#chat-log-head');
	await A.keyboard.press('t');
	assert(await A.evaluate(() => !document.getElementById('chat-log').classList.contains('collapsed') && document.activeElement.id === 'chat-input'), 'T expands a collapsed log');
	await A.keyboard.press('Escape');

	// --- quick and text share the cooldown ---
	await fresh(A, B);
	await A.evaluate(() => { QuickChat.send('oops'); QuickChat.send('oops'); QuickChat.sendText('third'); });
	await A.click('#chat-input');
	await A.keyboard.type('fourth');
	await A.keyboard.press('Enter');
	const cd = await A.evaluate(() => ({
		value: document.getElementById('chat-input').value,
		note: getComputedStyle(document.getElementById('chat-log-note')).display !== 'none' ? document.getElementById('chat-log-note').textContent : null,
		badge: document.getElementById('chat-button').dataset.cooldown
	}));
	assert(cd.value === 'fourth', 'a message sent during the cooldown stays in the input');
	assert(cd.note && /^Chat unlocks in \d+s \(prevents spam\)$/.test(cd.note) && +cd.note.match(/\d+/)[0] === +cd.badge, 'log shows the same countdown as the quick chat button: ' + cd.note);
	await waitFor(A, () => !document.getElementById('chat-log').classList.contains('chat-cooldown'), 'cooldown ends', 8000);
	await A.keyboard.press('Enter');
	await waitFor(B, () => document.querySelector('#chat-log-list .chat-entry:last-child .chat-entry-text').textContent === 'fourth', 'held message sent once unlocked');
	await A.keyboard.press('Escape');

	// --- mute drops everything from this opponent ---
	await toggleSetting(A, 'mute');
	assert(await A.evaluate(() => QuickChat.muted && document.getElementById('chat-op-state').classList.contains('muted')
		&& document.getElementById('chat-op-state').getAttribute('data-title') === 'Opponent muted for this match (click to unmute)'), 'muted opponent shown on the indicator');
	await A.evaluate(() => { window.seen = 0; const d = QuickChat.display.bind(QuickChat); QuickChat.display = (w, ...r) => { if (w === 'op') window.seen++; d(w, ...r); }; });
	await fresh(A, B);
	const aLog = (await logEntries(A)).length;
	await B.evaluate(() => { QuickChat.send('oops'); QuickChat.sendText('can you hear me?'); });
	await A.waitForTimeout(400);
	assert(await A.evaluate(() => window.seen) === 0 && (await logEntries(A)).length === aLog, 'muted opponent: no bubbles, nothing logged');
	await A.click('#chat-op-state');
	assert(await A.evaluate(() => !QuickChat.muted) && !(await switchOn(A, 'mute')), 'clicking the indicator unmutes');
	await A.click('#chat-op-state');
	assert(await A.evaluate(() => QuickChat.muted) && await switchOn(A, 'mute'), 'clicking it again mutes, in sync with the switch');

	// --- play the match out with chat on every turn: checksums must agree ---
	for (const page of [A, B]) {
		(async () => {
			for (let i = 0; i < 8; i++) {
				try {
					await page.waitForFunction(() => game.state.val === 100 || (game.currPlayer === player_me && !player_me.passed && !document.getElementsByTagName('main')[0].classList.contains('noclick')), null, { timeout: 60000 });
					if (await page.evaluate(() => game.state.val === 100)) return;
					const other = page === A ? B : A;
					await other.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.sendText('your move'); QuickChat.send('watchThis'); });
					await page.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.sendText('thinking...'); });
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
		assert(await B.evaluate(() => {
			const r = document.getElementById('chat-log').getBoundingClientRect();
			return document.getElementById('chat-log').contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
		}), 'log stays usable above the end screen');
		await B.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.sendText('gg'); });
		await A.waitForTimeout(400);
		assert((await lastEntry(A)).text !== 'gg', 'still muted on the end screen');
		await A.evaluate(() => { QuickChat.sendBucket.reset(); QuickChat.sendText('gg wp'); });
		await waitFor(B, () => document.querySelector('#chat-log-list .chat-entry:last-child .chat-entry-text').textContent === 'gg wp', 'end-screen message arrives');

		// --- a rematch starts with an empty log and no mute ---
		await A.evaluate(() => document.getElementById('end-playagain').click());
		await B.evaluate(() => document.getElementById('end-playagain').click());
		await waitFor(A, () => mp.active && game.state.val === 10 && Carousel.curr, 'rematch started (host)');
		await waitFor(B, () => mp.active && game.state.val === 10, 'rematch started (guest)');
		assert(await A.evaluate(() => !QuickChat.muted && !document.getElementById('chat-op-state').classList.contains('muted') && document.getElementById('chat-log-list').childElementCount === 0), 'rematch resets the mute and clears the log');
		await fresh(A, B);
		await B.evaluate(() => QuickChat.sendText('again!'));
		await waitFor(A, () => document.getElementById('chat-bubble-op').textContent === 'again!', 'opponent heard again in the rematch');
	}

	// --- leaving clears the log ---
	await A.evaluate(() => { game.exitGame(); Popup.curr.selectNo(); }); // popup: Resume=yes, Exit=no
	await waitFor(A, () => !mp.active, 'host left');
	assert(await A.evaluate(() => document.getElementById('chat-log-list').childElementCount === 0 && document.getElementById('chat-log').classList.contains('hide')), 'log cleared and hidden when the session ends');

	assert(errors.A.length === 0, 'no js errors on host' + (errors.A.length ? ': ' + errors.A.join(' | ') : ''));
	assert(errors.B.length === 0, 'no js errors on guest' + (errors.B.length ? ': ' + errors.B.join(' | ') : ''));

	await browser.close();
	console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASS');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
