'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const dns = require('node:dns/promises');
const net = require('node:net');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');

function resolveYtDlpPath(binaryPath, resourcesPath = process.resourcesPath) {
	if (!resourcesPath) return binaryPath;
	const archivePath = path.join(resourcesPath, 'app.asar');
	const relativePath = path.relative(archivePath, binaryPath);
	if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return binaryPath;
	return path.join(resourcesPath, 'app.asar.unpacked', relativePath);
}

const ytDlp = youtubedl.create(resolveYtDlpPath(youtubedl.constants.YOUTUBE_DL_PATH));
const resolvedFfmpegPath = resolveYtDlpPath(ffmpegPath);

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DQUICK_DATA_DIR || path.join(ROOT, '.data'));
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const RECORDS_FILE = path.join(DATA_DIR, 'downloads.json');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_DOWNLOAD_PATH = path.join(os.homedir(), 'Downloads', 'Dquick Downloader');
const MIME_TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.mp4': 'video/mp4',
	'.mkv': 'video/x-matroska',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.wav': 'audio/wav',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/ogg',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.m4v': 'video/mp4',
	'.zip': 'application/zip',
	'.pdf': 'application/pdf'
};
const DOWNLOAD_EXTENSIONS = new Set([
	'.3gp', '.aac', '.avi', '.flac', '.m4a', '.m4v', '.mkv', '.mov',
	'.mp3', '.mp4', '.ogg', '.opus', '.wav', '.webm'
]);

const clients = new Set();
const durationProbePromises = new Map();
let activeJob = null;
let downloadPath = DEFAULT_DOWNLOAD_PATH;
let records = [];
let downloadSyncPromise = null;

function jsonResponse(response, statusCode, data) {
	response.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	response.end(JSON.stringify(data));
}

function broadcast(type, data) {
	const message = `data: ${JSON.stringify({ type, ...data })}\n\n`;
	for (const client of clients) {
		if (!client.destroyed) client.write(message);
	}
}

function log(job, message) {
	const entry = { id: job.id, time: new Date().toISOString(), message };
	broadcast('log', entry);
}

function badRequest(message) {
	throw Object.assign(new Error(message), { status: 400 });
}

async function createCookiesFile(contents) {
	if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > 256 * 1024) {
		badRequest('Cookies must be a Netscape-format cookies.txt file smaller than 256 KB.');
	}
	const lines = contents.split(/\r?\n/);
	const cookieRows = lines.filter(line => {
		if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) return false;
		const columns = line.replace(/^#HttpOnly_/, '').split('\t');
		return columns.length === 7 &&
			/^(?:TRUE|FALSE)$/i.test(columns[1]) &&
			/^(?:TRUE|FALSE)$/i.test(columns[3]) &&
			/^\d+$/.test(columns[4]) &&
			columns[5].length > 0;
	});
	if (!cookieRows.length) {
		badRequest('Paste a valid Netscape-format cookies.txt file with at least one cookie row.');
	}
	const cookiesDirectory = path.join(os.tmpdir(), 'dquick-downloader');
	await fsp.mkdir(cookiesDirectory, { recursive: true });
	const cookiesFile = path.join(cookiesDirectory, `cookies-${crypto.randomUUID()}.txt`);
	await fsp.writeFile(cookiesFile, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	return cookiesFile;
}

async function removeJobCookies(job) {
	if (!job.cookiesFile) return;
	await fsp.rm(job.cookiesFile, { force: true });
	job.cookiesFile = null;
}

function publishJob(job) {
	broadcast('job', publicJob(job));
}

function publicJob(job) {
	if (!job) return null;
	return {
		id: job.id,
		status: job.status,
		title: job.title,
		progress: job.progress,
		downloadedBytes: job.downloadedBytes,
		totalBytes: job.totalBytes,
		speedBytesPerSecond: job.speedBytesPerSecond,
		eta: job.eta,
		requiresSignIn: job.requiresSignIn === true
	};
}

