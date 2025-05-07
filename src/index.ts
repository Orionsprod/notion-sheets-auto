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
  
  // Get the client and explicitly cast it as OAuth2Client
  const authClient = await auth.getClient();
  
  // Create the sheets client directly with the auth client
  return google.sheets({ 
    version: 'v4', 
    auth: authClient 
  });
}

// Rest of your code remains the same
async function getColumnData(sheetName: string, spreadsheetId: string): Promise<string[]> {
  const sheets = await getSheetsClient();
  const range = `${sheetName}!A:A`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = response.data.values || [];
  return values.flat().filter((v, i, a) => v && a.indexOf(v) === i);
}

async function getNotionEntries(databaseId: string, propertyName: string): Promise<Set<string>> {
  const entries = new Set<string>();
  let cursor = undefined;
  do {
    const response = await notion.databases.query({ database_id: databaseId, start_cursor: cursor });
    response.results.forEach((page: any) => {
      const title = page.properties[propertyName]?.title?.[0]?.plain_text;
      if (title) entries.add(title);
    });
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return entries;
}

async function syncToNotion(sheetValues: string[], notionDBId: string, notionProp: string) {
  const existing = await getNotionEntries(notionDBId, notionProp);
  for (const value of sheetValues) {
    if (!existing.has(value)) {
      await notion.pages.create({
        parent: { database_id: notionDBId },
        properties: {
          [notionProp]: { title: [{ text: { content: value } }] }
        }
      });
      console.log(`Added "${value}" to Notion DB`);
    }
  }
}

async function main() {
  const spreadsheetId = process.env.SHEET_ID!;
  const campaignValues = await getColumnData('ad-account/insights/unique_campaigns', spreadsheetId);
  const adsetValues = await getColumnData('ad-account/insights/unique_adsets', spreadsheetId);
  await syncToNotion(campaignValues, process.env.NOTION_CAMPAIGN_DB!, 'Name');
  await syncToNotion(adsetValues, process.env.NOTION_ADSET_DB!, 'Name');
}

main().catch(console.error);
