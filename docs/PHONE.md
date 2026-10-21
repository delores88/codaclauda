# Phone messages through ntfy

CodaClauda 0.6.1 adds two-way phone messages using ntfy. In **Settings > Phone**,
**Message your agents from your phone** starts off. Setup uses free ntfy topics,
with no SMS, phone number, or paid messaging service.

## Set it up

1. Install the ntfy app on your phone. In CodaClauda's existing **Phone
   notifications and replies** section, save an HTTPS topic URL that is long and
   hard to guess. Subscribe to that topic on the phone to receive replies.
2. Choose **Set up phone messages**. CodaClauda generates a separate inbound
   topic containing at least 32 random hexadecimal characters. **Copy** copies
   its `https://ntfy.sh/<topic>` URL. Subscribe to this topic too: the server is
   `ntfy.sh`, and the topic is the part after the final `/`. Creating the topic
   does not itself enable forwarding.
3. Choose a **Default recipient**, or keep **Automatic: most recently active
   CodaClauda session**. Address labels help you recognize a chat; they are
   self-asserted. The board address determines where a message goes.
4. Turn on **Message your agents from your phone**. Both the inbound topic and
   a different saved outbound topic are required.
5. On your phone, open the inbound topic and publish your message. The ntfy app
   has a publishing action; the ntfy web app also supports publishing, so you
   can open the inbound URL in the phone's browser. Send plain text such as
   `What is the current test result?` for the default recipient. To select an
   agent, send `@codex-example What is the current test result?`, replacing the
   example address with one from your board.
6. Read the answer on the outbound notification topic. Its title is the board
   sender and its body is the first 1,000 characters of the reply. The
   turn-finished and turn-error notification switches do not disable replies.

The official ntfy guides cover [phone subscriptions and publishing](https://docs.ntfy.sh/subscribe/phone/)
and [the web app](https://docs.ntfy.sh/subscribe/web/). Button placement varies by
phone platform. No live topic URL or credential belongs in this document.

**Regenerate** replaces the inbound topic. Update your phone subscription and
publish to the new URL afterward; the old topic no longer reaches CodaClauda.
Turning the switch off stops forwarding and keeps the saved setup. Only the
owner's desktop settings can enable, change, or regenerate this setup.

## Delivery and authority

A phone message becomes a board **notice** from `owner-phone`, never `owner`.
It is labeled as from Ben's phone and **unverified**, because anyone who knows
the topic can publish to it. It is information, not owner approval. It cannot
create grants, change project access, raise an agent's permissions, or authorize
an action that lacked authorization in the agent's own chat.

An explicit `@address` selects that known board recipient. Without it, the saved
default is used; Automatic selects the most recently active CodaClauda session.
An unknown address or a message that cannot be delivered gets a reason on the
outbound topic. A saved board receipt means the message was recorded, not that
an agent received a provider turn or acted on it. Existing wake settings and
project boundaries apply. A passive external address still needs its normal
reader or an existing supported wake binding.

Agents receiving phone mail should reply to `owner-phone` using their own board
address and the original notice's reply id. The session team note tells agents
about this reply path. Any board message addressed to `owner-phone` is eligible
for outbound forwarding while phone messaging is enabled.

Keep CodaClauda open and this PC online. Its host uses a short, timed poll of
`https://ntfy.sh/<topic>/json?poll=1&since=<last-id>` and persists its cursor and
delivery records. Reopening the app does not intentionally replay a handled
message. The [official ntfy subscription API](https://docs.ntfy.sh/subscribe/api/)
documents JSON lines, message ids, polling and the limited server cache.
Messages sent during a long offline period may expire from that cache; phone
notifications also depend on the phone's connection and notification settings.
If an outbound HTTP request has an ambiguous result, CodaClauda records the
unknown outcome and does not automatically send it again. Inspect the phone and
board before asking for a new reply. **Refresh phone status** rereads the local
setting and transport error; a settings save or successful HTTP response is
not a phone receipt.

## Privacy and storage

Keep both topic URLs private. A random topic is hard to guess, but is not
authenticated proof of who sent a message or end-to-end encryption. Anyone
who knows either topic can read its messages. Messages pass through the ntfy
service and its cache. See [ntfy publishing and topic guidance](https://docs.ntfy.sh/publish/).

The existing mailbox credential scanner checks inbound text and outbound reply
text before forwarding. A recognized credential causes a refusal with a fixed
explanation that does not echo the text. The filter cannot recognize every
secret: never intentionally send credentials, pairing codes, or private
transcripts. Refused outbound text must not be shortened first to hide a
credential beyond the 1,000-character preview.

The inbound topic, cursor and delivery receipts are saved in the board's
`desktop-ui/phone.json`. Receipts contain identifiers, digests, destinations and
status, not message bodies. Completed receipts become eligible for pruning after
30 days during later activity; unfinished inbound receipts are retained. Unknown push outcomes
remain recorded instead of being silently resent. If this file cannot be read,
the bridge preserves it and stays off until storage is repaired and the app is
restarted. It does not reset delivery history to make setup succeed.

The inbound topic and cursor are native owner-local settings. The UI holds the
topic in memory for display and explicit Copy; it does not put it into the
general UI store or localStorage. Phone transport diagnostic logs do not
contain message bodies. Successful inbound messages do become normal durable
board messages, subject to the mailbox's retention rules, and provider turns
may retain them in the recipient's conversation. This is distinct from logging.

## Acceptance evidence

This document describes the implementation contract. Focused deterministic
tests cover transport parsing, restart deduplication, routing, sender framing,
outbound forwarding, credential refusal, and native settings persistence. UI
tests exercise setup, confirmed settings, recipient changes, failure recovery,
Copy, Regenerate, and the three owner command wrappers without a network.

Passing those tests is not installed acceptance or proof of a real phone
round trip. Installed rendering, real ntfy delivery, phone notifications, an
actual agent reply, and restart behavior with the live service must be recorded
separately by the release reviewer. No release, installation, or live phone
acceptance is claimed by this source change.
