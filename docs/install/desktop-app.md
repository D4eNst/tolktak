# Desktop app

## Installation

| System | Build |
|---|---|
| Windows 10 and 11, x64 | `.exe` |
| macOS, Apple Silicon or Intel | `.dmg` for your processor |
| Linux, x64 | `.AppImage` or `.deb` |

[Download the app](https://tolktak.d4enst.ru/en/download/)

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

## Platform differences

| System | Screen-sharing audio |
|---|---|
| Windows 11 | Audio from the selected app when sharing a window. When sharing the entire screen, call participants' voices are excluded from system audio. |
| Windows 10 | All system audio, including call participants' voices. The app displays a warning before sharing. |
| macOS and Linux | Video without audio. |

Push to talk works outside the TolkTak window on Windows. On macOS and Linux, it requires the app window to have focus. Global hotkey support on Linux with Wayland depends on the desktop environment.

## Updates

New versions are available on the [downloads page](https://tolktak.d4enst.ru/en/download/). In builds that support automatic updates, the app downloads the new version and offers to restart. Automatic updates are not available on macOS yet; new versions need to be installed manually.

For sign-in, audio and screen-sharing issues, see [Troubleshooting](../operations/troubleshooting.md).
