'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
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
	resolveYtDlpPath,
	server
} = require('../server');

test('resolves bundled binaries to their unpacked location in packaged Electron apps', () => {
	const resourcesPath = path.join('C:', 'Program Files', 'Dquick Downloader', 'resources');
	const archivedPath = path.join(resourcesPath, 'app.asar', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
	const archivedFfmpegPath = path.join(resourcesPath, 'app.asar', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
	assert.equal(
		resolveYtDlpPath(archivedPath, resourcesPath),
		path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe')
	);
	assert.equal(
		resolveYtDlpPath(archivedFfmpegPath, resourcesPath),
		path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
	);
});

test('preserves yt-dlp path when it is outside the Electron app archive', () => {
	const binaryPath = path.join('C:', 'tools', 'yt-dlp.exe');
	const resourcesPath = path.join('C:', 'Program Files', 'Dquick Downloader', 'resources');
	assert.equal(resolveYtDlpPath(binaryPath, resourcesPath), binaryPath);
});

test('rejects private and special-use IP addresses', () => {
	for (const address of [
		'0.0.0.0',
		'10.0.0.8',
		'127.0.0.1',
		'169.254.1.1',
		'172.16.0.1',
		'192.168.1.1',
		'::1',
		'::ffff:7f00:1',
		'fc00::1',
		'fe80::1'
	]) {
		assert.equal(isPublicAddress(address), false, address);
	}
});

test('accepts public IP addresses', () => {
	assert.equal(isPublicAddress('1.1.1.1'), true);
	assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('rejects local and non-http download URLs', async () => {
	await assert.rejects(validateDownloadUrl('file:///C:/Users/example/video.mp4'), /HTTP or HTTPS/);
	await assert.rejects(validateDownloadUrl('http://127.0.0.1/video.mp4'), /public internet address/);
	await assert.rejects(validateDownloadUrl('http://localhost/video.mp4'), /Local network/);
});

test('normalizes public HTTP URLs and formats sizes', async () => {
	assert.equal(await validateDownloadUrl('https://1.1.1.1/video.mp4'), 'https://1.1.1.1/video.mp4');
	assert.equal(formatBytes(1024 * 1024), '1.0 MB');
	assert.equal(formatBytes(0), '0 B');
});

test('selects a single video format with audio unless audio-only is requested', () => {
	assert.equal(
		selectDownloadFormat(false),
		'bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best'
	);
	assert.equal(selectDownloadFormat(true), 'bestaudio/best');
});

test('writes valid Netscape cookies to a temporary file and removes it', async () => {
	const cookiesFile = await createCookiesFile([
		'# Netscape HTTP Cookie File',
		'.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSID\texample-cookie-value'
	].join('\n'));
	try {
		assert.match(await fs.readFile(cookiesFile, 'utf8'), /SID\texample-cookie-value/);
		const job = { cookiesFile };
		await removeJobCookies(job);
		assert.equal(job.cookiesFile, null);
		await assert.rejects(fs.access(cookiesFile), { code: 'ENOENT' });
	} finally {
		await fs.rm(cookiesFile, { force: true });
	}
});

test('rejects invalid or oversized Netscape cookies', async () => {
	await assert.rejects(createCookiesFile('not a cookies file'), /Netscape-format/);
	await assert.rejects(createCookiesFile('x'.repeat(256 * 1024 + 1)), /smaller than 256 KB/);
});

test('parses yt-dlp progress data for the downloads UI', () => {
	const job = { progress: 0, downloadedBytes: 0, totalBytes: null, speedBytesPerSecond: null, eta: null };
	assert.equal(parseProgress(job, '[download]  25.0% of 10.00MiB at 2.00MiB/s ETA 00:03'), true);
	assert.equal(job.progress, 25);
	assert.equal(job.totalBytes, 10 * 1024 * 1024);
	assert.equal(job.downloadedBytes, job.totalBytes * 0.25);
	assert.equal(job.speedBytesPerSecond, 2 * 1024 * 1024);
	assert.equal(job.eta, '00:03');
	assert.equal(parseProgress(job, '[youtube] Downloading webpage'), false);
});

test('clamps invalid yt-dlp progress percentages and rejects invalid sizes', () => {
	const job = { progress: 0, downloadedBytes: 0, totalBytes: null, speedBytesPerSecond: null, eta: null };
	assert.equal(parseProgress(job, '[download] -1.0% of 10.00MiB'), true);
	assert.equal(job.progress, 0);
	assert.equal(job.downloadedBytes, 0);

	assert.equal(parseProgress(job, '[download] 125.0% of 10.00MiB'), true);
	assert.equal(job.progress, 100);
	assert.equal(job.downloadedBytes, job.totalBytes);

	assert.equal(parseProgress(job, '[download] 50.0% of 10..00MiB'), true);
	assert.equal(job.totalBytes, null);
	assert.equal(Number.isFinite(job.progress), true);
	assert.ok(job.progress >= 0 && job.progress <= 100);
});

test('captures numeric media duration from yt-dlp output', () => {
	const job = { stdoutBuffer: '', stderrBuffer: '', duration: null, title: 'youtube.com', uploadDate: null };
	handleOutput(job, 'INFO:Example video|123.45|20261103\n', 'stdout');
	assert.equal(job.title, 'Example video');
	assert.equal(job.duration, '123.45');
	assert.equal(job.uploadDate, '20261103');
});

test('probes duration from previously downloaded media', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dquick-duration-test-'));
	try {
		const sampleCount = 8000;
		const header = Buffer.alloc(44);
		header.write('RIFF', 0);
		header.writeUInt32LE(36 + sampleCount, 4);
		header.write('WAVEfmt ', 8);
		header.writeUInt32LE(16, 16);
		header.writeUInt16LE(1, 20);
		header.writeUInt16LE(1, 22);
		header.writeUInt32LE(8000, 24);
		header.writeUInt32LE(8000, 28);
		header.writeUInt16LE(1, 32);
		header.writeUInt16LE(8, 34);
		header.write('data', 36);
		header.writeUInt32LE(sampleCount, 40);
		const filePath = path.join(directory, 'sample.wav');
		await fs.writeFile(filePath, Buffer.concat([header, Buffer.alloc(sampleCount, 128)]));
		assert.equal(await probeMediaDuration(filePath), '1');
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('streams playable files with byte-range support', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dquick-play-test-'));
	const filePath = path.join(directory, 'sample.mp4');
	await fs.writeFile(filePath, '0123456789');
	const fileServer = http.createServer((request, response) => {
		serveFile(response, { path: filePath }, request, true).catch(error => {
			response.writeHead(500);
			response.end(error.message);
		});
	});
	await new Promise(resolve => fileServer.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		await new Promise(resolve => fileServer.close(resolve));
		await fs.rm(directory, { recursive: true, force: true });
	});

	const address = fileServer.address();
	const response = await fetch(`http://127.0.0.1:${address.port}/play`, {
		headers: { Range: 'bytes=2-5' }
	});
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('content-type'), 'video/mp4');
	assert.equal(response.headers.get('content-disposition'), "inline; filename*=UTF-8''sample.mp4");
	assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
	assert.equal(await response.text(), '2345');
});

test('resolves yt-dlp reported file paths with leading spaces', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dquick-download-test-'));
	try {
		const filePath = path.join(directory, '   #video [id].webm');
		await fs.writeFile(filePath, 'video');
		const job = {
			downloadPath: directory,
			startingFiles: new Set(),
			stdoutBuffer: '',
			stderrBuffer: '',
			filePath: null
		};
		handleOutput(job, `FILE:${filePath}\n`, 'stdout');
		assert.equal(job.filePath, filePath);
		assert.equal((await findCompletedFile(job)).path, filePath);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('finds a completed output file when yt-dlp path metadata is unavailable', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dquick-download-test-'));
	try {
		await fs.writeFile(path.join(directory, 'video.mp4.part'), 'partial');
		await fs.writeFile(path.join(directory, 'video.mp4'), 'complete');
		const result = await findCompletedFile({
			downloadPath: directory,
			startingFiles: new Set()
		});
		assert.equal(result.path, path.join(directory, 'video.mp4'));
		assert.equal(result.stat.size, 8);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('finds a completed file when yt-dlp overwrites an existing filename', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dquick-download-test-'));
	try {
		const filePath = path.join(directory, 'video.mp4');
		await fs.writeFile(filePath, 'old');
		const originalStat = await fs.stat(filePath);
		const snapshot = new Map([[
			'video.mp4',
			{ size: originalStat.size, mtimeMs: originalStat.mtimeMs, ctimeMs: originalStat.ctimeMs }
		]]);
		await new Promise(resolve => setTimeout(resolve, 20));
		await fs.writeFile(filePath, 'new completed video');

		const result = await findCompletedFile({
			downloadPath: directory,
			startingFiles: snapshot
		});
		assert.equal(result.path, filePath);
		assert.equal(result.stat.size, 19);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('discovers unregistered completed media and ignores partial or non-media files', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dquick-download-test-'));
	try {
		await fs.writeFile(path.join(directory, 'saved video.webm'), 'video');
		await fs.writeFile(path.join(directory, 'saved audio.mp3'), 'audio');
		await fs.writeFile(path.join(directory, 'unfinished.mp4.part'), 'partial');
		await fs.writeFile(path.join(directory, 'notes.txt'), 'not a download');

		const discovered = await discoverDownloadedFiles(directory, []);
		assert.deepEqual(new Set(discovered.map(file => file.title)), new Set(['saved video', 'saved audio']));
		assert.equal(discovered.length, 2);
		assert.deepEqual(await discoverDownloadedFiles(directory, discovered), []);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('serves the app and rejects non-web download URLs', async t => {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	const address = server.address();
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const page = await fetch(baseUrl);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Dquick Downloader/);

	const response = await fetch(`${baseUrl}/api/downloads`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url: 'file:///C:/Windows/win.ini' })
	});
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /HTTP or HTTPS/);
});