function isPublicAddress(address) {
	if (net.isIP(address) === 4) {
		const octets = address.split('.').map(Number);
		const [a, b] = octets;
		return !(
			a === 0 || a === 10 || a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 192 && b === 0) ||
			(a === 192 && b === 0 && octets[2] === 2) ||
			(a === 198 && (b === 18 || b === 19 || b === 51)) ||
			(a === 203 && b === 0 && octets[2] === 113) ||
			a >= 224
		);
	}

	if (net.isIP(address) === 6) {
		const normalized = address.toLowerCase();
		if (normalized.startsWith('::ffff:')) return false;
		return !(
			normalized === '::' ||
			normalized === '::1' ||
			/^f[cd]/.test(normalized) ||
			/^fe[89ab]/.test(normalized) ||
			/^ff/.test(normalized) ||
			normalized.startsWith('2001:db8:') ||
			normalized.startsWith('2001:10:')
		);
	}

	return false;
}

async function validateDownloadUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		badRequest('Enter a valid public video URL.');
	}

	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		badRequest('Only public HTTP or HTTPS links are supported.');
	}

	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal') ||
		hostname.endsWith('.test')
	) {
		badRequest('Local network addresses are not allowed.');
	}

	let addresses;
	try {
		addresses = net.isIP(hostname)
			? [{ address: hostname }]
			: await dns.lookup(hostname, { all: true, verbatim: true });
	} catch {
		badRequest('The video host could not be resolved.');
	}

	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
		badRequest('The link must resolve to a public internet address.');
	}

	return url.toString();
}

async function readJsonBody(request) {
	let body = '';
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 1024 * 1024) badRequest('Request body is too large.');
	}
	try {
		return JSON.parse(body);
	} catch {
		badRequest('Invalid JSON request body.');
	}
}

