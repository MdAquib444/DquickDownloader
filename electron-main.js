'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');

app.setAppUserModelId('com.dquick.downloader');

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	let mainWindow;

	app.on('second-instance', () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	});

	let appUrl;
	let appServer;

	function createWindow() {
		mainWindow = new BrowserWindow({
			width: 1100,
			height: 760,
			minWidth: 720,
			minHeight: 560,
			title: 'Dquick Downloader',
			icon: path.join(__dirname, 'assets', 'icon.ico'),
			autoHideMenuBar: true,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true
			}
		});

		const appOrigin = new URL(appUrl).origin;
		const isAppUrl = url => {
			try {
				return new URL(url).origin === appOrigin;
			} catch {
				return false;
			}
		};
		const openExternalUrl = url => {
			if (['http:', 'https:'].includes(new URL(url).protocol)) {
				shell.openExternal(url).catch(error => console.error('Could not open external link:', error));
			}
		};

		mainWindow.webContents.setWindowOpenHandler(({ url }) => {
			if (isAppUrl(url)) return { action: 'allow' };
			openExternalUrl(url);
			return { action: 'deny' };
		});

		mainWindow.webContents.on('will-navigate', (event, url) => {
			if (!isAppUrl(url)) {
				event.preventDefault();
				openExternalUrl(url);
			}
		});

		mainWindow.on('closed', () => {
			mainWindow = null;
		});

		return mainWindow.loadURL(appUrl);
	}

	app.whenReady().then(async () => {
		process.env.PORT = '0';
		process.env.DQUICK_DATA_DIR = app.getPath('userData');

		const { server, startServer } = require('./server');
		const address = await startServer();
		appUrl = `http://127.0.0.1:${address.port}`;
		appServer = server;
		await createWindow();
		app.on('before-quit', () => {
			if (appServer.listening) appServer.close();
		});
	}).catch(async error => {
		console.error('Failed to start Dquick Downloader:', error);
		await dialog.showMessageBox({
			type: 'error',
			title: 'Dquick Downloader',
			message: 'The application could not start.',
			detail: error.message
		});
		app.quit();
	});

	app.on('activate', () => {
		if (mainWindow) mainWindow.focus();
		else if (appUrl) createWindow().catch(error => console.error('Could not reopen the app window:', error));
	});
}
