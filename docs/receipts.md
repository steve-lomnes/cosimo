# Receipts

Photograph a receipt when you pay, before the charge reaches your bank feed. Cosimo keeps it in the
receipt inbox and attaches it to the bank transaction when that transaction arrives, usually a few days
later once the charge posts. The receipt's account, contact and memo then become the suggestion for that
transaction in Categorize. Receipts for cash or a personal card, which never reach a bank feed, can be
booked as a bill or a journal entry instead.

## Capture a receipt

- **In Cosimo.** On a phone, tap **Snap receipt** in the header. On a computer, use the button on the
  dashboard or **Banking → Receipts**. Take a photo or pick a file, then fill in what you know. Only
  the photo or the amount is required.
- **From the share sheet on an iPhone.** Set up the Shortcut below once. After that, share a photo to
  **Send to Cosimo** from Photos or the camera and it lands in the inbox.
- **With an AI assistant.** Connect an assistant ([docs/mcp.md](mcp.md)) and ask it to "fill in my new
  receipts". It reads each photo in the inbox and fills in the merchant, date, amount, tip and the
  rest. If you share a photo with the assistant in chat instead, it can create the receipt from what it
  reads. It can't pass the photo itself on to Cosimo, so it gives you a link to add the photo.

iPhone photos in HEIC format are converted to JPEG when they are uploaded, so browsers and assistants
can show them.

## How matching works

- **What counts as a match.** A receipt matches a charge on or up to one day before the receipt's date,
  or up to seven days after it.
  - Most matches are on the **amount charged**, tip included.
  - If you entered a tip, the charge can also be the pre-tip total plus a tip of up to 35%, as long as
    the merchant's name appears in the bank's description. This covers a receipt photographed before
    the tip was written in.
- **Matched automatically.** When the pairing is unique on both sides, the amount is exact, and either
  the merchant's name appears in the bank's description or the receipt says which card paid,
  Cosimo matches the receipt on its own. The photo is attached to the transaction.
- **Possible match.** Otherwise the receipt shows as a possible match. Confirm it in Categorize or on
  the Receipts page. Categorizing the transaction also confirms it. **Not this receipt** turns the
  pairing down for good.
- **Categorizing.** When the transaction is categorized, the photo is also attached to the journal
  entry.

Receipts are not ledger entries, so capturing, editing, matching and dismissing one take effect right
away and are recorded in the audit log. Categorizing the transaction goes through the review queue
as usual.

## iPhone: share to Cosimo with a Shortcut

The Shortcut sends a photo straight to your receipt inbox with an API token. Set it up once on each
phone.

### 1. Create a token

1. In Cosimo, open **Account → Personal API tokens**.
2. Choose the organization the receipts belong to and the role **Bookkeeper**.
3. Tick **Propose only**. Receipts still apply directly, but anything that would change the books waits
   for your approval. This limits what someone could do with a token copied off the phone.
4. Copy the token. It is shown only once.

You also need the organization's ID. It is the part after `/o/` in the address bar when you're signed
in, for example `https://books.example.com/o/01J9ZK3M8Q.../dashboard`.

### 2. Build the Shortcut

In the **Shortcuts** app, tap **+** to make a new shortcut and name it **Send to Cosimo**. Then:

1. **Accept photos from the share sheet.** Open the shortcut's details (the **ⓘ** button, or the name
   at the top in newer iOS versions), turn on **Show in Share Sheet**, and set it to receive **Images**
   and **PDFs**.
2. **Optional: convert to JPEG on the phone.** Add **Convert Image**, set to convert **Shortcut Input**
   to **JPEG**. Cosimo converts HEIC itself, but converting on the phone makes uploads faster and spares
   a small server.
3. **Send the photo.** Add **Get Contents of URL** and set:
   - **URL:** `https://books.example.com/api/v1/orgs/<organization ID>/receipts`
   - **Method:** `POST`
   - **Headers:** add `Authorization` with the value `Bearer <your token>`
   - **Request Body:** `Form`. Add a field of type **File** with the key `file` and the value **Converted
     Image**, or **Shortcut Input** if you skipped step 2.
4. **Optional: open the receipt to add details now.** Add **Get Dictionary Value**, getting the value
   for `id` from **Contents of URL**. Then add **Open URLs** with
   `https://books.example.com/o/<organization ID>/banking/receipts/` followed by **Dictionary Value**.
   Without this step the receipt waits in the inbox, where you or an assistant can fill it in later.
5. **Optional: confirm it worked.** Add **Show Notification** with "Receipt sent to Cosimo".

Replace `https://books.example.com` with your Cosimo address.

### 3. Use it

In Photos, or right after taking a picture, tap **Share** and then **Send to Cosimo**. The receipt
appears under **Banking → Receipts → Inbox**. To fill in its details, open it in Cosimo, or ask your
assistant to "fill in my new receipts".

### Adding details from the Shortcut

The receipts endpoint also takes the receipt's fields as form fields next to `file`. To be asked for the
amount each time, add these before **Get Contents of URL**:
- **Ask for Input**, of type **Number**, with the prompt "Amount charged, tip included".
- **Calculate**, multiplying **Provided Input** by 100.
- **Round Number**.

Then add a **Text** form field named `amount` with **Rounded Number**. Amounts are sent in cents, so
$8.69 becomes 869. The other fields are
`merchant`, `receipt_date` (`YYYY-MM-DD`), `tip_amount` (cents), `business_purpose` and `attendees`.

### Troubleshooting

| What you see | What to check |
|---|---|
| `401` | The token is wrong or revoked, or the header isn't exactly `Bearer <token>`. |
| `403` | The token's role is Accountant or Viewer. Create one with Bookkeeper. |
| `404` | The organization ID in the URL is wrong. |
| `422 too_large` ("Files are limited to 20 MB") | The file is too big. Add the **Convert Image** step, which also shrinks it. |
| `422 heic_unsupported` | The photo couldn't be converted. Add the **Convert Image** step to send JPEG. |
