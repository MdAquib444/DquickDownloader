const menuButton = document.querySelector("#menu-button");
const menuContent = document.querySelector(".menu-content");
const menuBackdrop = document.querySelector("#menu-backdrop");
const menuIcon = menuButton.querySelector(".material-symbols-outlined");
const themeButton = document.querySelector("#theme-button");
const themeLabel = document.querySelector("#theme-label");
const themeIcon = document.querySelector("#theme-icon");
const changePathButton = document.querySelector("#change-path-button");
const pathModal = document.querySelector("#path-modal");
const pathModalClose = document.querySelector("#path-modal-close");
const pathSaveButton = document.querySelector("#path-save-button");
const pathInput = document.querySelector("#download-path");
const cookiesModal = document.querySelector("#cookies-modal");
const cookiesModalClose = document.querySelector("#cookies-modal-close");
const cookiesInput = document.querySelector("#cookies-input");
const cookiesRetryButton = document.querySelector("#cookies-retry-button");
const fileInfoModal = document.querySelector("#file-info-modal");
const fileInfoClose = document.querySelector("#file-info-close");
const fileInfoName = document.querySelector("#file-info-name");
const fileInfoDuration = document.querySelector("#file-info-duration");
const fileInfoSize = document.querySelector("#file-info-size");
const fileInfoPath = document.querySelector("#file-info-path");
const fileInfoDate = document.querySelector("#file-info-date");
const downloadsButton = document.querySelector("#downloads-button");
const downloadsScreen = document.querySelector("#downloads-screen");
const downloadsBack = document.querySelector("#downloads-back");
const downloadsList = document.querySelector(".downloads-list");
const downloadsEmptyState = document.querySelector("#downloads-empty-state");
const activeDownloadsGroup = document.querySelector("#active-downloads-group");
const completedDownloadsGroup = document.querySelector("#completed-downloads-group");
const activeDownloadCard = document.querySelector("#active-download-card");
const activeDownloadTitle = document.querySelector("#active-download-title");
const downloadProgress = document.querySelector("#download-progress");
const downloadProgressText = document.querySelector("#download-progress-text");
const downloadStatus = document.querySelector("#download-status");
const downloadPauseButton = document.querySelector("#download-pause-button");
const downloadPauseIcon = document.querySelector("#download-pause-icon");
const downloadCancelButton = document.querySelector("#download-cancel-button");
const downloadInput = document.querySelector("#url-input");
const downloadButton = document.querySelector("#download-button");
const audioOnlyCheckbox = document.querySelector("#audio-only-checkbox");
const logsContainer = document.querySelector(".logs-container");
const emptyLogs = document.querySelector(".empty-logs");
const logList = document.querySelector("#log-list");
const copyLogsButton = document.querySelector("#copy-logs-button");
const clearLogsButton = document.querySelector("#clear-logs-button");
const downloadedFiles = document.querySelector("#downloaded-files");
const downloadToast = document.querySelector("#download-toast");
let currentJob = null;
let currentFiles = [];
let fileInfoFileId = null;
let pendingDownloadRequest = null;
let eventSource;
let connectionErrorShown = false;
let toastTimer;

async function api(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...options.headers
		}
	});
	const result = response.status === 204 ? {} : await response.json();
	if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
	return result;
}

function appendLog(message, time = new Date().toISOString()) {
	emptyLogs.hidden = true;
	logList.hidden = false;
	logsContainer.classList.add("has-logs");
	const line = document.createElement("p");
	line.className = "log-entry";
	const date = new Date(time);
	const timeText = Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
	line.textContent = timeText ? `[${timeText}] ${message}` : message;
	logList.append(line);
	while (logList.children.length > 300) logList.firstElementChild.remove();
	logList.scrollTop = logList.scrollHeight;
}

copyLogsButton.addEventListener("click", async () => {
	const text = [...logList.querySelectorAll(".log-entry")].map(entry => entry.textContent).join("\n");
	if (!text) {
		showToast("No logs to copy");
		return;
	}
	try {
		await navigator.clipboard.writeText(text);
		showToast("Logs copied");
	} catch (error) {
		showToast(`Could not copy logs: ${error.message}`);
	}
});

