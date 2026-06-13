"use strict"

// Deterministic seeded PRNG (mulberry32). In online games both clients run the
// full game simulation in lockstep, so every random outcome that affects game
// state must come from a shared seeded stream instead of Math.random.
class RNG {
	constructor(seed) {
		this.state = seed >>> 0;
	}

	uint32() {
		let t = this.state = (this.state + 0x6D2B79F5) >>> 0;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	}

	float() {
		return this.uint32() / 4294967296;
	}

	// Returns a random integer in the range [0,n)
	int(n) {
		return Math.floor(this.float() * n);
	}

	coin() {
		return this.uint32() % 2 === 0;
	}
}

// FNV-1a hash of the label folded into the base seed, so each named stream
// starts in a different state
function deriveSeed(base, label) {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < label.length; i++) {
		h ^= label.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return (h ^ base) >>> 0;
}

// Shared randomness streams, reset at the start of every game. Deck shuffles
// get one stream per logical player ("host"/"guest" roles; in single-player
// the local player is "host") so that the order in which the two clients
// build and redraw their decks cannot interleave the streams. All other
// mid-game randomness draws from the "game" stream in lockstep order.
var GameRNG = {
	game: null,
	deckHost: null,
	deckGuest: null,

	reset(seed) {
		this.game = new RNG(deriveSeed(seed, "game"));
		this.deckHost = new RNG(deriveSeed(seed, "deck-host"));
		this.deckGuest = new RNG(deriveSeed(seed, "deck-guest"));
	},

	deckFor(role) {
		return role === "guest" ? this.deckGuest : this.deckHost;
	},

	randomSeed() {
		return (Math.random() * 4294967296) >>> 0;
	}
};

GameRNG.reset(GameRNG.randomSeed());
