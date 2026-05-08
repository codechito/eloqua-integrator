# TransmitSMS for Eloqua — Setup Guide

## Step 1: Install the App

Click the link below while logged into Eloqua as an **Administrator**:

**https://login.eloqua.com/Apps/Cloud/Admin/Catalog/Add/9dcf2c22-1c87-4fb2-8215-f846fb16b26a/84-72-07-13-67-68-36-AB-C7-73-22-87-7D-EF-58-BC**

1. Click **Install** on the catalog page.
2. You will be prompted to authorize the app — click **Accept** to grant access.
3. After authorization, you will land on the **App Configuration** page.

---

## Step 2: Configure the App

On the configuration page, you will need your **Burst SMS API credentials**.
Find them at: https://burst.transmitsms.com/profile

| Field | Description |
|---|---|
| Burst SMS API Key | Your API Key from your Burst SMS profile |
| Burst SMS API Secret | Your API Secret from your Burst SMS profile |
| Default Country | Used to format phone numbers when a contact has no country set |
| SMS Rate Limit | Maximum SMS messages per second (default: 10) |

Click **Update** to save.

---

## Step 3: Map Custom Objects (Optional)

If you want SMS activity recorded in Eloqua Custom Objects:

1. Select an **Action Type** (Send SMS, Received SMS, Incoming SMS, or SMS Link Hit).
2. Search and select a **Custom Object** from your Eloqua instance.
3. Map the custom object fields to the corresponding SMS data (mobile number, message, virtual number, etc.).
4. Click **Update** to save.

---

## Step 4: Using the Services in Campaigns

### Send SMS

1. Open a Campaign in the **Campaign Canvas**.
2. Drag a **Cloud Action** element onto the canvas.
3. Click the element and select **TransmitSMS — Send SMS**.
4. Click **Open Editor** and configure:
   - **From** — select your Burst SMS virtual number.
   - **Message** — type your SMS. Use merge fields for personalisation (e.g. `{{Contact.FirstName}}`).
   - **Mobile Field** — select which contact field holds the mobile number.
5. Save and activate the campaign.

### Receive SMS (Decision)

1. Add a **Cloud Decision** element to the Campaign Canvas.
2. Select **TransmitSMS — Receive SMS**.
3. Set the **virtual number** to monitor for replies.
4. The step branches contacts into two paths:
   - **Yes** — contact replied.
   - **No** — no reply received.

### SMS Link Hits (Feeder)

1. Add a **Cloud Feeder** element to the Campaign Canvas.
2. Select **TransmitSMS — SMS Link Hit**.
3. Contacts who click a tracked link inside an SMS are automatically moved into the next campaign step.

---

## Need Help?

Contact support at: https://github.com/codechito/eloqua-integrator/issues