async function saveJson(filePath, data) {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.tmp`;
	await fsp.writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
	await fsp.rename(temporaryPath, filePath);
}

function parseSize(value) {
	const match = value.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)?$/i);
	if (!match) return null;
	const factor = {
		B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
		KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4
	}[match[2] || 'B'];
	const size = Number(match[1]) * factor;
	return Number.isFinite(size) && size >= 0 ? size : null;
}

function parseProgress(job, line) {
	const progressMatch = line.match(/([+-]?\d+(?:\.\d+)?)%\s+of\s+(~?[\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))?/i);
	const speedMatch = line.match(/\bat\s+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)\/s)/i);
	const etaMatch = line.match(/\bETA\s+(\S+)/i);
	if (progressMatch) {
		const progress = Number(progressMatch[1]);
		job.progress = Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
		if (progressMatch[2]) job.totalBytes = parseSize(progressMatch[2].replace(/^~/, '').trim());
		if (Number.isFinite(job.totalBytes) && job.totalBytes >= 0) {
			job.downloadedBytes = Math.min(job.totalBytes, job.totalBytes * job.progress / 100);
		}
	}
	if (speedMatch) job.speedBytesPerSecond = parseSize(speedMatch[1].replace(/\/s$/, '').trim());
	if (etaMatch) job.eta = etaMatch[1];
	if (progressMatch || speedMatch) publishJob(job);
	return Boolean(progressMatch || speedMatch);
}

function handleOutput(job, chunk, streamName) {
	const bufferName = `${streamName}Buffer`;
	job[bufferName] += chunk.toString('utf8');
	const lines = job[bufferName].split(/\r?\n/);
	job[bufferName] = lines.pop() || '';
	for (const rawLine of lines) {
		const cleanLine = rawLine.replace(/\u001b\[[0-9;]*m/g, '');
		const line = cleanLine.trim();
		if (!line) continue;
		if (/sign in to confirm|not a bot/i.test(line)) job.requiresSignIn = true;
		if (cleanLine.startsWith('FILE:')) job.filePath = cleanLine.slice(5);
		if (line.startsWith('INFO:')) {
			const [title, duration, uploadDate] = line.slice(5).split('|');
			let metadataChanged = false;
			if (title && title !== job.title) {
				job.title = title;
				metadataChanged = true;
			}
			if (duration && duration !== 'NA' && duration !== job.duration) {
				job.duration = duration;
				metadataChanged = true;
			}
			if (uploadDate && uploadDate !== 'NA' && uploadDate !== job.uploadDate) {
				job.uploadDate = uploadDate;
				metadataChanged = true;
			}
			if (metadataChanged) publishJob(job);
		}
		if (!parseProgress(job, line)) log(job, line);
	}
}

function probeMediaDuration(filePath) {
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpegPath, [
			'-hide_banner',
			'-i', filePath,
			'-t', '0',
			'-f', 'null',
			'-'
		], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		let settled = false;
		let timedOut = false;
		let detectedDuration = null;
		const finish = (error, duration) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else resolve(duration);
		};
		const readDuration = () => {
			const match = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
			if (!match) return null;
			const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
			return Number.isFinite(seconds) ? String(seconds) : null;
		};
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => {
			stderr = (stderr + chunk).slice(-65536);
			detectedDuration = readDuration();
			if (detectedDuration !== null) {
				child.kill();
			}
		});
		child.on('error', error => finish(error));
		child.on('close', () => {
			if (timedOut) finish(new Error('Timed out while reading media duration.'));
			else finish(null, detectedDuration ?? readDuration());
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 10000);
	});
}

async function listDirectory(directory) {
	await fsp.mkdir(directory, { recursive: true });
	const entries = await fsp.readdir(directory, { withFileTypes: true });
	const files = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
		const filePath = path.join(directory, entry.name);
		const stat = await fsp.stat(filePath);
		return [entry.name, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs
		}];
	}));
	return new Map(files);
}

async function removeNewPartFiles(job) {
	const currentFiles = await fsp.readdir(job.downloadPath);
	for (const fileName of currentFiles) {
		if (!job.startingFiles.has(fileName) && fileName.endsWith('.part')) {
			await fsp.rm(path.join(job.downloadPath, fileName), { force: true });
		}
	}
}

async function findCompletedFile(job) {
	const downloadDirectory = path.resolve(job.downloadPath);
	const isInsideDownloadDirectory = filePath => {
		const relative = path.relative(downloadDirectory, filePath);
		return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	};

	if (job.filePath) {
		const reportedPath = path.resolve(job.filePath);
		if (isInsideDownloadDirectory(reportedPath)) {
			try {
				const stat = await fsp.stat(reportedPath);
				if (stat.isFile()) return { path: reportedPath, stat };
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
		}
	}

	const entries = await fsp.readdir(downloadDirectory, { withFileTypes: true });
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isFile() || /\.(?:part|ytdl|temp)$/i.test(entry.name)) continue;
		const candidatePath = path.join(downloadDirectory, entry.name);
		const stat = await fsp.stat(candidatePath);
		const previous = job.startingFiles.get?.(entry.name);
		if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ctimeMs === stat.ctimeMs) continue;
		if (job.startingFiles instanceof Set && job.startingFiles.has(entry.name)) continue;
		candidates.push({ path: candidatePath, modifiedAt: stat.mtimeMs, stat });
	}
	candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
	if (!candidates.length) return null;
	return candidates[0];
}

async function finishProcess(job, runId, code, error) {
	if (job.runId !== runId) return;
	job.child = null;
	for (const streamName of ['stdout', 'stderr']) {
		const bufferName = `${streamName}Buffer`;
		const remaining = job[bufferName];
		if (remaining.trim()) {
			job[bufferName] = '';
			handleOutput(job, `${remaining}\n`, streamName);
		}
	}

	if (job.cancelRequested) {
		job.status = 'cancelled';
		await removeNewPartFiles(job);
		await removeJobCookies(job);
		log(job, 'Download cancelled.');
		activeJob = null;
		publishJob(job);
		return;
	}

	if (job.pauseRequested) {
		job.status = 'paused';
		job.pauseRequested = false;
		log(job, 'Download paused. Resume to continue.');
		publishJob(job);
		return;
	}

	if (code !== 0) {
		job.status = 'error';
		job.error = error?.message || `yt-dlp exited with code ${code ?? 'unknown'}.`;
		if (job.requiresSignIn) {
			job.error += job.cookiesFile
				? ' The supplied cookies did not authorize this video; check that they are current and from an account with access.'
				: ' If you have permission to access this video, provide your exported cookies.txt file to retry.';
		}
		await removeJobCookies(job);
		log(job, `Download failed: ${job.error}`);
		activeJob = null;
		publishJob(job);
		return;
	}

	try {
		const completedFile = await findCompletedFile(job);
		if (!completedFile) throw new Error('yt-dlp finished, but no completed file was found in the download folder.');
		const { path: filePath, stat } = completedFile;
		const record = {
			id: crypto.randomUUID(),
			title: job.title || path.basename(filePath, path.extname(filePath)),
			path: filePath,
			size: stat.size,
			duration: job.duration || '—',
			date: new Date().toISOString(),
			uploadDate: job.uploadDate || null
		};
		const existingRecord = records.find(item => recordPathKey(item.path) === recordPathKey(filePath));
		if (existingRecord) {
			existingRecord.size = stat.size;
			existingRecord.title = record.title;
			existingRecord.duration = record.duration;
			existingRecord.date = record.date;
			existingRecord.uploadDate = record.uploadDate;
		} else {
			records.unshift(record);
		}
		await saveJson(RECORDS_FILE, records);
		job.status = 'completed';
		job.progress = 100;
		await removeJobCookies(job);
		log(job, `Download complete: ${path.basename(filePath)} (${formatBytes(stat.size)}).`);
		broadcast('files', { files: await publicFiles() });
		activeJob = null;
		publishJob(job);
	} catch (saveError) {
		job.status = 'error';
		job.error = saveError.message;
		await removeJobCookies(job);
		log(job, `Could not save downloaded file details: ${saveError.message}`);
		activeJob = null;
		publishJob(job);
	}
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let size = bytes / 1000;
	let index = 0;
	while (size >= 1000 && index < units.length - 1) {
		size /= 1000;
		index += 1;
	}
	return `${size.toFixed(1)} ${units[index]}`;
}

function selectDownloadFormat(audioOnly) {
	return audioOnly
		? 'bestaudio/best'
		: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best';
}

async function startJobProcess(job) {
	job.downloadPath ||= downloadPath;
	job.startingFiles ||= await listDirectory(job.downloadPath);
	job.status = 'running';
	job.pauseRequested = false;
	job.cancelRequested = false;
	job.stdoutBuffer = '';
	job.stderrBuffer = '';
	job.spawnError = null;
	job.runId += 1;
	const runId = job.runId;
	publishJob(job);
	log(job, job.status === 'running' && job.progress > 0 ? 'Resuming download with yt-dlp.' : 'Starting yt-dlp download.');

	const child = ytDlp.exec(job.url, {
		continue: true,
		noPlaylist: true,
		noWarnings: true,
		noColor: true,
		newline: true,
		progress: true,
		format: selectDownloadFormat(job.audioOnly),
		...(job.audioOnly ? { extractAudio: true, audioFormat: 'mp3' } : {}),
		...(job.cookiesFile ? { cookies: job.cookiesFile } : {}),
		ffmpegLocation: resolvedFfmpegPath,
		output: path.join(job.downloadPath, '%(title).180B [%(id)s].%(ext)s'),
		print: [
			'before_dl:INFO:%(title)s|%(duration)s|%(upload_date)s',
			'after_move:FILE:%(filepath)s',
			'after_move:INFO:%(title)s|%(duration)s|%(upload_date)s'
		]
	}, { cwd: job.downloadPath, windowsHide: true });

	job.child = child;
	child.stdout?.on('data', chunk => handleOutput(job, chunk, 'stdout'));
	child.stderr?.on('data', chunk => handleOutput(job, chunk, 'stderr'));
	child.on('error', error => {
		job.spawnError = error;
	});
	child.on('close', (code) => {
		finishProcess(job, runId, code, job.spawnError).catch(error => {
			job.status = 'error';
			job.error = error.message;
			removeJobCookies(job).catch(cleanupError => {
				log(job, `Could not remove temporary cookies file: ${cleanupError.message}`);
			});
			activeJob = null;
			log(job, `Download failed: ${error.message}`);
			publishJob(job);
		});
	});
	child.catch(() => {});
}

async function publicFiles() {
	const visible = await Promise.all(records.map(async record => {
		try {
			const stat = await fsp.stat(record.path);
			if (stat.isFile()) {
				return {
					id: record.id,
					title: record.title,
					size: stat.size,
					duration: record.duration,
					date: record.date,
					path: record.path,
					extension: path.extname(record.path).toLowerCase(),
					url: `/api/files/${record.id}`,
					playUrl: `/api/files/${record.id}/play`
				};
			}
			return null;
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			return null;
		}
	}));
	return visible.filter(Boolean);
}

function recordPathKey(filePath) {
	const resolvedPath = path.resolve(filePath);
	return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

async function discoverDownloadedFiles(directory, existingRecords) {
	const knownPaths = new Set(existingRecords.map(record => recordPathKey(record.path)));
	const discovered = [];
	const entries = await fsp.readdir(directory, { withFileTypes: true });
	const candidates = entries.filter(entry => entry.isFile() && !/\.(?:part|ytdl|temp)$/i.test(entry.name));
	const files = await Promise.all(candidates.map(async entry => {
		const extension = path.extname(entry.name).toLowerCase();
		if (!DOWNLOAD_EXTENSIONS.has(extension)) return null;
		const filePath = path.join(directory, entry.name);
		const key = recordPathKey(filePath);
		if (knownPaths.has(key)) return null;
		knownPaths.add(key);

		const stat = await fsp.stat(filePath);
		if (!stat.isFile()) return null;
		return {
			id: crypto.randomUUID(),
			title: path.basename(entry.name, extension),
			path: filePath,
			size: stat.size,
			duration: '—',
			date: stat.mtime.toISOString(),
			uploadDate: null
		};
	}));
	discovered.push(...files.filter(Boolean));
	discovered.sort((left, right) => right.date.localeCompare(left.date));
	return discovered;
}

async function syncDownloadedFiles() {
	if (downloadSyncPromise) return downloadSyncPromise;
	downloadSyncPromise = (async () => {
		const discovered = await discoverDownloadedFiles(downloadPath, records);
		if (!discovered.length) return false;
		records.unshift(...discovered);
		await saveJson(RECORDS_FILE, records);
		broadcast('files', { files: await publicFiles() });
		return true;
	})();
	try {
		return await downloadSyncPromise;
	} finally {
		downloadSyncPromise = null;
	}
}

async function serveFile(response, file, request, inline = false) {
	const fileName = path.basename(file.path);
	const size = (await fsp.stat(file.path)).size;
	const rangeHeader = request.headers.range;
	let statusCode = 200;
	let start = 0;
	let end = size - 1;
	const headers = {
		'Content-Type': MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream',
		'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
		'Accept-Ranges': 'bytes',
		'X-Content-Type-Options': 'nosniff'
	};
	if (size === 0) {
		headers['Content-Length'] = 0;
		response.writeHead(200, headers);
		response.end();
		return;
	}
	if (rangeHeader) {
		const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
		if (!match || (!match[1] && !match[2]) || size === 0) {
			response.writeHead(416, { 'Content-Range': `bytes */${size}` });
			response.end();
			return;
		}
		if (match[1]) {
			start = Number(match[1]);
			end = match[2] ? Number(match[2]) : size - 1;
		} else {
			const suffixLength = Number(match[2]);
			start = Math.max(0, size - suffixLength);
		}
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
			response.writeHead(416, { 'Content-Range': `bytes */${size}` });
			response.end();
			return;
		}
		end = Math.min(end, size - 1);
		statusCode = 206;
		headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
	}
	headers['Content-Length'] = end - start + 1;
	response.writeHead(statusCode, headers);
	const stream = fs.createReadStream(file.path, { start, end });
	stream.on('error', error => {
		if (!response.headersSent) jsonResponse(response, 500, { error: 'Could not read the file.' });
		else response.destroy(error);
	});
	stream.pipe(response);
}

function checkRequestOrigin(request) {
	const host = request.headers.host;
	if (!host || !['127.0.0.1', 'localhost'].includes(host.split(':')[0].replace(/^\[|\]$/g, ''))) {
		throw Object.assign(new Error('This app only accepts local requests.'), { status: 403 });
	}
	const origin = request.headers.origin;
	if (origin && origin !== `http://${host}`) {
		throw Object.assign(new Error('Cross-origin requests are not allowed.'), { status: 403 });
	}
}

