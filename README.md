# Google Sheets ↔ Notion Sync

This project syncs campaigns and ad sets from Google Sheets to Notion every 6 hours using GitHub Actions.

## Setup

1. Clone repo
2. Add a `.env` file using `.env.example` as template
3. Place your Google Service Account key as `google-service-account.json`
4. Run:
   ```bash
   npm install
   npm run build
   ```

## Deploy with GitHub Actions

Set the following repository secrets in GitHub:
- `NOTION_API_KEY`
- `NOTION_CAMPAIGN_DB`
- `NOTION_ADSET_DB`
- `SHEET_ID`

Push to `main` and the sync will run every 6 hours.
