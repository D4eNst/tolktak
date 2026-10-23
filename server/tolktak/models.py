from tortoise import fields
from tortoise.models import Model


class User(Model):
    id = fields.BigIntField(primary_key=True)
    username = fields.TextField()
    display_name = fields.TextField()
    password_hash = fields.TextField()
    color = fields.TextField()
    is_admin = fields.IntField(default=0)
    created_at = fields.BigIntField()
    avatar = fields.TextField(default="")
    about = fields.TextField(default="")
    status = fields.TextField(default="")

    class Meta:
        table = "users"


class Session(Model):
    id = fields.BigIntField(primary_key=True)
    user_id = fields.BigIntField()
    token_hash = fields.BinaryField()
    device = fields.TextField(default="")
    created_at = fields.BigIntField()
    last_seen = fields.BigIntField()

    class Meta:
        table = "sessions"


class Invite(Model):
    code = fields.CharField(max_length=64, primary_key=True)
    created_by = fields.BigIntField()
    max_uses = fields.IntField()
    uses = fields.IntField(default=0)
    expires_at = fields.BigIntField()
    created_at = fields.BigIntField()

    class Meta:
        table = "invites"


class Channel(Model):
    id = fields.BigIntField(primary_key=True)
    kind = fields.TextField()
    dm_key = fields.TextField(null=True)
    created_at = fields.BigIntField()

    class Meta:
        table = "channels"


class ChannelMember(Model):
    # Primary key is (channel_id, user_id).
    channel_id = fields.BigIntField(primary_key=True, generated=False)
    user_id = fields.BigIntField()
    last_read_id = fields.BigIntField(default=0)

    class Meta:
        table = "channel_members"


class Group(Model):
    id = fields.BigIntField(primary_key=True)
    name = fields.TextField()
    owner_id = fields.BigIntField()
    channel_id = fields.BigIntField()
    created_at = fields.BigIntField()
    avatar = fields.TextField(default="")
    description = fields.TextField(default="")

    class Meta:
        table = "groups"


class GroupMember(Model):
    # Primary key is (group_id, user_id).
    group_id = fields.BigIntField(primary_key=True, generated=False)
    user_id = fields.BigIntField()
    joined_at = fields.BigIntField()
    role = fields.TextField(default="member")

    class Meta:
        table = "group_members"


class Room(Model):
    id = fields.BigIntField(primary_key=True)
    group_id = fields.BigIntField()
    name = fields.TextField()
    position = fields.IntField()
    created_at = fields.BigIntField()

    class Meta:
        table = "rooms"


class Message(Model):
    id = fields.BigIntField(primary_key=True)
    channel_id = fields.BigIntField()
    author_id = fields.BigIntField()
    nonce = fields.TextField()
    text = fields.TextField()
    created_at = fields.BigIntField()
    edited_at = fields.BigIntField(null=True)
    deleted = fields.IntField(default=0)
    reply_to = fields.BigIntField(null=True)
    # Comma-separated file ids.
    attachments = fields.TextField(default="")
    pinned_at = fields.BigIntField(null=True)

    class Meta:
        table = "messages"


class File(Model):
    id = fields.CharField(max_length=64, primary_key=True)
    uploader_id = fields.BigIntField()
    name = fields.TextField()
    mime = fields.TextField()
    size = fields.BigIntField()
    width = fields.IntField(default=0)
    height = fields.IntField(default=0)
    created_at = fields.BigIntField()

    class Meta:
        table = "files"


class Reaction(Model):
    # Primary key is (message_id, emoji, user_id).
    message_id = fields.BigIntField(primary_key=True, generated=False)
    user_id = fields.BigIntField()
    emoji = fields.TextField()
    created_at = fields.BigIntField()

    class Meta:
        table = "reactions"


class TextChannel(Model):
    channel_id = fields.BigIntField(primary_key=True, generated=False)
    group_id = fields.BigIntField()
    name = fields.TextField()
    position = fields.IntField()
    created_at = fields.BigIntField()

    class Meta:
        table = "text_channels"
