// Music panel: nothing loads from YouTube until play, volume is saved and sent to the player, tracks/prev/next seek, Escape closes.
// YouTube itself is replaced by a stub that records what the game asks of it.
const { chromium } = require('playwright-core');
const URL = 'http://localhost:8077/index.html?server=ws://localhost:8765';

let failed = false;
const errors = [];
function assert(cond, label) {
	console.log((cond ? 'PASS ' : 'FAIL ') + label);
	if (!cond) failed = true;
}
async function waitFor(page, fn, label, timeout = 10000) {
	try { await page.waitForFunction(fn, null, { timeout }); return true; }
	catch (e) { console.log('FAIL (timeout) ' + label); failed = true; return false; }
}

// A YT.Player that plays nothing: it keeps a clock the test can move and logs calls
const FAKE_YT = `
window.YT = {
	PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3 },
	Player: class {
		constructor(id, opts) {
			window.__yt = this;
			this.calls = []; this.t = 0; this.state = -1; this.vol = 100; this.vars = opts.playerVars;
			setTimeout(() => opts.events.onReady(), 10);
		}
		playVideo() { this.calls.push('play'); this.state = 1; }
		pauseVideo() { this.calls.push('pause'); this.state = 2; }
		seekTo(t) { this.calls.push('seek:' + t); this.t = t; }
		setVolume(v) { this.vol = v; }
		unMute() {}
		getCurrentTime() { return this.t; }
		getPlayerState() { return this.state; }
	}
};
onYouTubeIframeAPIReady();
`;

