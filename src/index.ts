import { google } from 'googleapis';
import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
dotenv.config();

const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function getSheetsClient() {
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY!;
  const jsonCredentials = JSON.parse(Buffer.from(rawKey, 'base64').toString('utf8'));

  const auth = new google.auth.GoogleAuth({
    credentials: jsonCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient as any });
}

async function getColumnData(sheetName: string, spreadsheetId: string, range: string): Promise<string[][]> {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!${range}` });
  return response.data.values || [];
}

async function getNotionEntriesMap(databaseId: string, propertyName: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  let cursor = undefined;
  do {
    const response = await notion.databases.query({ database_id: databaseId, start_cursor: cursor });
    response.results.forEach((page: any) => {
      const title = page.properties[propertyName]?.title?.[0]?.plain_text;
      if (title) entries.set(title, page.id);
    });
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return entries;
}

async function createNotionPages(values: string[], databaseId: string, prop: string, existing: Map<string, string>) {
  for (const value of values) {
    if (!existing.has(value)) {
      const page = await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          [prop]: { title: [{ text: { content: value } }] }
        }
      });
      console.log(`Added "${value}" to DB ${databaseId}`);
      existing.set(value, page.id);
    }
  }
}

async function getAdsetCampaignPairsFromNotion(adsetDBId: string): Promise<Set<string>> {
  const pairs = new Set<string>();
  let cursor = undefined;
  do {
    const response = await notion.databases.query({ database_id: adsetDBId, start_cursor: cursor });
    response.results.forEach((page: any) => {
      const name = page.properties['Name']?.title?.[0]?.plain_text;
      const campaignIds: string[] = page.properties['Campaign']?.relation?.map((rel: { id: string }) => rel.id) || [];
      campaignIds.forEach((campaignId: string) => {
        if (name && campaignId) {
          pairs.add(`${name}:::${campaignId}`);
        }
      });
    });
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return pairs;
}

async function createAdsetPerCampaign(sheetName: string, spreadsheetId: string, adsetDBId: string, campaignDBId: string) {
  const rows = await getColumnData(sheetName, spreadsheetId, 'A:B');
  const campaignMap = await getNotionEntriesMap(campaignDBId, 'Name');
  const existingPairs = await getAdsetCampaignPairsFromNotion(adsetDBId);

  for (const [adsetName, campaignName] of rows) {
    if (!adsetName || !campaignName) continue;
    const campaignId = campaignMap.get(campaignName);
    if (!campaignId) continue;
    const pairKey = `${adsetName}:::${campaignId}`;
    if (existingPairs.has(pairKey)) continue;

    await notion.pages.create({
      parent: { database_id: adsetDBId },
      properties: {
        'Name': { title: [{ text: { content: adsetName } }] },
        'Campaign': { relation: [{ id: campaignId }] },
      }
    });
    console.log(`Created adset '${adsetName}' linked to campaign '${campaignName}'`);
  }
}

async function relateCampaignsToAccounts(sheetName: string, spreadsheetId: string, campaignDBId: string, accountDBId: string) {
  const rows = await getColumnData(sheetName, spreadsheetId, 'A:B');
  const campaignMap = await getNotionEntriesMap(campaignDBId, 'Name');
  const accountMap = await getNotionEntriesMap(accountDBId, 'Name');

  for (const [campaignName, accountName] of rows) {
    const campaignId = campaignMap.get(campaignName);
    const accountId = accountMap.get(accountName);
    if (!campaignId || !accountId) continue;

    await notion.pages.update({
      page_id: campaignId,
      properties: {
        'Account': { relation: [{ id: accountId }] },
      }
    });
    console.log(`Linked campaign '${campaignName}' to account '${accountName}'`);

    await notion.pages.update({
      page_id: accountId,
      properties: {
        'Campaigns': { relation: [{ id: campaignId }] },
      }
    });
    console.log(`Linked account '${accountName}' to campaign '${campaignName}'`);
  }
}

async function main() {
  const spreadsheetId = process.env.SHEET_ID!;

  // Sync Campaigns
  const campaignValues = (await getColumnData('ad-account/insights/unique_campaigns', spreadsheetId, 'A:A')).flat();
  const campaignMap = await getNotionEntriesMap(process.env.NOTION_CAMPAIGN_DB!, 'Name');
  await createNotionPages(campaignValues, process.env.NOTION_CAMPAIGN_DB!, 'Name', campaignMap);

  // Sync Accounts
  const accountValues = (await getColumnData('ad-account_name', spreadsheetId, 'D:D')).flat();
  const accountMap = await getNotionEntriesMap(process.env.NOTION_ACCOUNT_DB!, 'Name');
  await createNotionPages(accountValues, process.env.NOTION_ACCOUNT_DB!, 'Name', accountMap);

  // Relate Campaigns to Accounts (bidirectional), using correct sheet
  await relateCampaignsToAccounts(
    'ad-account/insights/unique_campaigns_accounts',
    spreadsheetId,
    process.env.NOTION_CAMPAIGN_DB!,
    process.env.NOTION_ACCOUNT_DB!
  );

  // Create Adsets with duplicates per campaign only if not already linked
  await createAdsetPerCampaign(
    'ad-account/insights/unique_campaigs_adsets',
    spreadsheetId,
    process.env.NOTION_ADSET_DB!,
    process.env.NOTION_CAMPAIGN_DB!
  );
}

main().catch(console.error);
