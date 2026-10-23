# Security policy

## Supported versions

TolkTak is in early development. Security fixes are made in the latest release only; please upgrade the server and the desktop app before reporting.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues, discussions or pull requests.

Report them privately through GitHub: open the [Security tab](https://github.com/D4eNst/tolktak/security) of the repository and choose **Report a vulnerability**. Include:

- the affected component (server, desktop app, deployment files) and version;
- a description of the problem and its impact;
- steps to reproduce, or a proof of concept;
- any suggested fix, if you have one.

You will get a response within 7 days. We will keep you informed while we work on a fix, agree on a disclosure date with you, and credit you in the advisory unless you prefer not to be named.

## Scope

The [security model](docs/development/architecture.md#security-model) describes what TolkTak protects against and what it does not. At present, a server operator can read the messages and files stored on their server, media is not end-to-end encrypted, and files can be downloaded by link without authentication. These are limitations of the current version; reports about these documented limitations are not vulnerabilities, although proposals to improve them are welcome as issues.