clearLogsButton.addEventListener("click", () => {
	logList.replaceChildren();
	logList.hidden = true;
	emptyLogs.hidden = false;
	logsContainer.classList.remove("has-logs");
});

function showToast(message) {
	downloadToast.textContent = message;
	downloadToast.classList.add("is-visible");
	window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => downloadToast.classList.remove("is-visible"), 2600);
}

function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) return "—";
	if (bytes < 1000) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let size = bytes / 1000;
	let index = 0;
	while (size >= 1000 && index < units.length - 1) {
		size /= 1000;
		index += 1;
	}
	return `${size.toFixed(1)} ${units[index]}`;
}

function formatDuration(duration) {
	if (duration === null || duration === undefined) return "—";
	const value = String(duration).trim();
	if (!value || value === "—") return "—";

	let totalSeconds;
	if (/^\d+(?:\.\d+)?$/.test(value)) {
		totalSeconds = Math.floor(Number(value));
	} else if (/^\d+(?::\d{1,2}){1,2}$/.test(value)) {
		const parts = value.split(":").map(Number);
		if (parts.length === 2) {
			if (parts[1] >= 60) return value;
			totalSeconds = parts[0] * 60 + parts[1];
		} else {
			if (parts[1] >= 60 || parts[2] >= 60) return value;
			totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
		}
	} else {
		return value;
	}

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const paddedMinutes = String(minutes).padStart(2, "0");
	const paddedSeconds = String(seconds).padStart(2, "0");
	return hours
		? `${hours}:${paddedMinutes}:${paddedSeconds}`
		: `${paddedMinutes}:${paddedSeconds}`;
}

function renderActiveJob(job) {
	currentJob = job;
	const active = job && ["running", "pausing", "paused", "cancelling"].includes(job.status);
	activeDownloadCard.hidden = !active;
	activeDownloadsGroup.hidden = !active;
	updateDownloadsEmptyState();
	if (!active) return;

	activeDownloadTitle.textContent = job.title || "Downloading media";
	const progress = Number.isFinite(job.progress) ? Math.min(100, Math.max(0, job.progress)) : 0;
	downloadProgress.value = progress;
	downloadProgressText.textContent = `${Math.floor(progress)}%`;
	const details = [];
	if (job.downloadedBytes !== null && job.downloadedBytes !== undefined) {
		details.push(formatBytes(job.downloadedBytes));
		if (job.totalBytes) details[0] += ` / ${formatBytes(job.totalBytes)}`;
	}
	if (job.speedBytesPerSecond) details.push(`${formatBytes(job.speedBytesPerSecond)}/s`);
	if (job.eta) details.push(`ETA ${job.eta}`);
	if (job.status === "paused") details.push("Paused");
	if (job.status === "pausing") details.push("Pausing…");
	if (job.status === "cancelling") details.push("Cancelling…");
	downloadStatus.textContent = details.join(" · ") || (job.status === "paused" ? "Paused" : "Starting…");

	const paused = job.status === "paused";
	downloadPauseIcon.textContent = paused ? "play_arrow" : "pause";
	downloadPauseButton.setAttribute("aria-label", paused ? "Resume download" : "Pause download");
	downloadPauseButton.disabled = !["running", "paused"].includes(job.status);
	downloadCancelButton.disabled = !["running", "paused", "pausing"].includes(job.status);
}

function fileType(file) {
	if ([".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"].includes(file.extension)) return ["video-icon", "movie", "Video"];
	if ([".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus", ".flac"].includes(file.extension)) return ["document-icon", "audio_file", "Audio"];
	if ([".zip", ".7z", ".rar", ".tar", ".gz"].includes(file.extension)) return ["archive-icon", "folder_zip", "Archive"];
	return ["document-icon", "description", file.extension ? file.extension.slice(1).toUpperCase() : "File"];
}

function isPlayableFile(file) {
	return [".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus", ".flac"]
		.includes(file.extension);
}