async function handleApi(request, response, pathname) {
	checkRequestOrigin(request);

	if (request.method === 'GET' && pathname === '/api/events') {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		});
		response.write(': connected\n\n');
		clients.add(response);
		response.on('close', () => clients.delete(response));
		return;
	}

	if (request.method === 'GET' && pathname === '/api/downloads') {
		await syncDownloadedFiles();
		jsonResponse(response, 200, {
			active: publicJob(activeJob),
			files: await publicFiles(),
			downloadPath
		});
		return;
	}

	if (request.method === 'GET' && pathname === '/api/settings') {
		jsonResponse(response, 200, { downloadPath });
		return;
	}

	if (request.method === 'PUT' && ['/api/settings', '/api/settings/path'].includes(pathname)) {
		const body = await readJsonBody(request);
		if (typeof body.path !== 'string' || !body.path.trim()) {
			jsonResponse(response, 400, { error: 'Enter a download folder path.' });
			return;
		}
		const newPath = path.resolve(body.path.trim());
		const previousPath = downloadPath;
		await fsp.mkdir(newPath, { recursive: true });
		const probe = path.join(newPath, `.dquick-write-${crypto.randomUUID()}`);
		await fsp.writeFile(probe, '');
		await fsp.rm(probe);
		downloadPath = newPath;
		await saveJson(SETTINGS_FILE, { downloadPath });
		if (downloadPath !== previousPath) {
			broadcast('log', { time: new Date().toISOString(), message: `Download folder changed to ${downloadPath}.` });
		}
		jsonResponse(response, 200, { downloadPath });
		return;
	}

	if (request.method === 'POST' && pathname === '/api/downloads') {
		if (activeJob && ['running', 'pausing', 'paused', 'cancelling'].includes(activeJob.status)) {
			jsonResponse(response, 409, { error: 'A download is already active. Pause or cancel it first.' });
			return;
		}
		const body = await readJsonBody(request);
		if (body.audioOnly !== undefined && typeof body.audioOnly !== 'boolean') {
			badRequest('Audio-only must be a boolean value.');
		}
		if (body.cookies !== undefined && typeof body.cookies !== 'string') {
			badRequest('Cookies must be provided as Netscape-format cookies.txt text.');
		}
		const url = await validateDownloadUrl(body.url);
		const cookiesFile = body.cookies === undefined ? null : await createCookiesFile(body.cookies);
		await fsp.mkdir(downloadPath, { recursive: true });
		const job = {
			id: crypto.randomUUID(),
			url,
			audioOnly: body.audioOnly === true,
			cookiesFile,
			title: new URL(url).hostname,
			status: 'queued',
			progress: 0,
			downloadedBytes: 0,
			totalBytes: null,
			speedBytesPerSecond: null,
			eta: null,
			duration: null,
			uploadDate: null,
			filePath: null,
			stdoutBuffer: '',
			stderrBuffer: '',
			runId: 0,
			pauseRequested: false,
			cancelRequested: false,
			spawnError: null
		};
		activeJob = job;
		log(job, `Queued ${url}`);
		try {
			await startJobProcess(job);
		} catch (error) {
			activeJob = null;
			await removeJobCookies(job);
			throw error;
		}
		jsonResponse(response, 202, { job: publicJob(job) });
		return;
	}

	const actionMatch = pathname.match(/^\/api\/downloads\/([0-9a-f-]+)\/(pause|resume|cancel)$/i);
	if (request.method === 'POST' && actionMatch) {
		const [, id, action] = actionMatch;
		if (!activeJob || activeJob.id !== id) {
			jsonResponse(response, 404, { error: 'Active download not found.' });
			return;
		}
		const job = activeJob;
		if (action === 'pause' && job.status === 'running') {
			job.status = 'pausing';
			job.pauseRequested = true;
			job.child?.kill('SIGINT');
			log(job, 'Pausing download…');
		} else if (action === 'resume' && job.status === 'paused') {
			await startJobProcess(job);
		} else if (action === 'cancel' && ['running', 'pausing', 'paused'].includes(job.status)) {
			job.cancelRequested = true;
			job.status = 'cancelling';
			if (job.child) job.child.kill('SIGINT');
			else await finishProcess(job, job.runId, null);
			log(job, 'Cancelling download…');
		} else {
			jsonResponse(response, 409, { error: `Cannot ${action} a download while it is ${job.status}.` });
			return;
		}
		publishJob(job);
		jsonResponse(response, 200, { job: publicJob(job) });
		return;
	}

	const downloadMatch = pathname.match(/^\/api\/downloads\/([0-9a-f-]+)$/i);
	if (request.method === 'DELETE' && downloadMatch) {
		const index = records.findIndex(record => record.id === downloadMatch[1]);
		if (index < 0) {
			jsonResponse(response, 404, { error: 'Downloaded file not found.' });
			return;
		}
		const record = records[index];
		await fsp.rm(record.path, { force: true });
		records.splice(index, 1);
		await saveJson(RECORDS_FILE, records);
		log({ id: record.id }, `Deleted ${path.basename(record.path)}.`);
		jsonResponse(response, 200, { files: await publicFiles() });
		broadcast('files', { files: await publicFiles() });
		return;
	}

	const fileInfoMatch = pathname.match(/^\/api\/files\/([0-9a-f-]+)\/info$/i);
	if (request.method === 'GET' && fileInfoMatch) {
		const record = records.find(item => item.id === fileInfoMatch[1]);
		if (!record) {
			jsonResponse(response, 404, { error: 'Downloaded file not found.' });
			return;
		}
		if (!record.duration || record.duration === '—' || record.duration === 'NA') {
			let probe = durationProbePromises.get(record.id);
			if (!probe) {
				probe = probeMediaDuration(record.path);
				durationProbePromises.set(record.id, probe);
			}
			try {
				const duration = await probe;
				if (duration !== null) {
					record.duration = duration;
					await saveJson(RECORDS_FILE, records);
					broadcast('files', { files: await publicFiles() });
				}
			} catch (error) {
				jsonResponse(response, 500, { error: `Could not read video duration: ${error.message}` });
				return;
			} finally {
				durationProbePromises.delete(record.id);
			}
		}
		jsonResponse(response, 200, { duration: record.duration || '—' });
		return;
	}

	const playMatch = pathname.match(/^\/api\/files\/([0-9a-f-]+)\/play$/i);
	if (request.method === 'GET' && playMatch) {
		const file = records.find(record => record.id === playMatch[1]);
		if (!file) {
			jsonResponse(response, 404, { error: 'Downloaded file not found.' });
			return;
		}
		await serveFile(response, file, request, true);
		return;
	}

	const fileMatch = pathname.match(/^\/api\/files\/([0-9a-f-]+)$/i);
	if (request.method === 'GET' && fileMatch) {
		const file = records.find(record => record.id === fileMatch[1]);
		if (!file) {
			jsonResponse(response, 404, { error: 'Downloaded file not found.' });
			return;
		}
		await serveFile(response, file, request);
		return;
	}

	jsonResponse(response, 404, { error: 'API route not found.' });
}

