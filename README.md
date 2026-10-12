# Google Photos Album Archiver

A plain JavaScript Chrome Manifest V3 extension that scans a Google Photos album and then archives the scanned photos. It uses the album's photo IDs rather than matching filenames, dates, or image sizes. Archiving hides photos from the main Photos feed while retaining them in their albums.

## Install the extension

1. [Download the extension ZIP](https://github.com/opethian/script_chrome_v1/raw/refs/heads/main/downloads/photos-album-archiver-v1.0.2.zip) and unzip it. If the direct link does not download, open the file in the repository's `downloads` folder and select **Download raw file**.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**, click **Load unpacked**, and select the unzipped folder containing `manifest.json`.
4. Reload any Google Photos tabs that were already open.

When working from this repository, load the `extension` directory instead. No build or package installation is needed to use the extension.

When updating from v1.0.0 or v1.0.1, disable the old extension, load the new v1.0.2 folder, and reload Google Photos. The popup header should show v1.0.2. Both English and Turkish Google Photos interfaces are supported; changing language is not required for the keyboard scan fallback.

## Use it

1. In your signed-in Google Photos account, open an album, then open any photo inside that album.
2. Open the extension popup and click **Scan album**. The scan navigates to the first photo and records photo IDs through the end of the album. It makes no archive changes during scanning. If the navigation controls are not recognized, it probes the left/right arrow keys instead. Hidden hover controls are not assumed to mark the end of an album.
   If the scan requests a count check, read the total photo count in your Google Photos album, enter it in the popup, and click **Confirm album count**. The count must equal the collected list before archiving is enabled. If they differ, scan again; the extension does not assume that an ignored key means the album was fully scanned.
3. Review the scanned count. Click **Archive scanned photos** and confirm the batch once.
4. A separate working tab opens. Keep both that tab and the original album tab open. Let the extension work without navigating either tab.
5. Watch progress in the popup. **Stop** prevents work on the next photo; an action already sent can finish. Reopen the popup whenever needed; the job runs in the background.
6. Check Google Photos **Archive** after a small test run before using a large album.

Already-archived photos are skipped. A photo counts as archived only when its native menu subsequently offers **Unarchive / Remove from archive** after the same photo ID is reopened. A click or disappearing viewer is not counted as success. If a result is uncertain, processing stops. Check that photo manually, then scan again; uncertain operations are never retried automatically. Pending photos can be resumed after a clean stop. Restarting Chrome interrupts the job and does not automatically resume it.

Opening a photo or video and its menu in the working tab is part of the archive operation. Version 1.0.2 recognizes Archive and Unarchive labels even when a separate keyboard-shortcut caption is rendered in the same row, including Turkish **Arşivle · Üst Karakter+A**. It also supports clickable rows inside the menu that lack a button role. Shortcut text does not allow a different command such as Delete or Unarchive to be mistaken for Archive.

The popup can download a local progress report containing album and photo URLs. The extension makes no deletion requests and uploads no reports. Photos' own web interface handles the archive operation in the signed-in account.

## Supported interface

- Your own albums under `/album/…` or `/u/NUMBER/album/…`, including account prefixes.
- English, Turkish, Swedish, German, and French labels for navigation, Archive, Unarchive, and More options.
- Up to 5,000 photos per scan. Shared-link albums and unrecognized interface controls stop with an explanation.
- Chrome's **debugger** permission supplies trusted arrow-key navigation and keeps the background worker alive. Chrome displays its normal debugging notice. Detaching the debugger or closing a working tab stops the job. Close DevTools on the target tab if attaching fails.

Google Photos can change its DOM or labels. **Live Google Photos verification is still required:** the available cloud Chromium blocks native extension installation through an administrator policy. Automated tests use the actual scripts with simulated Chrome APIs and Photos pages; they do not prove signed-in Google Photos behavior or native extension API integration.

## Development

Requires Node.js 20+, Python 3, and Chromium for the browser tests.

```bash
npm ci
npm test
npm run package
```

In the cloud environment, tests use the installed `/usr/lib/chromium/chromium` binary. Set `CHROMIUM_PATH` to another Chromium executable, or run `npx playwright install chromium` when using Playwright's managed browser on another machine. No backend, API keys, or Google credentials are needed for the automated tests. The package command writes a ZIP under `dist/` containing the loadable extension and this README. The published browser-installation ZIP is kept in `downloads/`; refresh that copy before publishing an updated version.