function createFileCard(file) {
	const [iconClass, iconName, typeName] = fileType(file);
	const card = document.createElement("article");
	card.className = "download-card completed-download";
	card.dataset.id = file.id;

	const icon = document.createElement("div");
	icon.className = `file-icon ${iconClass}`;
	const iconSymbol = document.createElement("span");
	iconSymbol.className = "material-symbols-outlined";
	iconSymbol.setAttribute("aria-hidden", "true");
	iconSymbol.textContent = iconName;
	icon.append(iconSymbol);

	const details = document.createElement("div");
	details.className = "file-details";
	const title = document.createElement("h3");
	title.textContent = file.title;
	const subtitle = document.createElement("p");
	subtitle.textContent = `${typeName} · ${formatBytes(file.size)}`;
	details.append(title, subtitle);

	const actions = document.createElement("div");
	actions.className = "file-actions";
	const moreButton = document.createElement("button");
	moreButton.className = "file-action-button file-menu-button";
	moreButton.type = "button";
	moreButton.setAttribute("aria-label", `More actions for ${file.title}`);
	moreButton.setAttribute("aria-expanded", "false");
	const moreIcon = document.createElement("span");
	moreIcon.className = "material-symbols-outlined";
	moreIcon.setAttribute("aria-hidden", "true");
	moreIcon.textContent = "more_vert";
	moreButton.append(moreIcon);

	if (isPlayableFile(file)) {
		const playButton = document.createElement("a");
		playButton.className = "file-action-button";
		playButton.href = new URL(`/api/files/${encodeURIComponent(file.id)}/play`, window.location.origin).href;
		playButton.target = "_blank";
		playButton.rel = "noopener";
		playButton.setAttribute("aria-label", `Play ${file.title}`);
		playButton.title = `Play ${file.title}`;
		const playIcon = document.createElement("span");
		playIcon.className = "material-symbols-outlined";
		playIcon.setAttribute("aria-hidden", "true");
		playIcon.textContent = "play_arrow";
		playButton.append(playIcon);
		actions.append(playButton);
	}

	const actionMenu = document.createElement("div");
	actionMenu.className = "file-action-menu";
	actionMenu.hidden = true;
	for (const [action, label, iconText] of [
		["share", "Share", "share"],
		["delete", "Delete", "delete"],
		["info", "Info", "info"]
	]) {
		const item = document.createElement("button");
		item.type = "button";
		item.dataset.action = action;
		const symbol = document.createElement("span");
		symbol.className = "material-symbols-outlined";
		symbol.setAttribute("aria-hidden", "true");
		symbol.textContent = iconText;
		item.append(symbol, document.createTextNode(label));
		actionMenu.append(item);
	}
	actions.append(moreButton, actionMenu);
	card.append(icon, details, actions);
	return card;
}

function renderFiles(files) {
	currentFiles = files;
	downloadedFiles.replaceChildren(...files.map(createFileCard));
	completedDownloadsGroup.hidden = files.length === 0;
	updateDownloadsEmptyState();
}

function updateDownloadsEmptyState() {
	const hasDownloads = Boolean(currentJob && ["running", "pausing", "paused", "cancelling"].includes(currentJob.status)) ||
		currentFiles.length > 0;
	downloadsEmptyState.hidden = hasDownloads;
	downloadsList.hidden = !hasDownloads;
}

async function refreshDownloads() {
	const state = await api("/api/downloads");
	renderActiveJob(state.active);
	renderFiles(state.files);
}

function connectEvents() {
	eventSource = new EventSource("/api/events");
	eventSource.onopen = () => {
		refreshDownloads().catch(error => {
			appendLog(`Could not refresh downloads: ${error.message}`);
		});
	};
	eventSource.onmessage = event => {
		const item = JSON.parse(event.data);
		if (item.type === "log") appendLog(item.message, item.time);
		if (item.type === "job") {
			renderActiveJob(item);
			if (item.status === "error" && item.requiresSignIn && pendingDownloadRequest) {
				cookiesModal.showModal();
				cookiesInput.focus();
			}
			if (item.status === "completed") {
				pendingDownloadRequest = null;
				refreshDownloads().catch(error => {
					appendLog(`Could not refresh downloads: ${error.message}`);
				});
			}
		}
		if (item.type === "files") renderFiles(item.files);
		connectionErrorShown = false;
	};
	eventSource.onerror = () => {
		if (!connectionErrorShown) {
			appendLog("Connection to the local download server was interrupted.");
			connectionErrorShown = true;
		}
	};
}

