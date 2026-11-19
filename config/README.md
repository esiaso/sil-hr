# Hospital configuration (`config/site.json`)

Facts that differ from hospital to hospital, or that are still being confirmed, live in
one file instead of in code:

| Section | What it sets |
|---|---|
| `payroll` | pay day, proration, monthly hours, the bank and M-Pesa payment file layouts (and the M-Pesa method), the chart of accounts for the payroll journal |
| `medical` | medical schemes, cover categories and limits by job grade, staff contributions, from a date |
| `cpd_requirements` | CPD points a year per licensing body |
| `performance` | the appraisal rating bands and the low-rating flag |
| `mandatory_training` | the mandatory training list: who must do it and how often |
| `sms` | the Africa's Talking account (username, sender ID, on/off) |
| `devices` | clocking terminals and BioTime servers (type, model, firmware, address, how staff are matched, schedule) |

## Using it

1. Copy `site.example.json` to `site.json` (in this folder) and fill in what you know.
   Delete a section, or set a value to `null`, to leave it as it is in the system.
   Values marked **TO CONFIRM** in the example are placeholders.
2. Restart the API (`docker compose up -d api`), or press **Apply now** under
   **Administration → Settings**. The result lists every change and any warnings
   (for example accounts still marked `TBD`, or a missing device password).

The file is applied only when it changes, so edits made on screen afterwards are kept until
the next change to the file. A file with mistakes is refused as a whole, with the path of
each problem (e.g. `payroll.pay_day`), and nothing is changed.

## Secrets stay out of the file

Passwords and API keys never go in `site.json`. The SMS API key is `SMS_API_KEY` in `.env`;
each device names the environment variables holding its username and password
(`username_env`, `password_env`), which you add to `.env`. `site.json` itself is not committed
(see `.gitignore`).

Medical limits are dated: new limits start on `medical.effective_from`, and claims made
earlier keep the limits in force at the time.
