# PDF Downloader

A Chrome extension that saves PDFs you already have access to — including PDFs shown in embedded viewers that have no download button.

This is the source-available repository for the **sideload build**. The Chrome Web Store edition may lag behind the fixes in this repository. The code is public so you can inspect exactly what the extension does; it is not open source. See [LICENSE](LICENSE).

## Install from the release ZIP

1. Download the latest `pdf-downloader-extension-vX.Y.Z.zip` from [Releases](https://github.com/heyitsR1/pdf-downloader-extension/releases).
2. Unzip it. Keep the unzipped folder somewhere permanent — Chrome loads the extension from that folder, so moving or deleting it disables the extension.
3. Open `chrome://extensions` in Chrome. On Edge use `edge://extensions`; on Brave use `brave://extensions`.
4. Turn on **Developer mode** in the top-right corner.
5. Click **Load unpacked** and select the unzipped folder — the folder that contains `manifest.json`. Do not select the ZIP itself or its parent folder.
6. Pin **PDF Downloader** from the puzzle icon.
7. Open a PDF page you are allowed to access. A floating **Download PDF** button appears when a PDF is detected; you can also click the extension icon to see every PDF on the tab.

Chrome may show a "Developer mode extensions" warning when it starts. That is normal for extensions installed outside the Chrome Web Store.

## What it does

- Detects PDFs loaded by the current tab, including embedded and iframe viewers.
- Adds a floating download button and a popup list with per-file downloads.
- Bulk-downloads every detected PDF as a ZIP on Pro.
- Keeps detection and downloads local to your browser.

## What it does not do

- It does not bypass paywalls, logins, passwords, or DRM.
- It only works on PDFs your browser can already load and you have the right to access.
- It does not read PDFs from `file://` URLs or local folders.
- It does not work in Firefox, Safari, or mobile browsers.

## Free and Pro

- Free: 5 downloads.
- Pro: unlimited downloads and bulk ZIP, one-time $4.99.

The extension checks a license key with Freemius when you activate Pro. No PDFs or browsing data are uploaded. See the [privacy policy](https://tailsgate.com/pdf-downloader/privacy).

## Troubleshooting

**"Manifest file is missing or unreadable"**
You selected the wrong folder. Select the unzipped folder that contains `manifest.json` — usually the folder named after the ZIP, not the ZIP itself and not the folder above it.

**"Load unpacked" is greyed out**
Turn on **Developer mode** in `chrome://extensions`.

**The extension disappeared after a restart**
Chrome loads the extension from the unzipped folder. If you moved or deleted that folder, reinstall from the ZIP. Otherwise re-enable it in `chrome://extensions`.

**No PDFs found yet**
Reload the page, then open or scroll to the PDF so the viewer loads it. If the PDF is inside a cross-origin viewer, open the PDF in its own tab. Click the extension icon to check the popup list.

**The floating button is missing**
Some browsers or pages suppress injected elements. Use the extension popup instead; it lists the detected PDFs.

**The PDF is password-protected**
If you already entered the password in the browser and the PDF is visible, the extension can capture the loaded file. If the password prompt is still showing, there is nothing loaded to capture.

**A download fails or is empty**
The site may require a login session that expired, or may block direct downloads. Reload the page, sign in again, and retry immediately after the PDF loads. Some sites use canvas-only viewers that never expose a PDF file; those are not supported.

## Permissions

- `webRequest` — detects PDF requests as the page loads.
- `downloads` — saves the file you choose.
- `storage` — stores your download count and license state locally.
- `scripting` — adds the floating button and download overlay.
- `<all_urls>` — PDFs can be served from any domain, so detection runs on any page you visit.

## Development

There is no build step. Load the repository root as an unpacked extension, edit a file, then click the reload button on the extension card in `chrome://extensions`.

To build the release ZIP:

```bash
./package-extension.sh
```

The ZIP is written to the repository root and is ignored by git.

## Support

Email [support@tailsgate.com](mailto:support@tailsgate.com). Include your Chrome version, the site where the PDF is hosted, and what you see in the popup.

## License

Source-available, not open source. The code is public for transparency, but all rights are reserved: no redistribution, no modified or derivative versions, and no removing license checks. See [LICENSE](LICENSE). Use the official builds from [Releases](https://github.com/heyitsR1/pdf-downloader-extension/releases).
