# Phone conversation through ntfy

CodaClauda 0.6.1 uses one ntfy topic for phone messages, agent replies, and
turn notifications. Save the URL once in **Settings > Phone**. **Message your
agents from your phone** is on by default when a URL is saved; an explicit Off
is preserved. Without a saved URL, nothing is sent to or read from ntfy. No
SMS, phone number, or paid messaging service is required.

## Start a conversation

1. Install the ntfy app on your phone and subscribe to a long random topic.
   Save that topic's HTTPS URL in **Settings > Phone** in CodaClauda.
2. Open the same topic on your phone and publish a message. Start with an
   agent's name, such as `@Reviewer What is the current test result?`, or its
   board address, such as `@codex-example What is the current test result?`.
   Settings shows a few available names and addresses to help you get started.
3. Read the agent's answer in that topic. Publish your next message as ordinary
   text to reply to the last agent who messaged your phone. Use `@name` again
   when you want to speak to another agent.

For a session name with spaces, use `@"Release reviewer" What passed?`. An
unquoted name also works: `@Release reviewer What passed?` matches the longest
unambiguous session title at the start. If two sessions have the same name,
use the board address. An unknown or ambiguous name gets a reason in the phone
conversation. Names and addresses are self-asserted, not verified identities.

Until an agent has messaged that topic, ordinary text gets **Start with @name
to choose an agent**. CodaClauda never chooses the most recently active agent
as a fallback. It remembers the last agent whose phone message was confirmed
by ntfy for the current URL. Changing the topic starts a new conversation.

**Send test** sends one fixed CodaClauda notice to the saved topic. Save any URL
edit first. The result reports ntfy's HTTP outcome and message identifier when
available; acceptance by ntfy does not prove display on your phone. An unknown
outcome may already have arrived, so inspect the topic before choosing to send
another test. Tests are tagged as CodaClauda messages, never routed to an agent,
and never retried automatically. The button works independently of the messaging
and turn-notification switches.

You can also publish in your phone browser by opening the topic URL. The
official ntfy guides cover [phone subscriptions and publishing](https://docs.ntfy.sh/subscribe/phone/)
and [the web app](https://docs.ntfy.sh/subscribe/web/). Publishing button
placement varies by phone platform. No live topic URL belongs in this document.

Agent replies show the sender and the first 1,000 characters. The turn-finished
and turn-error switches control those notices; they do not disable agent
replies. Turning **Message your agents from your phone** off stops incoming
messages and agent replies while keeping the URL. Only the owner changes these
settings; no separate inbound topic or recipient picker is needed.

## Delivery and authority

A phone message becomes a board **notice** from `owner-phone`, never `owner`.
It appears as **Ben (phone)** and is handled as Ben's ordinary message, including
requests and approvals. The owner has chosen this phone channel. Existing
project access, wake switches and owner controls still apply; receiving a
message does not itself change saved permissions or technical session bindings.

A saved board receipt means the message was recorded, not that an agent ran
or acted on it. Existing wake settings and project boundaries apply. A passive
external address still needs its normal reader or an existing supported wake
binding. Agents receiving phone mail should reply to `owner-phone` using their
own address and the original notice's reply id; the session team note describes
this. Board messages to `owner-phone` are forwarded while messaging is on.

Keep CodaClauda open and this PC online. Its host polls the saved topic with a
timeout and persists its cursor and delivery records, so reopening does not
intentionally replay a handled message. The [official ntfy subscription API](https://docs.ntfy.sh/subscribe/api/)
documents JSON lines, message ids, polling, and the limited server cache.
Notification-clear, delete and other non-message events are skipped. Valid
same-topic event IDs advance the cursor in order, so reading a notification
does not block later phone messages. Delivery failures stop cursor progress
before later events; existing receipts prevent duplicate board messages.
Messages can expire during a long offline period. Phone notifications also
depend on the phone's connection and notification settings.

If an outbound HTTP request has an ambiguous result, CodaClauda records the
unknown outcome and does not automatically send it again. Inspect the phone and
board before asking for a new reply. **Refresh phone status** rereads the local
setting and transport error. A settings save or successful HTTP response is
not proof the phone displayed a message.

## Privacy and storage

Keep the topic URL private and use a long random topic. Anyone who knows it
can read and send messages. A hard-to-guess topic is not authenticated proof of
who sent a message or end-to-end encryption. Messages pass through ntfy and
its cache. See [ntfy publishing and topic guidance](https://docs.ntfy.sh/publish/).

The existing mailbox credential scanner checks incoming text and outgoing
replies before forwarding. A recognized credential causes a refusal with a
fixed explanation that does not echo the text. Outgoing text is scanned before
the 1,000-character preview is taken. The filter cannot recognize every secret:
never send credentials, pairing codes, or private transcripts.

The URL remains in the existing native notification settings. Phone routing,
cursor, and delivery receipts are owner-local in `desktop-ui/phone.json`.
Receipts contain identifiers, digests, destinations, and status, not message
bodies. Completed receipts become eligible for pruning after 30 days during
later activity; unfinished incoming receipts remain. Unknown push outcomes
remain recorded instead of being silently resent. Unreadable phone state is
preserved and forwarding stays off until storage is repaired and the app is
restarted; the app does not reset history to make setup succeed.

The UI does not put the phone URL or routing state in its general store or
localStorage. Phone transport diagnostic logs do not contain message bodies.
Successfully delivered messages become normal durable board messages and may
enter the recipient's provider conversation, with those systems' retention.

## Acceptance evidence

This document describes source behavior. Deterministic tests exercise routing,
the one-topic transport, restart deduplication, ordinary Ben (phone) messages,
credential refusal, and settings persistence. UI tests cover the single switch,
saved URL state, last-sender hints, bounded name hints, confirmed settings,
failure recovery, concurrent refresh, and the two owner command wrappers.

Passing those tests is not installed acceptance or a real phone round trip.
Installed rendering, live ntfy delivery, phone notifications, an actual agent
reply, and restart with the service require separate evidence. No installation,
publication, or live phone acceptance is claimed by this source change.
