"use strict"

// Patch notes. Loads CHANGELOG.md (the same text as the GitHub Releases),
// shows the newest version under the main-menu title and renders the whole
// file in a panel when that label is clicked.

const Changelog = {
	init() {
		this.label = document.getElementById("changelog-version");
		this.modal = document.getElementById("changelog-modal");
		this.body = this.modal.querySelector(".cl-body");
		const close = () => this.modal.classList.add("hide");
		this.label.addEventListener("click", () => {
			this.modal.classList.remove("hide");
			this.body.scrollTop = 0;
		});
		this.modal.querySelector(".fb-close").addEventListener("click", close);
		this.modal.addEventListener("click", e => { if (e.target === this.modal) close(); });
		document.addEventListener("keydown", e => { if (e.key === "Escape" && !this.modal.classList.contains("hide")) close(); });

		// No label when the file can't be loaded (e.g. index.html opened from disk)
		fetch("CHANGELOG.md", { cache: "no-cache" })
			.then(res => res.ok ? res.text() : Promise.reject(res.status))
			.then(md => this.show(md))
			.catch(() => {});
	},

	show(md) {
		const version = md.match(/^## (\d+\.\d+\.\d+)/m);
		if (!version)
			return;
		this.body.innerHTML = this.render(md);
		this.label.textContent = "v" + version[1];
		this.label.classList.remove("hide");
	},

	// Covers only what the changelog uses: headings, paragraphs, "- " lists,
	// **bold**, *italic*, [links](...) and bare https:// links.
	render(md) {
		const html = [];
		let list = false, para = [];
		const flush = () => {
			if (para.length)
				html.push("<p>" + this.inline(para.join(" ")) + "</p>");
			para = [];
			if (list)
				html.push("</ul>");
			list = false;
		};
		for (const line of md.split(/\r?\n/)) {
			const heading = line.match(/^(#{1,3}) (.*)/);
			if (heading) {
				flush();
				// "# Changelog" is replaced by the panel's own title
				if (heading[1] === "##")
					html.push('<h3 class="cl-version">' + this.inline(heading[2]) + "</h3>");
				else if (heading[1] === "###")
					html.push("<h4>" + this.inline(heading[2]) + "</h4>");
			} else if (line.startsWith("- ")) {
				if (para.length || !list)
					flush();
				if (!list)
					html.push("<ul>");
				list = true;
				html.push("<li>" + this.inline(line.slice(2)) + "</li>");
			} else if (line.trim() === "") {
				flush();
			} else {
				if (list)
					flush();
				para.push(line.trim());
			}
		}
		flush();
		return html.join("");
	},

	inline(text) {
		const link = (label, url) => '<a href="' + url + '" target="_blank" rel="noopener">' + label + "</a>";
		return text
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => link(label, url))
			.replace(/(^|[\s(])(https?:\/\/[^\s<*]+)/g, (m, before, url) => before + link(url, url))
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	},
};

Changelog.init();
