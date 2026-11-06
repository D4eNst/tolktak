from tolktak.store import users


async def establish_contact(owner, peer):
    states, _ = await users.change_contact(owner, peer, "send")
    identity = states[owner]["relation"]["request_id"]
    await users.change_contact(peer, owner, "accept", identity)
    return identity
