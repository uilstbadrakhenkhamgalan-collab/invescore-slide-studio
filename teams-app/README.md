# How to Install Slide Studio in Microsoft Teams

## Method 1: Personal Sideload (for yourself)

1. Open Microsoft Teams
2. Click **Apps** in the left sidebar
3. Click **Manage your apps** at the bottom
4. Click **Upload an app** → **Upload a custom app**
5. Select `slide-studio-teams.zip`
6. Click **Add** when prompted
7. Slide Studio now appears in your left sidebar

## Method 2: Organization-wide (requires IT admin)

1. Go to [Microsoft Teams Admin Center](https://admin.teams.microsoft.com)
2. Navigate to **Teams apps** → **Manage apps**
3. Click **Upload new app**
4. Select `slide-studio-teams.zip`
5. The app will appear in the org's app catalog
6. Set up an **App Setup Policy** to pin it for all InvesCore employees

## Troubleshooting

- **If "Upload a custom app" is grayed out:** your Teams admin has disabled sideloading. Ask IT to enable it in Teams Admin Center → Teams apps → Permission policies → Org-wide app settings → toggle "Allow interaction with custom apps"
- **If the app shows a blank screen:** check that `invescore-slide-studio.vercel.app` is accessible from your network
- The app loads the same website as the browser version. Any updates to the website are reflected instantly in Teams.
