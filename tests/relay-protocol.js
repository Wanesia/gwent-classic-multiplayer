// Exercises the full lobby protocol against the running relay:
// create, join, bidirectional relay, error paths, leave/peer-left.
const WebSocket = require('ws');
const URL = 'ws://localhost:8765';

function client() {
	const ws = new WebSocket(URL);
	ws.inbox = [];
	ws.waiters = [];
	ws.on('message', raw => {
		const m = JSON.parse(raw);
		const w = ws.waiters.shift();
		if (w) w(m); else ws.inbox.push(m);
	});
	ws.next = () => new Promise(res => {
		if (ws.inbox.length) return res(ws.inbox.shift());
		ws.waiters.push(res);
	});
	ws.sendJSON = o => ws.send(JSON.stringify(o));
	return new Promise(res => ws.on('open', () => res(ws)));
}

function assert(cond, label) {
	console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
	if (!cond) process.exitCode = 1;
}

(async () => {
	// create + join + relay
	const a = await client();
	a.sendJSON({ type: 'create' });
	const created = await a.next();
	assert(created.type === 'created' && /^[2-9A-HJKMNP-Z]{5}$/.test(created.code), 'room created with valid code: ' + created.code);

	const b = await client();
	b.sendJSON({ type: 'join', code: created.code.toLowerCase() }); // case-insensitive
	const joined = await b.next();
	assert(joined.type === 'joined', 'guest joined (case-insensitive)');
	const pj = await a.next();
	assert(pj.type === 'peer-joined', 'host notified of peer');

	a.sendJSON({ type: 'msg', data: { t: 'lobby-ready', deck: { faction: 'realms' } } });
	const m1 = await b.next();
	assert(m1.type === 'msg' && m1.data.t === 'lobby-ready' && m1.data.deck.faction === 'realms', 'host->guest relay verbatim');
	b.sendJSON({ type: 'msg', data: { t: 'pick', i: 4 } });
	const m2 = await a.next();
	assert(m2.type === 'msg' && m2.data.i === 4, 'guest->host relay verbatim');

	// error paths
	const c = await client();
	c.sendJSON({ type: 'join', code: 'XXXXX' });
	assert((await c.next()).code === 'not-found', 'join unknown code -> not-found');
	c.sendJSON({ type: 'join', code: created.code });
	assert((await c.next()).code === 'full', 'join full room -> full');
	c.sendJSON({ type: 'msg', data: {} });
	assert((await c.next()).code === 'no-peer', 'msg without room -> no-peer');
	c.sendJSON('garbage{{{');
	assert((await c.next()).code === 'bad-request', 'malformed json -> bad-request');
	c.sendJSON({ type: 'create' });
	await c.next();
	c.sendJSON({ type: 'create' });
	assert((await c.next()).code === 'already-in-room', 'double create -> already-in-room');

	// leave -> peer-left, room destroyed
	b.sendJSON({ type: 'leave' });
	assert((await a.next()).type === 'peer-left', 'leave notifies peer');
	const d = await client();
	d.sendJSON({ type: 'join', code: created.code });
	assert((await d.next()).code === 'not-found', 'room destroyed after leave');

	// disconnect -> peer-left
	a.sendJSON({ type: 'create' });
	const r2 = await a.next();
	d.sendJSON({ type: 'join', code: r2.code });
	await d.next();
	await a.next(); // peer-joined
	d.close();
	assert((await a.next()).type === 'peer-left', 'socket close notifies peer');

	[a, b, c, d].forEach(w => { try { w.close(); } catch (e) {} });
	console.log('done');
	process.exit();
})();
