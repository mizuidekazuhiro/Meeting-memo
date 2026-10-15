// One incident only. No transcription, AI requests, task creation, or email.
import assert from 'node:assert/strict';

const originalPage = '38adec27-c9aa-81e9-bfba-e8ae63d8af70';
const gikenPage = '3fadec27-c9aa-8179-b8a6-f53e1152f8c1';
const backupPage = '3fadec27-c9aa-81b8-9a1c-fc97b32901bf';
const oldId = 'id:jb_wTME9uNwAAAAAAAAAUw';
const newId = 'id:jb_wTME9uNwAAAAAAAAAuw';
const oldRecording = `${oldId}:2026-06-25-14_54_23.m4a`;
const newRecording = `${newId}:2026-10-15-11_02_59.m4a`;
const namespace = 'a6760676704e4a1fac83ddff1b16222d';
const receiptKey = 'recordingJob:recovery:20261015-identity:receipt';
const env = process.env;
for (const name of ['NOTION_TOKEN', 'INBOX_DB_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) assert.ok(env[name], `Missing ${name}`);

async function notion(path, method = 'GET', body) {
  const r = await fetch(`https://api.notion.com/v1${path}`, { method, headers: {
    authorization: `Bearer ${env.NOTION_TOKEN}`, 'notion-version': '2022-06-28', 'content-type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new Error(`Notion ${method} failed: ${r.status}`);
  return r.json();
}

async function kv(key, value) {
  const writing = value !== undefined;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`, {
    method: writing ? 'PUT' : 'GET', headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(writing ? { 'content-type': 'text/plain' } : {}) },
    ...(writing ? { body: JSON.stringify(value) } : {}),
  });
  if (!writing && r.status === 404) return null;
  if (!r.ok) throw new Error(`KV ${writing ? 'write' : 'read'} failed: ${r.status}`);
  return r.json();
}

const text = prop => prop?.rich_text?.map(x => x.plain_text ?? x.text?.content ?? '').join('') ?? '';
const rt = value => ({ rich_text: Array.from({ length: Math.ceil(value.length / 1900) }, (_, i) => ({ type: 'text', text: { content: value.slice(i * 1900, (i + 1) * 1900) } })) });
const key = id => `dropbox:id:${id}`;
const jobKey = id => `recordingJob:recordingId:${id}`;
const idOnly = id => id.replaceAll('-', '');

const [original, giken, backup, job, oldJob, receipt] = await Promise.all([
  notion(`/pages/${originalPage}`), notion(`/pages/${gikenPage}`), notion(`/pages/${backupPage}`),
  kv(jobKey(newRecording)), kv(jobKey(oldRecording)), kv(receiptKey),
]);
assert.equal(text(giken.properties['Dropbox File Id']), newId);
assert.equal(text(backup.properties['Dedup Key']), '');
assert.equal(text(backup.properties['Dropbox File Id']), '');
assert.equal(job?.recordingId, newRecording);
assert.equal(job?.dropboxFileId, newId);
assert.ok(['completed', 'persisted'].includes(job.status), 'Recording must be idle and finished before repair');
assert.ok([originalPage, gikenPage].some(id => idOnly(id) === idOnly(job.notionPageId ?? '')), 'Unexpected existing job destination');
assert.ok([oldId, newId].includes(text(original.properties['Dropbox File Id'])), 'Unexpected original page identity');
if (oldJob) {
  assert.equal(oldJob.recordingId, oldRecording);
  assert.equal(oldJob.dropboxFileId, oldId);
}

// Probe the actual API while the pre-repair identity is still available.
if (!receipt) {
  const probe = await notion(`/databases/${env.INBOX_DB_ID}/query`, 'POST', {
    filter: { property: 'Dedup Key', rich_text: { equals: key(oldId) } }, page_size: 100,
  });
  console.log(JSON.stringify({ probe: 'case-sensitive-file-id', returnedCount: probe.results.length,
    returnedCaseDifferentKey: probe.results.some(p => text(p.properties['Dedup Key']) !== key(oldId)) }));
  await kv('recordingJob:recovery:20261015-identity:before', {
    capturedAt: new Date().toISOString(), job, oldJob, originalProperties: original.properties, gikenProperties: giken.properties,
  });
}

// First redirect the finished job. The previous page stays intact until this succeeds.
const repairedJob = { ...job, notionPageId: gikenPage, notionPageUrl: `https://www.notion.so/${idOnly(gikenPage)}`, updatedAt: new Date().toISOString() };
await kv(jobKey(newRecording), repairedJob);
for (const name of ['recordingId', 'dropboxFileId', 'fileName', 'transcriptFileUrl', 'notificationSentAt', 'emailSentAt', 'status']) assert.equal(repairedJob[name], job[name]);

const gikenProps = { 'Dedup Key': rt(key(newId)) };
if (!receipt && text(original.properties['Dropbox File Id']) === newId) {
  for (const name of ['Summary', 'My Tasks', 'Other Tasks', 'Raw JSON', 'Speaker Separation']) {
    const prop = original.properties[name];
    if (prop?.type && prop[prop.type] !== undefined) gikenProps[name] = { [prop.type]: prop[prop.type] };
  }
}
await notion(`/pages/${gikenPage}`, 'PATCH', { properties: gikenProps });

const oldProps = {
  Name: { title: [{ type: 'text', text: { content: 'Interview Memo 2026-06-25 - 2026-06-25-14_54_23.m4a' } }] },
  'Dedup Key': rt(key(oldId)), 'Dropbox File Id': rt(oldId),
  'Interview Date': { date: { start: '2026-06-25T14:54:23+09:00' } },
  'Dropbox Link': { url: 'https://www.dropbox.com/scl/fi/vrohdl65o68rt9bgflkm9/2026-06-25-14_54_23-21da916c90306de8.txt?rlkey=0v4d1io0wnrofba6n1axlf7nh&dl=0' },
  'Raw JSON': rt(oldJob?.transcript ? JSON.stringify({ transcript: oldJob.transcript.raw, insights: oldJob.summaryInsights?.raw }) .slice(0, 1900) : ''),
  'My Tasks': rt('不明'), 'Other Tasks': rt('不明'),
};
if (oldJob?.summaryInsights) {
  oldProps['My Tasks'] = rt((oldJob.reviewResult?.myTasks?.length ? oldJob.reviewResult.myTasks : oldJob.summaryInsights.myTasks ?? []).map(x => `- ${x}`).join('\n') || '不明');
  oldProps['Other Tasks'] = rt((oldJob.summaryInsights.otherTasks ?? []).map(x => `- ${x}`).join('\n') || '不明');
}
await notion(`/pages/${originalPage}`, 'PATCH', { properties: oldProps });

const [checkedOld, checkedNew] = await Promise.all([notion(`/pages/${originalPage}`), notion(`/pages/${gikenPage}`)]);
assert.equal(text(checkedOld.properties['Dropbox File Id']), oldId);
assert.equal(text(checkedNew.properties['Dropbox File Id']), newId);
assert.equal(text(checkedOld.properties['Dedup Key']), key(oldId));
assert.equal(text(checkedNew.properties['Dedup Key']), key(newId));
if (env.RECOVERY_VERIFY_WRITER === 'true') {
  const { assertInterviewPageIdentity, findExistingInterview, writeFinalMemoToNotionPage } = await import('../.tmp-test/src/lib/notion.js');
  const apiEnv = { NOTION_TOKEN: env.NOTION_TOKEN, INBOX_DB_ID: env.INBOX_DB_ID };
  await assertInterviewPageIdentity(apiEnv, gikenPage, newId);
  assert.equal(idOnly((await findExistingInterview(apiEnv, [key(newId)]))?.id ?? ''), idOnly(gikenPage));
  assert.equal(idOnly((await findExistingInterview(apiEnv, [key(oldId)]))?.id ?? ''), idOnly(originalPage));
  const memo = job.reviewResult?.finalMemoMarkdown || job.summaryInsights?.summary;
  assert.ok(memo?.trim(), 'No saved Giken memo snapshot available for live writer verification');
  await writeFinalMemoToNotionPage(apiEnv, gikenPage, memo, job.reviewResult?.sourceUrls ?? []);
  console.log(JSON.stringify({ liveExactIdentityLookupVerified: true, liveMemoReplacementVerified: true }));
}
let checkedJob;
for (let attempt = 0; attempt < 18; attempt++) {
  checkedJob = await kv(jobKey(newRecording));
  if (idOnly(checkedJob?.notionPageId ?? '') === idOnly(gikenPage)) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
}
assert.equal(idOnly(checkedJob?.notionPageId ?? ''), idOnly(gikenPage), 'KV repair has not propagated');
const result = { completedAt: new Date().toISOString(), originalPage, gikenPage, backupPage, oldJobPresent: Boolean(oldJob), jobDestinationVerified: true };
await kv(receiptKey, result);
console.log(JSON.stringify(result));
