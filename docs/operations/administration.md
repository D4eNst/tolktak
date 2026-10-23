# Administration

What the person running a server can control, and what they are responsible for.

## The administrator

The first account registered on a server becomes its administrator, whatever the registration mode. Register it right after the first start, before you share the address.

There is one administrator role and it covers the server, not the groups in it: the administrator manages invites and is otherwise a normal user. Groups are run by their own members (see below).

## Registration and invites

`TOLKTAK_REGISTRATION` decides who can create an account:

| Mode | Use when |
|---|---|
| `invite` (default) | You hand out codes to the people you want. |
| `open` | The server is on a private network, or you want anyone with the address to join. |
| `closed` | Everyone who should be there already is. |

Invites are managed on the server's website at `/admin`, signed in as the administrator. Each code has a use limit (1 to 1000) and an expiry in days. Delete a code to revoke it; accounts created with it stay. People register on the server's website; an invite link (`/?invite=CODE`) fills the code in.

There is no account deletion or ban in this version. To remove a person, remove them from the groups they are in (group owners and moderators can), and stop issuing them invites.

## Groups

Any user can create a group and becomes its owner. Roles in a group:

| | Member | Moderator | Owner |
|---|:-:|:-:|:-:|
| Chat, voice, screen sharing | ✓ | ✓ | ✓ |
| Rename the group, change its picture and description | | ✓ | ✓ |
| Add members, remove members | | ✓ | ✓ |
| Create, rename and delete voice rooms and text channels | | ✓ | ✓ |
| Remove a moderator, appoint moderators | | | ✓ |
| Delete the group | | | ✓ |

If the owner leaves, ownership passes to the member who joined earliest. A group disappears when its last member leaves.

Limits per group: 200 members, 20 voice rooms, 30 text channels. Messages are up to 4000 characters with up to 10 attachments.

## Data and privacy

Be clear with your users about this:

- You, as the operator, can read everything stored on the server: messages, files and the account list. There is no end-to-end encryption. Voice and video are not recorded or stored.
- A file is available to anyone who has its link, without signing in. Links are random and are not guessable.
- Deleting a message erases its text and its attachment list from the database. The uploaded files themselves stay on disk.

See the [security model](../development/architecture.md#security-model) for the details.

## Server address and name

The name shown in the apps comes from `TOLKTAK_SERVER_NAME`. Users connect by address, so changing domains means everyone has to sign in again with the new address; keep the old name pointing to the server for a while, or redirect it in the reverse proxy.
