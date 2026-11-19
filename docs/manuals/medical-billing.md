# PeopleTrack for medical scheme billing

**Medical scheme → Billing desk**:
1. Look up the patient by member number, staff number or name. You see the member's cover,
   each limit and what is left, holds and recent usage, never salaries or HR records.
2. **Place a hold** when treatment starts, then **Post claim** with the invoice amount; the
   co-payment and the scheme's share are worked out. A claim over the limit needs approval.
3. **Reverse** a claim posted in error (it is recorded as a reversal, never deleted).

Every lookup is recorded. No diagnosis is stored. The hospital's HMIS can do the same through
the API.
