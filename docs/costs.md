# Costs and Cloudflare terms

What the hosted tunnel costs to run on Cloudflare, and whether Cloudflare's terms allow it.
Prices and terms as of October 2026; check the current pages before relying on them. This is
not legal advice.

## Costs

Workers and Durable Objects charge **nothing for bandwidth or egress**. They charge for
messages and for the time a Durable Object is awake
([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)):

| What | Price | For the tunnel |
| --- | --- | --- |
| Incoming WebSocket messages | 20 messages count as one request: $0.15 per million requests beyond 1 million a month | each frame is billed once, when it arrives; what the Durable Object sends is free |
| Duration | $12.50 per million GB-s beyond 400,000 GB-s a month, at 128 MB per object | only while the object is awake |
| A hibernated object | free | idle connectors |
| Workers Paid plan | $5 a month minimum | |

Rough figures:

- **A 1 GB upload**: about 17,500 frames of 60 kB, billed as about 900 requests: about $0.0001.
- **1 TB in a month**: about 900,000 requests: about $0.15, plus duration.
- **An active user, 4 hours a day**: about 54,000 GB-s a month, about $0.70, less if the
  object sleeps between bursts.
- **An idle connector**: nothing. The Durable Object accepts sockets with the hibernation API
  (`ctx.acceptWebSocket` in `src/worker.ts`), and the connector's `ping` every 30 s is answered by
  `setWebSocketAutoResponse` without waking the object. Any keepalive that did wake it would cost
  about $4 a month per connector, so check the duration figures in the dashboard after a deploy
  that changes the sockets.

Costs grow with the number of messages, not their size, so larger frames would be cheaper still.
At these figures that does not matter. D1 (accounts) and the Worker requests that open sockets
are small next to the above.

## Per user

An estimate until it is measured. Assumed: an average user uses remote access 2 hours a day on
22 days (44 hours a month). While in use, about 5 WebSocket messages a second flow, mostly the
agent's streamed replies. There are 3 page loads a day of about 20 streams each, since every HTTP
request through the tunnel is a stream of its own, and 2 GB of uploads.

| Item | A month | Billed | Cost |
| --- | --- | --- | --- |
| Messages in use | 44 h × 18,000/h ≈ 800,000 | 40,000 requests | $0.006 |
| Opening sockets (pages, chats, reconnects) | about 6,000 | 6,000 requests | $0.001 |
| Uploads (2 GB) | about 35,000 frames | 1,800 requests | under $0.001 |
| Connector `ping` while idle | 86,000 | free if the automatic reply is not billed, else 4,300 requests | at most $0.001 |
| Duration, if billed only while handling messages | about 200 GB-s | | $0.003 |
| Duration, if awake all 44 hours | about 20,000 GB-s | | $0.25 |

So **$0.01 to $0.25 a user a month**, and about $1.50 for a heavy user (8 hours every day, 10
messages a second). The open question is duration: idle objects that could hibernate are not
billed, but a busy chat sends a message every few hundred milliseconds and may keep the object
counted as awake. The payment provider's fee (typically 5% plus $0.50 a transaction) will be larger
than either.

The $5 Workers Paid plan includes 1 million requests (about 20 such users) and 400,000 GB-s
(20 to 2,000 users), so the first users cost nothing beyond the plan.

## Measuring

`npm run usage` reads the tunnel's Durable Object usage from Cloudflare's GraphQL analytics and
prints its cost, and what a user would cost a month at that rate. It needs an API token with
Account Analytics: Read and Workers Scripts: Read:

```sh
export CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=…
npm run usage                                         # the last 24 hours
npm run usage -- --since 2026-11-03T14:00Z --until 2026-11-03T15:00Z --hours 44
```

To replace the estimate above, use the tunnel alone for one hour, the way a user would: a chat
with an agent, some terminal, an upload. Wait a few minutes for the analytics, then run it with
`--since` and `--until` around that hour. `--used` says how many hours of the window were actual
use, if fewer. Write the result here.

Two caveats: the analytics fields are not all documented (`activeTime` is taken as microseconds),
and under hibernation Cloudflare may count incoming messages as requests instead of messages,
which overstates requests up to twentyfold. Compare a first run with the Durable Objects page of
the billing dashboard.

Self-hosted, the server's ordinary traffic charges apply instead, and the operator pays for each
byte twice: in from one end, out to the other.

## Cloudflare's terms

- **Relays, proxies and tunnels are not prohibited** in the
  [Developer Platform terms](https://www.cloudflare.com/service-specific-terms-developer-platform/).
  They prohibit volumetric attacks, phishing and storing illegal content, require following the
  developer documentation, and say Cloudflare "may temporarily limit … the number of requests you
  can make or receive".
- **The old rule against non-HTML content (section 2.8) is gone.** Its successor, a limit on video
  and large files, applies only to the CDN, i.e. cached website traffic, and names the Developer
  Platform as the way to serve such content
  ([announcement](https://blog.cloudflare.com/updated-tos/),
  [video delivery](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)).
  Tunnel traffic runs through Workers and Durable Objects, not the cache.
- **"You are solely responsible for the acts of your End Users."** If customers misuse the tunnel,
  Cloudflare holds this account responsible. The abuse controls in [abuse.md](abuse.md) protect the
  service itself, and the terms of service pass the rules on to users in an acceptable use
  policy.
- Once traffic grows, tell Cloudflare sales what the service does rather than wait for an
  automatic limit. Cloudflare sells its own Cloudflare Tunnel; that is competition, not a terms
  problem.