const staticFiles = new Map([
	['/', ['app.html', 'text/html; charset=utf-8']],
	['/app.html', ['app.html', 'text/html; charset=utf-8']],
	['/assets/icon.svg', ['assets/icon.svg', 'image/svg+xml']],
	['/css/main.css', ['css/main.css', 'text/css; charset=utf-8']],
	['/js/main.js', ['js/main.js', 'text/javascript; charset=utf-8']]
]);

const server = http.createServer(async (request, response) => {
	try {
		checkRequestOrigin(request);
		const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
		if (requestUrl.pathname.startsWith('/api/')) {
			await handleApi(request, response, requestUrl.pathname);
			return;
		}
		const asset = staticFiles.get(requestUrl.pathname);
		if (request.method !== 'GET' || !asset) {
			jsonResponse(response, 404, { error: 'Page not found.' });
			return;
		}
		response.writeHead(200, {
			'Content-Type': asset[1],
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'no-cache'
		});
		fs.createReadStream(path.join(ROOT, asset[0])).pipe(response);
	} catch (error) {
		if (response.headersSent) {
			response.destroy(error);
			return;
		}
		const status = error.status || 500;
		if (status >= 500) console.error(error);
		jsonResponse(response, status, { error: error.message });
	}
});

async function startServer() {
	await fsp.mkdir(DATA_DIR, { recursive: true });
	try {
		const settings = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
		if (typeof settings.downloadPath === 'string' && settings.downloadPath) {
			downloadPath = path.resolve(settings.downloadPath);
		}
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	try {
		records = JSON.parse(await fsp.readFile(RECORDS_FILE, 'utf8'));
		if (!Array.isArray(records)) throw new Error('Download records file must contain an array.');
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		records = [];
	}
	await fsp.mkdir(downloadPath, { recursive: true });
	await syncDownloadedFiles();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(PORT, HOST, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const address = server.address();
	console.log(`Dquick Downloader is running at http://${HOST}:${address.port}`);
	console.log(`Downloads are saved to: ${downloadPath}`);
	return address;
}

if (require.main === module) {
	startServer().catch(error => {
		console.error('Failed to start Dquick Downloader:', error);
		process.exitCode = 1;
	});
}

module.exports = {
	isPublicAddress,
	validateDownloadUrl,
	createCookiesFile,
	removeJobCookies,
	formatBytes,
	selectDownloadFormat,
	parseProgress,
	handleOutput,
	probeMediaDuration,
	serveFile,
	findCompletedFile,
	discoverDownloadedFiles,
	syncDownloadedFiles,
	resolveYtDlpPath,
	server,
	startServer
};
