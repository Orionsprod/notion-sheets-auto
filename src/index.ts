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

async function addRelations(sheetName: string, spreadsheetId: string, range: string, parentMap: Map<string, string>, childMap: Map<string, string>, parentDBId: string, parentProp: string, childPropId: string) {
  const rows = await getColumnData(sheetName, spreadsheetId, range);
  for (const [childName, parentName] of rows) {
    const parentId = parentMap.get(parentName);
    const childId = childMap.get(childName);
    if (parentId && childId) {
      await notion.pages.update({
        page_id: parentId,
        properties: {
          [childPropId]: { relation: [{ id: childId }] }
        }
      });
      console.log(`Linked ${childName} to ${parentName}`);
    }
  }
}

async function main() {
  const spreadsheetId = process.env.SHEET_ID!;

  // Sync Campaigns
  const campaignValues = (await getColumnData('ad-account/insights/unique_campaigns', spreadsheetId, 'A:A')).flat();
  const campaignMap = await getNotionEntriesMap(process.env.NOTION_CAMPAIGN_DB!, 'Name');
  await createNotionPages(campaignValues, process.env.NOTION_CAMPAIGN_DB!, 'Name', campaignMap);

  // Sync Adsets
  const adsetValues = (await getColumnData('ad-account/insights/unique_adsets', spreadsheetId, 'A:A')).flat();
  const adsetMap = await getNotionEntriesMap(process.env.NOTION_ADSET_DB!, 'Name');
  await createNotionPages(adsetValues, process.env.NOTION_ADSET_DB!, 'Name', adsetMap);

  // Sync Accounts
  const accountValues = (await getColumnData('ad-account_name', spreadsheetId, 'D:D')).flat();
  const accountMap = await getNotionEntriesMap(process.env.NOTION_ACCOUNT_DB!, 'Name');
  await createNotionPages(accountValues, process.env.NOTION_ACCOUNT_DB!, 'Name', accountMap);

  // Relate Adsets to Campaigns
  await addRelations(
    'ad-account/insights/unique_campaigs_adsets',
    spreadsheetId,
    'A:B',
    campaignMap,
    adsetMap,
    process.env.NOTION_CAMPAIGN_DB!,
    'Name',
    'Adsets'
  );

  // Relate Campaigns to Accounts
  await addRelations(
    'ad-account_name',
    spreadsheetId,
    'A:B',
    campaignMap,
    accountMap,
    process.env.NOTION_CAMPAIGN_DB!,
    'Name',
    'Account'
  );
}

main().catch(console.error);
