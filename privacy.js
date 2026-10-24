"use strict"

// Privacy notice. The link at the bottom of the main menu opens it in the
// same panel as the patch notes.

const Privacy = {
	init() {
		this.modal = document.getElementById("privacy-modal");
		this.body = this.modal.querySelector(".cl-body");
		const close = () => this.modal.classList.add("hide");
		document.getElementById("privacy-link").addEventListener("click", () => {
			this.modal.classList.remove("hide");
			this.body.scrollTop = 0;
		});
		this.modal.querySelector(".fb-close").addEventListener("click", close);
		this.modal.addEventListener("click", e => { if (e.target === this.modal) close(); });
		document.addEventListener("keydown", e => { if (e.key === "Escape" && !this.modal.classList.contains("hide")) close(); });
	},
};

Privacy.init();