function setMenuOpen(isOpen) {
	menuContent.classList.toggle("is-open", isOpen);
	menuBackdrop.classList.toggle("is-open", isOpen);
	menuIcon.textContent = isOpen ? "close" : "menu";
	menuButton.setAttribute("aria-expanded", String(isOpen));
	menuButton.setAttribute("aria-label", isOpen ? "Hide menu" : "Show menu");
}

menuButton.addEventListener("click", () => {
	setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true");
});

menuBackdrop.addEventListener("click", () => setMenuOpen(false));

downloadsButton.addEventListener("click", async () => {
	setMenuOpen(false);
	downloadsScreen.hidden = false;
	try {
		await refreshDownloads();
	} catch (error) {
		appendLog(`Could not load downloads: ${error.message}`);
	}
});

downloadsBack.addEventListener("click", () => {
	downloadsScreen.hidden = true;
});

downloadButton.addEventListener("click", async () => {
	const url = downloadInput.value.trim();
	if (!url) {
		appendLog("Enter a video URL to start a download.");
		downloadInput.focus();
		return;
	}

	downloadButton.disabled = true;
	try {
		pendingDownloadRequest = { url, audioOnly: audioOnlyCheckbox.checked };
		await api("/api/downloads", {
			method: "POST",
			body: JSON.stringify(pendingDownloadRequest)
		});
		downloadInput.value = "";
		showToast("Download started");
		refreshDownloads().catch(error => {
			appendLog(`Could not refresh downloads: ${error.message}`);
		});
	} catch (error) {
		pendingDownloadRequest = null;
		appendLog(`Could not start download: ${error.message}`);
	} finally {
		downloadButton.disabled = false;
	}
});

cookiesModalClose.addEventListener("click", () => cookiesModal.close());
cookiesModal.addEventListener("close", () => {
	cookiesInput.value = "";
});

cookiesRetryButton.addEventListener("click", async () => {
	if (!pendingDownloadRequest) {
		cookiesModal.close();
		return;
	}
	cookiesRetryButton.disabled = true;
	try {
		await api("/api/downloads", {
			method: "POST",
			body: JSON.stringify({
				...pendingDownloadRequest,
				cookies: cookiesInput.value
			})
		});
		cookiesInput.value = "";
		cookiesModal.close();
		showToast("Retry started");
		refreshDownloads().catch(error => {
			appendLog(`Could not refresh downloads: ${error.message}`);
		});
	} catch (error) {
		appendLog(`Could not retry download: ${error.message}`);
	} finally {
		cookiesRetryButton.disabled = false;
	}
});

downloadInput.addEventListener("keydown", event => {
	if (event.key === "Enter") downloadButton.click();
});

downloadPauseButton.addEventListener("click", async () => {
	if (!currentJob) return;
	const action = currentJob.status === "paused" ? "resume" : "pause";
	downloadPauseButton.disabled = true;
	try {
		const result = await api(`/api/downloads/${currentJob.id}/${action}`, { method: "POST" });
		renderActiveJob(result.job);
	} catch (error) {
		appendLog(`Could not ${action} download: ${error.message}`);
		downloadPauseButton.disabled = false;
	}
});

downloadCancelButton.addEventListener("click", async () => {
	if (!currentJob) return;
	downloadCancelButton.disabled = true;
	try {
		await api(`/api/downloads/${currentJob.id}/cancel`, { method: "POST" });
	} catch (error) {
		appendLog(`Could not cancel download: ${error.message}`);
		downloadCancelButton.disabled = false;
	}
});

