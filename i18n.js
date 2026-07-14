"use strict"

var I18N = (function () {
	const DEFAULT = "en";
	const SUPPORTED = ["en", "pt-BR", "pl", "ru", "de", "fr", "es", "es-MX", "it", "cs", "hu", "tr", "ja", "ko", "zh-CN", "zh-TW", "ar"];
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
		if (nav.startsWith("fr"))
			return "fr";
		if (nav.startsWith("es-mx") || nav.startsWith("es-419") || nav.startsWith("es-us"))
			return "es-MX";
		if (nav.startsWith("es"))
			return "es";
		if (nav.startsWith("it"))
			return "it";
		if (nav.startsWith("cs") || nav.startsWith("cz"))
			return "cs";
		if (nav.startsWith("hu"))
			return "hu";
		if (nav.startsWith("tr"))
			return "tr";
		if (nav.startsWith("ja"))
			return "ja";
		if (nav.startsWith("ko"))
			return "ko";
		if (nav.startsWith("zh-tw") || nav.startsWith("zh-hant") || nav.startsWith("zh-hk") || nav.startsWith("zh-mo"))
			return "zh-TW";
		if (nav.startsWith("zh"))
			return "zh-CN";
		if (nav.startsWith("ar"))
			return "ar";
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

	// Wires up the custom language dropdown
	function wireSelector() {
		const root = document.getElementById("lang-select");
		if (!root || root._i18nWired)
			return;
		const trigger = root.querySelector(".lang-trigger");
		const menu = root.querySelector(".lang-menu");
		const label = root.querySelector(".lang-current");
		const options = [...menu.querySelectorAll('[role="option"]')];
		if (!trigger || !menu || !label || !options.length)
			return;

		const selected = options.find(o => o.dataset.value === current) || options[0];
		label.textContent = selected.textContent;
		selected.setAttribute("aria-selected", "true");

		const close = () => {
			root.classList.remove("open");
			trigger.setAttribute("aria-expanded", "false");
		};
		const open = () => {
			root.classList.add("open");
			trigger.setAttribute("aria-expanded", "true");
			selected.focus();
		};
		const toggle = () => root.classList.contains("open") ? close() : open();

		trigger.addEventListener("click", e => { e.stopPropagation(); toggle(); });
		options.forEach(opt =>
			opt.addEventListener("click", () => setLang(opt.dataset.value)));

		// Arrow-key navigation while the list is open.
		menu.addEventListener("keydown", e => {
			const i = options.indexOf(document.activeElement);
			if (e.key === "ArrowDown") {
				e.preventDefault();
				options[Math.min(i + 1, options.length - 1)].focus();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				options[Math.max(i - 1, 0)].focus();
			} else if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				if (i >= 0) setLang(options[i].dataset.value);
			}
		});

		// Close on outside click or Escape.
		document.addEventListener("click", e => {
			if (!root.contains(e.target)) close();
		});
		document.addEventListener("keydown", e => {
			if (e.key === "Escape" && root.classList.contains("open")) {
				close();
				trigger.focus();
			}
		});

		root._i18nWired = true;
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
