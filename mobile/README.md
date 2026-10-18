# AegisX Editor – Android app

Thin Capacitor wrapper that loads https://editor.aegisxx.buzz in a WebView.
The APK is built and published to GitHub Releases automatically by
`.github/workflows/android-release.yml` whenever files in `mobile/` change on `main`.

Frontend/backend changes only need a server update (`./deploy/update.sh`) – no new APK.
