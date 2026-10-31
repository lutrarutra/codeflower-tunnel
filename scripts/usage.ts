// Reads the hosted tunnel's Durable Object usage from Cloudflare's GraphQL
// analytics and estimates what it costs (docs/costs.md). Usage:
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npm run usage -- [options]
//     --since <time>   start of the window (ISO 8601; default: 24 hours ago)
//     --until <time>   end of the window (default: now)
//     --used <hours>   how long the tunnel was in use during the window (default: the window)
//     --hours <hours>  remote use per user per month, to extrapolate (default: 44)
// The token needs Account Analytics: Read and Workers Scripts: Read. Analytics
// lag a few minutes behind.
import { parseArgs } from 'node:util';

// Workers Paid, October 2026: https://developers.cloudflare.com/durable-objects/platform/pricing/
const PER_MILLION_REQUESTS = 0.15;
const PER_MILLION_GB_S = 12.5;
const INCLUDED_REQUESTS = 1_000_000;
const INCLUDED_GB_S = 400_000;
const MESSAGES_PER_REQUEST = 20;
const OBJECT_GB = 0.125;

const SCRIPT = 'codeflower-tunnel';
const CLASS = 'ConnectorHub';

const { values } = parseArgs({
  options: { since: { type: 'string' }, until: { type: 'string' }, used: { type: 'string' }, hours: { type: 'string' } }
});
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics: Read, Workers Scripts: Read).');
  process.exit(1);
}
const until = values.until ? new Date(values.until) : new Date();
const since = values.since ? new Date(values.since) : new Date(until.getTime() - 24 * 3600_000);
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
  console.error('--since and --until must be ISO 8601 times, --since first.');
  process.exit(1);
}
const windowHours = (until.getTime() - since.getTime()) / 3600_000;
const usedHours = values.used ? Number(values.used) : windowHours;
const monthHours = values.hours ? Number(values.hours) : 44;

async function cloudflare<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  });
  const body = (await response.json()) as { result?: T; data?: T; errors?: { message: string }[] | null };
  if (!response.ok || body.errors?.length) {
    throw new Error(`${path}: ${body.errors?.map((error) => error.message).join('; ') || response.status}`);
  }
  return (body.result ?? body.data) as T;
}

const namespaces = await cloudflare<{ id: string; script: string; class: string }[]>(
  `/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`
);
const namespace = namespaces.find((candidate) => candidate.script === SCRIPT && candidate.class === CLASS);
if (!namespace) {
  console.error(`No ${CLASS} namespace of the ${SCRIPT} Worker in this account.`);
  process.exit(1);
}

// `activeTime` is in microseconds. With hibernation, incoming WebSocket
// messages may be counted in `requests` instead of `inboundWebsocketMsgCount`.
const query = `query ($account: String!, $namespace: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: {accountTag: $account}) {
      invocations: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {namespaceId: $namespace, datetime_geq: $since, datetime_leq: $until}) {
        sum { requests }
      }
      periodic: durableObjectsPeriodicGroups(limit: 10000, filter: {namespaceId: $namespace, datetimeMinute_geq: $since, datetimeMinute_leq: $until}) {
        sum { activeTime inboundWebsocketMsgCount }
      }
    }
  }
}`;
type Groups<T> = { sum: T }[];
const data = await cloudflare<{
  viewer: {
    accounts: {
      invocations: Groups<{ requests: number }>;
      periodic: Groups<{ activeTime: number; inboundWebsocketMsgCount: number }>;
    }[];
  };
}>('/graphql', {
  method: 'POST',
  body: JSON.stringify({ query, variables: { account, namespace: namespace.id, since: since.toISOString(), until: until.toISOString() } })
});
const [usage] = data.viewer.accounts;
const total = <T>(groups: Groups<T> | undefined, field: keyof T) =>
  (groups ?? []).reduce((sum, group) => sum + Number(group.sum[field] ?? 0), 0);
const requests = total(usage?.invocations, 'requests');
const messages = total(usage?.periodic, 'inboundWebsocketMsgCount');
const activeSeconds = total(usage?.periodic, 'activeTime') / 1e6;

const billedRequests = requests + Math.ceil(messages / MESSAGES_PER_REQUEST);
const gbSeconds = activeSeconds * OBJECT_GB;
const requestCost = (billedRequests * PER_MILLION_REQUESTS) / 1e6;
const durationCost = (gbSeconds * PER_MILLION_GB_S) / 1e6;
const perMonth = monthHours / usedHours;

const number = (value: number) => Math.round(value).toLocaleString('en');
const dollars = (value: number) => `$${value < 0.01 ? value.toFixed(5) : value.toFixed(2)}`;
console.log(`${since.toISOString()} to ${until.toISOString()} (${windowHours.toFixed(1)} h, ${usedHours} h in use)`);
const row = (label: string, value: string) => console.log(`  ${label.padEnd(58)} ${value}`);
row('requests (connections, HTTP, messages under hibernation)', number(requests));
row(`incoming WebSocket messages, billed 1 in ${MESSAGES_PER_REQUEST}`, number(messages));
row('awake', `${activeSeconds.toFixed(0)} s = ${number(gbSeconds)} GB-s`);
row('cost beyond the included amounts', `${dollars(requestCost)} requests + ${dollars(durationCost)} duration`);
console.log(`A user with ${monthHours} h of remote use a month, at this rate:`);
console.log(`  ${number(billedRequests * perMonth)} requests, ${number(gbSeconds * perMonth)} GB-s: ${dollars((requestCost + durationCost) * perMonth)} a month`);
const users = Math.min(INCLUDED_REQUESTS / (billedRequests * perMonth), INCLUDED_GB_S / (gbSeconds * perMonth));
if (Number.isFinite(users)) console.log(`  the plan's included amounts cover about ${number(users)} such users`);