(async () => {
	const browser = await chromium.launch();
	const context = await browser.newContext();
	// Playwright tries the newest route first: block the rest of YouTube, then serve the stub
	let ytRequests = 0;
	await context.route(/youtube|ytimg/, route => route.abort());
	await context.route('https://www.youtube.com/iframe_api', route => {
		ytRequests++;
		route.fulfill({ body: FAKE_YT, contentType: 'application/javascript' });
	});
	const page = await context.newPage();
	page.on('pageerror', e => errors.push(String(e.stack || e)));
	page.on('console', m => {
		if (m.type() === 'error' && !/ERR_|favicon|youtube|Audio|media|Permissions policy|compute-pressure/i.test(m.text()))
			errors.push(m.text());
	});

	await page.goto(URL);
	await page.waitForFunction(() => typeof Music !== 'undefined' && typeof lobby !== 'undefined');

	// Off by default, nothing requested from YouTube
	assert(ytRequests === 0, 'YouTube not loaded while music is off');
	assert(await page.isHidden('#music-panel'), 'panel closed at start');
	assert(await page.$eval('#toggle-music', e => e.classList.contains('fade')), 'note faded while music is off');

	// Open the panel: everything shown, YouTube still not loaded
	await page.click('#toggle-music > img');
	assert(await page.isVisible('#music-panel'), 'clicking the note opens the panel');
	assert(await page.isVisible('#music-panel .music-source'), 'panel says the music comes from YouTube');
	assert(await page.$eval('.music-source a', a => a.href === 'https://www.youtube.com/watch?v=' + Music.VIDEO && a.target === '_blank'), 'link opens the video on YouTube in a new tab');
	assert((await page.$$eval('.music-tracks li', l => l.length)) === 5, 'five tracks listed');
	assert((await page.textContent('.music-now-time')).trim() === '0:00 / 1:38', 'first track shown with its length');
	assert((await page.textContent('.music-volume-value')).trim() === '50%', 'volume defaults to 50%');

	// Everything clickable shows the pointer, including the text and icons inside
	// (the game sets its own cursor on every element)
	const notPointer = await page.$$eval(
		'#music-panel :is(.music-tracks button, .music-btn, .music-source a, .music-volume), #music-panel :is(.music-tracks button, .music-btn, .music-source a) *',
		els => els.filter(e => getComputedStyle(e).cursor !== 'pointer').map(e => e.tagName));
	assert(notPointer.length === 0, 'pointer cursor on tracks, buttons, slider and the YouTube link' + (notPointer.length ? ': ' + notPointer.join(', ') : ''));
	const iconsNotPointer = await page.$$eval('.settings-button, .settings-button > :is(img, span)',
		els => els.filter(e => getComputedStyle(e).cursor !== 'pointer').map(e => e.parentElement.id || e.id));
	assert(iconsNotPointer.length === 0, 'pointer cursor on the music, sound and other settings icons' + (iconsNotPointer.length ? ': ' + iconsNotPointer.join(', ') : ''));

	// Volume while off: saved, still nothing loaded
	await page.$eval('.music-volume', e => { e.value = 25; e.dispatchEvent(new Event('input')); });
	assert(await page.evaluate(() => localStorage.getItem('gc-music-volume')) === '25', 'volume saved');
	assert(ytRequests === 0, 'changing the volume does not load YouTube');

	// Play: loads the stub and plays at the saved volume
	await page.click('.music-play');
	await waitFor(page, () => window.__yt && window.__yt.state === 1, 'player starts after pressing play');
	assert(ytRequests === 1, 'YouTube loaded once on play');
	assert(await page.evaluate(() => __yt.vol) === 25, 'player gets the saved volume');
	assert(await page.$eval('.music-play', e => e.classList.contains('playing')), 'play button shows pause');
	assert(!(await page.$eval('#toggle-music', e => e.classList.contains('fade'))), 'note lit while playing');
	assert(await page.isVisible('#music-panel .music-source'), 'YouTube source still shown while playing');

	// Slider moves the live player and snaps to steps of 5
	await page.$eval('.music-volume', e => { e.value = 75; e.dispatchEvent(new Event('input')); });
	assert(await page.evaluate(() => __yt.vol) === 75, 'slider sets the player volume live');
	await page.evaluate(() => Music.setVolume(42));
	assert(await page.evaluate(() => __yt.vol) === 40, 'volume rounds to steps of 5');

	// Mute and back
	await page.click('.music-mute');
	assert(await page.evaluate(() => __yt.vol) === 0, 'mute sets volume to 0');
	assert(await page.$eval('#toggle-music', e => e.classList.contains('fade')), 'note faded while muted');
	await page.click('.music-mute');
	assert(await page.evaluate(() => __yt.vol) === 40, 'unmute restores the previous volume');

	// Tracks: click seeks, current track highlighted
	await page.click('.music-tracks li:nth-child(3) button');
	assert(await page.evaluate(() => __yt.t) === 256, 'third track seeks to 4:16');
	await waitFor(page, () => document.querySelector('.music-tracks li:nth-child(3)').classList.contains('current'), 'third track highlighted');
	assert((await page.textContent('.music-now-title')).trim() === 'Another Round for Everyone', 'now playing shows the third track');

	// Next / previous; the second loop of the video maps to the same tracks
	await page.click('.music-next');
	assert(await page.evaluate(() => __yt.t) === 372, 'next goes to the fourth track');
	await page.evaluate(() => { __yt.t = 1095 + 30; });
	await waitFor(page, () => document.querySelector('.music-tracks li:nth-child(5)').classList.contains('current'), 'second loop recognised as track 5');
	assert((await page.textContent('.music-now-title')).trim() === 'Unreleased Gwent', 'fifth track keeps its English name');
	await page.click('.music-prev');
	assert(await page.evaluate(() => __yt.t) === 468, 'previous, 30s in, restarts the current track');
	await page.click('.music-prev');
	assert(await page.evaluate(() => __yt.t) === 372, 'previous at the start goes back a track');
	await page.evaluate(() => { __yt.t = 468; });
	await page.click('.music-next');
	assert(await page.evaluate(() => __yt.t) === 0, 'next on the last track wraps to the first');

	// Seek bar: halfway through The Nightingale (0..98)
	await page.waitForTimeout(600);
	const box = await page.$eval('.music-progress', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
	await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
	const t = await page.evaluate(() => __yt.t);
	assert(t > 45 && t < 53, 'clicking the middle of the bar seeks to the middle of the track (' + t + ')');

	if (process.env.SHOT_DIR)
		await page.screenshot({ path: process.env.SHOT_DIR + '/music-lobby.png' });

	// Pause, close with Escape and by clicking outside
	await page.click('.music-play');
	assert(await page.evaluate(() => __yt.state) === 2, 'pause stops the player');
	assert(await page.evaluate(() => localStorage.getItem('gc-music')) === 'false', 'music off saved');
	await page.keyboard.press('Escape');
	assert(await page.isHidden('#music-panel'), 'Escape closes the panel');
	await page.click('#toggle-music > img');
	await page.mouse.click(5, 5);
	assert(await page.isHidden('#music-panel'), 'clicking outside closes the panel');

	// Picking a track while off turns music on
	await page.click('#toggle-music > img');
	await page.click('.music-tracks li:nth-child(2) button');
	assert(await page.evaluate(() => __yt.state === 1 && __yt.t === 98), 'picking a track while paused plays it');
	assert(await page.evaluate(() => localStorage.getItem('gc-music')) === 'true', 'music on saved');

	// After a reload: on and at the saved volume, loaded without a click
	await page.reload();
	await waitFor(page, () => window.__yt && window.__yt.vol === 40, 'reload keeps music on at the saved volume');
	assert(await page.$eval('.music-volume', e => e.value) === '40', 'slider restored after reload');

	// In a match the panel opens from the in-game note too
	await page.click('#split-computer');
	await page.click('#start-game');
	await waitFor(page, () => !document.getElementById('toggle-music').classList.contains('deck-menu'), 'music button moves into the match');
	await page.evaluate(() => document.getElementById('toggle-music').click());
	assert(await page.isVisible('#music-panel'), 'panel opens in a match');
	await page.waitForTimeout(400); // open animation
	if (process.env.SHOT_DIR)
		await page.screenshot({ path: process.env.SHOT_DIR + '/music-match.png' });

	assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
	await browser.close();
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
