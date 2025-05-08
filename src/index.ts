
import { google } from 'googleapis';
import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
dotenv.config();

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Set your icon URLs
const ICONS = {
  campaign: "https://em-content.zobj.net/source/apple/419/sparkle_2747-fe0f.png",
  adset: "https://em-content.zobj.net/source/apple/419/eight-spoked-asterisk_2733-fe0f.png",
  account: "https://em-content.zobj.net/source/apple/419/gem-stone_1f48e.png"
};

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
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = response.data.values || [];
  return values.slice(1); // Skip header
}

async function getNotionEntriesMap(databaseId: string, propertyName: string): Promise<Map<string, string>> {
  const map = new Map();
  let cursor = undefined;

  do {
    const response = await notion.databases.query({ database_id: databaseId, start_cursor: cursor });
    for (const page of response.results) {
      const title = page.properties[propertyName]?.title?.[0]?.plain_text;
      if (title) map.set(title, page.id);
    }
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return map;
}

async function createNotionPages(values: string[], databaseId: string, propertyName: string, iconUrl: string) {
  const existing = await getNotionEntriesMap(databaseId, propertyName);
  for (const value of values) {
    if (!value || existing.has(value)) continue;
    await notion.pages.create({
      parent: { database_id: databaseId },
      icon: { type: 'external', external: { url: iconUrl } },
      properties: {
        [propertyName]: { title: [{ text: { content: value } }] }
      }
    });
    console.log(`Added "${value}" to Notion DB`);
  }
}

async function createAdsetsPerCampaign(sheetName: string, spreadsheetId: string, adsetDBId: string, campaignDBId: string) {
  const rows = await getColumnData(sheetName, spreadsheetId, 'A:B');
  const campaignMap = await getNotionEntriesMap(campaignDBId, 'Name');

  for (const [adsetName, campaignName] of rows) {
    const campaignId = campaignMap.get(campaignName);
    if (!adsetName || !campaignId) continue;

    await notion.pages.create({
      parent: { database_id: adsetDBId },
      icon: { type: 'external', external: { url: ICONS.adset } },
      properties: {
        'Name': { title: [{ text: { content: adsetName } }] },
        'Campaign': { relation: [{ id: campaignId }] }
      }
    });

    console.log(`Created adset "${adsetName}" linked to campaign "${campaignName}"`);
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

    // Link campaign -> account
    await notion.pages.update({
      page_id: campaignId,
      properties: {
        'Account': { relation: [{ id: accountId }] },
      }
    });
    console.log(`Linked campaign '${campaignName}' to account '${accountName}'`);

    // Link account -> campaigns (append)
    const accountPage = await notion.pages.retrieve({ page_id: accountId });
    if (!('properties' in accountPage) || accountPage.object !== 'page') continue;
    const campaignProp = accountPage.properties['Campaigns'];
    const currentCampaigns = campaignProp && campaignProp.type === 'relation'
      ? campaignProp.relation.map((r: any) => r.id)
      : [];

    if (!currentCampaigns.includes(campaignId)) {
      const updatedCampaigns = [...currentCampaigns, campaignId];
      await notion.pages.update({
        page_id: accountId,
        properties: {
          'Campaigns': {
            relation: updatedCampaigns.map(id => ({ id }))
          }
        }
      });
      console.log(`Appended campaign '${campaignName}' to account '${accountName}'`);
    }
  }
}

async function main() {
  const spreadsheetId = process.env.SHEET_ID!;

  // Sync campaigns
  const campaignRaw = await getColumnData('ad-account/insights/unique_campaigns', spreadsheetId, 'A:A');
  const campaignValues = campaignRaw.map(([v]) => v);
  await createNotionPages(campaignValues, process.env.NOTION_CAMPAIGN_DB!, 'Name', ICONS.campaign);

  // Sync adsets (per campaign)
  await createAdsetsPerCampaign('ad-account/insights/unique_campaigs_adsets', spreadsheetId, process.env.NOTION_ADSET_DB!, process.env.NOTION_CAMPAIGN_DB!);

  // Sync accounts
  const accountRaw = await getColumnData('ad-account_name', spreadsheetId, 'D:D');
  const accountValues = accountRaw.map(([v]) => v);
  await createNotionPages(accountValues, process.env.NOTION_ACCOUNT_DB!, 'Name', ICONS.account);

  // Link campaigns to accounts (and accounts to campaigns)
  await relateCampaignsToAccounts('ad-account/insights/unique_campaigns_accounts', spreadsheetId, process.env.NOTION_CAMPAIGN_DB!, process.env.NOTION_ACCOUNT_DB!);
}

main().catch(console.error);
