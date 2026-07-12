"use strict"

var I18N = (function () {
	const DEFAULT = "en";
	const SUPPORTED = ["en", "pt-BR", "pl", "ru", "de"];
	const dicts = {};

	function resolve() {
		let saved = null;
		try { saved = localStorage.getItem("lang"); } catch (e) { /* private mode */ }
		if (saved && SUPPORTED.includes(saved))
			return saved;
		const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
		if (nav.startsWith("pt"))
			return "pt-BR";
		if (nav.startsWith("pl"))
			return "pl";
		if (nav.startsWith("ru"))
			return "ru";
		if (nav.startsWith("de"))
			return "de";
		return DEFAULT;
	}

	let current = resolve();

	// Shallow-merges top-level keys so a language can be split across files
	// (e.g. UI strings in lang/pl.js, card names in lang/cards.pl.js).
	function register(code, dict) {
		const existing = dicts[code] || (dicts[code] = {});
		for (const k in dict)
			existing[k] = dict[k];
	}

	// Resolves a dotted key path ("a.b.c") against a dictionary object.
	function lookup(dict, key) {
		if (!dict)
			return undefined;
		return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
	}

	// Translates a UI key. Falls back to English, then to the key itself so a
	// missing string is visible rather than rendering "undefined". Supports
	// {name}-style interpolation via the optional vars object.
	function t(key, vars) {
		let val = lookup(dicts[current], key);
		if (val === undefined)
			val = lookup(dicts[DEFAULT], key);
		if (val === undefined)
			return key;
		if (vars)
			val = val.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
		return val;
	}

	// Card names are keyed by their English name. Returns the English name
	// unchanged when no translation exists.
	function card(name) {
		const map = lookup(dicts[current], "cards");
		return (map && map[name]) || name;
	}

	// Ability / faction field lookup (field = "name" or "description"), keyed
	// by the English ability/faction key, falling back to the English string.
	function ability(key, field, fallback) {
		const map = lookup(dicts[current], "abilities");
		const entry = map && map[key];
		return (entry && entry[field]) || fallback;
	}

	function faction(key, field, fallback) {
		const map = lookup(dicts[current], "factions");
		const entry = map && map[key];
		return (entry && entry[field]) || fallback;
	}

	function setLang(code) {
		if (!SUPPORTED.includes(code) || code === current)
			return;
		try { localStorage.setItem("lang", code); } catch (e) { /* private mode */ }
		// A full reload is the simplest correct way to re-render every card DOM
		// node, tooltip and notification in the new language.
		location.reload();
	}

	// Fills in all statically-tagged markup under root (default: whole document).
	//   data-i18n            -> element.textContent
	//   data-i18n-datatitle  -> element's data-title attribute (custom tooltips)
	//   data-i18n-title      -> element's title attribute
	function apply(root) {
		root = root || document;
		root.querySelectorAll("[data-i18n]").forEach(el => {
			el.textContent = t(el.getAttribute("data-i18n"));
		});
		root.querySelectorAll("[data-i18n-datatitle]").forEach(el => {
			el.setAttribute("data-title", t(el.getAttribute("data-i18n-datatitle")));
		});
		root.querySelectorAll("[data-i18n-title]").forEach(el => {
			el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
		});
		document.documentElement.lang = current;
		wireSelector();
	}

	// Keeps the language <select> (if present) in sync and wired to setLang.
	function wireSelector() {
		const sel = document.getElementById("lang-select");
		if (!sel || sel._i18nWired)
			return;
		sel.value = current;
		sel.addEventListener("change", () => setLang(sel.value));
		sel._i18nWired = true;
	}

	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", () => apply());
	else
		apply();

	return {
		register, t, card, ability, faction, setLang, apply,
		SUPPORTED, DEFAULT,
		get lang() { return current; }
	};
})();