downloadsList.addEventListener("click", async event => {
	const menuButton = event.target.closest(".file-menu-button");
	if (menuButton) {
		const menu = menuButton.nextElementSibling;
		const willOpen = menu.hidden;
		document.querySelectorAll(".file-action-menu").forEach(item => {
			item.hidden = true;
			item.previousElementSibling.setAttribute("aria-expanded", "false");
		});
		menu.hidden = !willOpen;
		menuButton.setAttribute("aria-expanded", String(willOpen));
		return;
	}

	const actionButton = event.target.closest(".file-action-menu button");
	if (!actionButton) return;
	const card = actionButton.closest(".completed-download");
	const file = currentFiles.find(item => item.id === card.dataset.id);
	if (!file) return;
	const action = actionButton.dataset.action;
	actionButton.closest(".file-action-menu").hidden = true;
	actionButton.closest(".file-actions").querySelector(".file-menu-button").setAttribute("aria-expanded", "false");

	if (action === "delete") {
		try {
			const result = await api(`/api/downloads/${file.id}`, { method: "DELETE" });
			renderFiles(result.files);
			appendLog(`Deleted ${file.title}.`);
		} catch (error) {
			appendLog(`Could not delete ${file.title}: ${error.message}`);
		}
	} else if (action === "share") {
		try {
			if (!navigator.share) throw new Error("Sharing is not supported in this browser.");
			await navigator.share({ title: file.title, url: new URL(file.url, location.href).href });
		} catch (error) {
			if (error.name !== "AbortError") appendLog(`Could not share file: ${error.message}`);
		}
	} else if (action === "info") {
		fileInfoFileId = file.id;
		fileInfoName.textContent = file.title;
		fileInfoDuration.textContent = formatDuration(file.duration);
		fileInfoSize.textContent = formatBytes(file.size);
		fileInfoPath.textContent = file.path;
		fileInfoDate.textContent = new Date(file.date).toLocaleString();
		fileInfoModal.showModal();
		if (fileInfoDuration.textContent === "—") {
			fileInfoDuration.textContent = "Checking…";
			try {
				const result = await api(`/api/files/${file.id}/info`);
				if (fileInfoFileId === file.id) fileInfoDuration.textContent = formatDuration(result.duration);
			} catch (error) {
				if (fileInfoFileId === file.id) fileInfoDuration.textContent = "Unavailable";
				appendLog(`Could not read duration for ${file.title}: ${error.message}`);
			}
		}
	}
});

fileInfoClose.addEventListener("click", () => {
	fileInfoFileId = null;
	fileInfoModal.close();
});
fileInfoModal.addEventListener("close", () => {
	fileInfoFileId = null;
});

document.addEventListener("click", event => {
	if (!event.target.closest(".file-actions")) {
		document.querySelectorAll(".file-action-menu").forEach(item => {
			item.hidden = true;
			item.previousElementSibling.setAttribute("aria-expanded", "false");
		});
	}
});

changePathButton.addEventListener("click", async () => {
	try {
		const settings = await api("/api/settings");
		pathInput.value = settings.downloadPath;
		pathModal.showModal();
	} catch (error) {
		appendLog(`Could not load download folder: ${error.message}`);
	}
});

pathModalClose.addEventListener("click", () => pathModal.close());

pathSaveButton.addEventListener("click", async () => {
	pathSaveButton.disabled = true;
	try {
		const result = await api("/api/settings", {
			method: "PUT",
			body: JSON.stringify({ path: pathInput.value })
		});
		pathInput.value = result.downloadPath;
		pathModal.close();
		appendLog(`Download folder set to ${result.downloadPath}.`);
	} catch (error) {
		appendLog(`Could not change download folder: ${error.message}`);
	} finally {
		pathSaveButton.disabled = false;
	}
});

themeButton.addEventListener("click", () => {
	const isLight = document.documentElement.dataset.theme !== "light";
	document.documentElement.dataset.theme = isLight ? "light" : "dark";
	themeLabel.textContent = `Switch to ${isLight ? "dark" : "light"} theme`;
	themeIcon.textContent = isLight ? "dark_mode" : "light_mode";
	themeButton.setAttribute("aria-pressed", String(isLight));
});

let touchStartX = null;

document.addEventListener("touchstart", event => {
	touchStartX = event.changedTouches[0].clientX;
}, { passive: true });

document.addEventListener("touchend", event => {
	if (touchStartX === null) return;
	const distanceX = event.changedTouches[0].clientX - touchStartX;
	touchStartX = null;
	if (distanceX < -55 && menuButton.getAttribute("aria-expanded") !== "true") setMenuOpen(true);
	else if (distanceX > 55 && menuButton.getAttribute("aria-expanded") === "true") setMenuOpen(false);
}, { passive: true });

logsContainer.addEventListener("copy", event => event.preventDefault());
logsContainer.addEventListener("contextmenu", event => event.preventDefault());

connectEvents();
refreshDownloads().catch(error => {
	appendLog(`Could not connect to the download server: ${error.message}`);
});
