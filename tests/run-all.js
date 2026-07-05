// Test runner: checks the relay + HTTP servers are already running, then runs
// every suite in order. It does NOT start or stop any servers — you control
// those yourself. If a server is missing, it prints the command to start it
// and exits. Invoked via `npm test`.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTTP_PORT = 8077;
const RELAY_PORT = 8765;

const SUITES = [
	'relay-protocol.js',   // server: room create/join/relay
	'e2e-singleplayer.js', // vs-AI
	'e2e-multiplayer.js',  // full online match, checksums, disconnect
	'e2e-quickmatch.js',   // find-opponent pairing, search screen, cancel
	'e2e-rematch.js',      // re-ready + mid-game exit
];

// Resolves true if something is already accepting connections on the port.
function isPortOpen(port) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => { socket.destroy(); resolve(false); });
	});
}

function run(cmd, cmdArgs) {
	return new Promise((resolve) => {
		const child = spawn(cmd, cmdArgs, { stdio: 'inherit' });
		child.on('exit', (code) => resolve(code === null ? 1 : code));
		child.on('error', () => resolve(1));
	});
}

(async () => {
	const [relayUp, httpUp] = await Promise.all([isPortOpen(RELAY_PORT), isPortOpen(HTTP_PORT)]);
	if (!relayUp || !httpUp) {
		console.error('Required servers are not running. Start them first, then re-run `npm test`:\n');
		if (!relayUp)
			console.error('  relay  (:' + RELAY_PORT + '):  node ' + path.join('..', 'server', 'server.js'));
		if (!httpUp)
			console.error('  http   (:' + HTTP_PORT + '):  python3 -m http.server ' + HTTP_PORT + ' --directory ..');
		console.error('\nTip: run each in its own terminal (from the tests/ directory), or background them with `&`.');
		process.exit(1);
	}

	let failed = false;
	for (const suite of SUITES) {
		console.log('\n=== ' + suite + ' ===');
		const code = await run('node', [path.join(__dirname, suite)]);
		if (code !== 0) failed = true;
	}

	console.log('\n' + (failed ? 'SUITES FAILED' : 'ALL SUITES PASSED'));
	process.exit(failed ? 1 : 0);
})();
