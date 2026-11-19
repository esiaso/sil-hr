# PeopleTrack for administrators

* **Administration → Users**: create users, link them to employee records, assign roles with
  a scope (whole organisation, branch, department, direct reports or own), disable accounts,
  reset passwords. **Roles & permissions** edits what each role can do.
* **Approval workflows**: who approves each kind of request, in which order, with escalation
  times and conditions (for example "trips with an advance also need finance"). Changes apply
  to new requests.
* **Settings**: organisation details, time zone and date format, password policy, leave year,
  reminder windows, receipts threshold, SMS on/off, and more. **Numbering** sets document
  number formats. **Login history**, **IP allow-list** and **Audit trail** support security
  reviews.
* **Integrations**: API clients for other systems (scopes, secrets, rate limits), webhooks
  (with delivery logs and replay), device connectors for clocking machines, the event
  catalogue and outbox. See `docs/INTEGRATION.md` for developers.
* Single sign-on, backups, restores and upgrades are covered in `docs/DEPLOYMENT.md`.
