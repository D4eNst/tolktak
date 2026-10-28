# Desktop app

## Installation

| System | Build |
|---|---|
| Windows 10 and 11, x64 | `.exe` |
| macOS, Apple Silicon or Intel | `.dmg` for your processor |
| Linux, x64 | `.AppImage` or `.deb` |

[Download the app](https://tolktak.d4enst.ru/en/download/)

The macOS app is not notarized by Apple, so macOS blocks it the first time it starts. Open System Settings → Privacy & Security, find the message about TolkTak and click Open Anyway. Repeat this after downloading a new version.

## Registration and sign-in

1. Open the server address in a browser and create an account. If registration is invite-only, the operator will need to provide an invite code.
2. Start TolkTak and enter the same server address, username and password.

The registration button in the app opens the selected server's website in a browser. Each server has its own accounts.

Example addresses:

- `https://talk.example.com` — a server with HTTPS;
- `http://192.168.1.20:8080` — a server on a local network without HTTPS.

Use your server's address in place of these examples. A [self-signed certificate](../guides/certificates.md#self-signed-certificate) also needs to be trusted on the device.

## Permissions

The app requests microphone and camera access when they are first used. If access is denied, the voice and video settings display a warning with a link to system permissions.

On macOS, screen sharing requires separate permission under Privacy & Security. TolkTak may need to be restarted after changing it.

## Platform limitations

The early version currently has a few limitations that depend on the system. They are planned to be addressed in future versions.

- **macOS and Linux:** screen sharing has no audio, and push to talk works only while the TolkTak window has focus.
- **Windows 10:** screen sharing sends all system audio, including call participants' voices. The app warns about this before sharing starts.
- **Linux with Wayland:** global hotkey support depends on the desktop environment.

## Updates

The app follows the version of its server. When it starts, a small window asks the server which version it runs, downloads that version and installs it without an installer window. If the server is unreachable, the app starts as it is. When the server updates while the app is open, the app downloads the new version in the background and offers to restart; if the server no longer supports the running version, the update installs right away.

The Windows installer and the Linux AppImage update this way. On macOS, in the portable Windows zip and with the `.deb` package, the app offers a Download button instead; new versions are on the [downloads page](https://tolktak.d4enst.ru/en/download/).

For sign-in, audio and screen-sharing issues, see [Troubleshooting](../operations/troubleshooting.md).
