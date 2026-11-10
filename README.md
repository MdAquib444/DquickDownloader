# Dquick Downloader

Dquick Downloader runs as a Windows desktop app or as a local web app. Use Node.js 18 or newer for development.

## Run the desktop app

```powershell
npm install
npm run desktop
```

Create a Windows installer (`dist\Dquick Downloader Setup <version>.exe`) on Windows:

```powershell
npm run dist:win
```

The installer creates Start Menu and desktop shortcuts. User settings and download history are stored in the Windows app-data folder; downloaded media is saved to the `Dquick Downloader` folder inside your user Downloads directory by default. Change the folder from the app menu.

The Windows app, installer shortcuts, and app header use the branded download icon in `assets\icon.ico` and `assets\icon.svg`.

## Run the web app

```powershell
npm start
```

Open `http://127.0.0.1:3000` in a browser.

The app uses yt-dlp and bundled FFmpeg to download and combine video/audio streams up to 1080p where available. Playlist URLs do not download playlist contents; only the linked video is downloaded. Check **Audio only** to save an MP3 instead. Only download content you own or have permission to save.

If yt-dlp reports that a video requires sign-in, the app opens a dialog where you can paste the contents of an exported Netscape-format `cookies.txt` file and retry. The cookie contents are written to a temporary file only while that download runs, are not saved in settings or logs, and are deleted when the job finishes, fails, or is cancelled. Cookies are sensitive; do not share them or paste your account password.

Run the backend checks with `npm test`.
